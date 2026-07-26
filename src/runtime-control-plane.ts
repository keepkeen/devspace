import express, { Router } from "express";
import {
  validInternalConfigReloadToken,
  validInternalDiagnosticsToken,
  validInternalRevocationToken,
} from "./internal-auth.js";
import type { RuntimeDiagnostics } from "./runtime-diagnostics.js";
import type { McpSessionUsageSnapshot } from "./mcp-sessions.js";
import { DEVSPACE_VERSION } from "./version.js";
import type { AuditWriteHealth } from "./logger.js";

interface ProcessUsage {
  sessions: number;
  running: number;
  limit: number;
}

interface ProcessOutputUsage {
  outputs: number;
  activeOutputs: number;
  storedBytes: number;
  droppedBytes: number;
  maxStorageBytes: number;
}

interface WorkspaceUsage {
  activePersisted: number;
  resident: number;
  closing: number;
  leased: number;
  maxResident: number;
}

interface OAuthUsage {
  clients: number;
  principals: number;
  accessTokens: number;
  refreshTokens: number;
  workspaceCleanupJobs: number;
  expiredAccessTokens: number;
  expiredRefreshTokens: number;
  legacyWildcardGrants: number;
}

interface RevocationCounts {
  clients: number;
  accessTokens: number;
  refreshTokens: number;
  workspaceCleanupJobs: number;
}

interface AllowedRootsReloadResult {
  changed: boolean;
  added: number;
  removed: number;
  invalidatedWorkspaces: number;
  terminatedProcesses: number;
  cleanupFailures: number;
  cleanupPending: number;
}

export interface RuntimeControlPlaneOptions {
  internalAuth: {
    diagnostics: string | Uint8Array;
    configReload: string | Uint8Array;
    revocation: string | Uint8Array;
  };
  generation: string;
  runtimeConfig: {
    widgets: "full" | "changes" | "off";
  };
  allowedRootsRevision(): string;
  allowedRootsCleanupPending(): number;
  isClosing(): boolean;
  workspaceDatabaseReady(): boolean;
  oauthDatabaseReady(): boolean;
  mcpUsage(): McpSessionUsageSnapshot;
  processUsage(): ProcessUsage;
  processOutputUsage(): ProcessOutputUsage;
  workspaceUsage(): WorkspaceUsage;
  oauthUsage(): OAuthUsage;
  auditWriteHealth(): Readonly<AuditWriteHealth>;
  reloadAllowedRoots(): Promise<AllowedRootsReloadResult>;
  beforeGlobalRevocation(): void | Promise<void>;
  revokeAll(): RevocationCounts;
  runtimeDiagnostics: RuntimeDiagnostics;
  onGlobalRevocation(counts: RevocationCounts): void | Promise<void>;
}

export type RuntimeReadinessOptions = Pick<
  RuntimeControlPlaneOptions,
  "generation" | "isClosing" | "workspaceDatabaseReady" | "oauthDatabaseReady"
>;

/** Public liveness/readiness endpoints. This router never exposes control actions. */
export function createRuntimeReadinessPlane(options: RuntimeReadinessOptions): Router {
  const router = Router();
  router.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: "devspace", status: "alive" });
  });
  router.get("/readyz", (_req, res) => {
    const snapshot = readinessSnapshot({
      closing: options.isClosing(),
      workspaceDatabaseReady: options.workspaceDatabaseReady(),
      oauthDatabaseReady: options.oauthDatabaseReady(),
      generation: options.generation,
    });
    res.status(snapshot.statusCode).json(snapshot.body);
  });
  return router;
}

export function createRuntimeControlPlane(options: RuntimeControlPlaneOptions): Router {
  const router = Router();

  router.get("/internal/diagnostics", (req, res) => {
    if (!validInternalDiagnosticsToken(
      options.internalAuth.diagnostics,
      req.header("x-devspace-internal-token"),
    )) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const mcpUsage = options.mcpUsage();
    const processUsage = options.processUsage();
    const processOutputUsage = options.processOutputUsage();
    const workspaceUsage = options.workspaceUsage();
    const oauthUsage = options.oauthUsage();
    res.setHeader("Cache-Control", "no-store");
    res.json({
      generatedAt: new Date().toISOString(),
      version: DEVSPACE_VERSION,
      generation: options.generation,
      runtimeConfig: {
        ...options.runtimeConfig,
        allowedRootsRevision: options.allowedRootsRevision(),
        allowedRootsCleanupPending: options.allowedRootsCleanupPending(),
      },
      uptimeSeconds: Math.floor(process.uptime()),
      usage: {
        mcpSessions: {
          active: mcpUsage.sessions + mcpUsage.statelessRequests,
          stateful: mcpUsage.sessions,
          statelessRequests: mcpUsage.statelessRequests,
          reserved: mcpUsage.reservations,
          limit: finiteLimit(mcpUsage.limit),
          statelessLeases: mcpUsage.statelessLeases,
        },
        processSessions: {
          active: processUsage.sessions,
          running: processUsage.running,
          limit: finiteLimit(processUsage.limit),
        },
        processOutput: {
          active: processOutputUsage.storedBytes,
          used: processOutputUsage.storedBytes,
          limit: processOutputUsage.maxStorageBytes,
          outputs: processOutputUsage.outputs,
          activeOutputs: processOutputUsage.activeOutputs,
          droppedBytes: processOutputUsage.droppedBytes,
        },
        workspaces: {
          active: workspaceUsage.activePersisted,
          resident: workspaceUsage.resident,
          closing: workspaceUsage.closing,
          leased: workspaceUsage.leased,
          limit: workspaceUsage.maxResident,
        },
        oauth: {
          clients: oauthUsage.clients,
          principals: oauthUsage.principals,
          accessTokens: oauthUsage.accessTokens,
          refreshTokens: oauthUsage.refreshTokens,
          workspaceCleanupJobs: oauthUsage.workspaceCleanupJobs,
          expiredRecords: oauthUsage.expiredAccessTokens + oauthUsage.expiredRefreshTokens,
          legacyWildcardGrants: oauthUsage.legacyWildcardGrants,
        },
      },
      observability: {
        audit: options.auditWriteHealth(),
      },
      recentFailures: options.runtimeDiagnostics.snapshot(),
    });
  });

  router.post("/internal/security/revoke", express.json({ limit: "1kb" }), async (req, res) => {
    if (!validInternalRevocationToken(
      options.internalAuth.revocation,
      req.header("x-devspace-internal-token"),
    )) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (req.body?.scope !== "all_clients_and_tokens") {
      res.status(400).json({ error: "invalid_scope" });
      return;
    }
    await options.beforeGlobalRevocation();
    const revoked = options.revokeAll();
    res.setHeader("Cache-Control", "no-store");
    await options.onGlobalRevocation(revoked);
    res.json({ ok: true, revoked });
  });

  router.post("/internal/config/reload-roots", async (req, res) => {
    if (!validInternalConfigReloadToken(
      options.internalAuth.configReload,
      req.header("x-devspace-internal-token"),
    )) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    try {
      const reload = await options.reloadAllowedRoots();
      res.setHeader("Cache-Control", "no-store");
      if (reload.cleanupPending > 0) {
        res.status(409).json({ error: "allowed_roots_cleanup_incomplete", reload });
        return;
      }
      res.json({ ok: true, reload });
    } catch {
      res.status(500).json({ error: "allowed_roots_reload_failed" });
    }
  });

  return router;
}

export function readinessSnapshot(input: {
  closing: boolean;
  workspaceDatabaseReady: boolean;
  oauthDatabaseReady: boolean;
  generation?: string;
}) {
  const checks = {
    lifecycle: !input.closing,
    workspaceDatabase: input.workspaceDatabaseReady,
    oauthDatabase: input.oauthDatabaseReady,
  };
  const ready = Object.values(checks).every(Boolean);
  return {
    statusCode: ready ? 200 : 503,
    body: {
      ok: ready,
      name: "devspace",
      status: ready ? "ready" : "not_ready",
      ...(input.generation ? { generation: input.generation } : {}),
      checks,
    },
  };
}

function finiteLimit(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}
