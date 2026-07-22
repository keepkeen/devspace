import express, { Router } from "express";
import { validInternalDiagnosticsToken, validInternalRevocationToken } from "./internal-auth.js";
import type { RuntimeDiagnostics } from "./runtime-diagnostics.js";
import { DEVSPACE_VERSION } from "./version.js";

interface McpUsage {
  sessions: number;
  reservations: number;
  limit: number;
}

interface ProcessUsage {
  sessions: number;
  running: number;
  limit: number;
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
  accessTokens: number;
  refreshTokens: number;
  expiredAccessTokens: number;
  expiredRefreshTokens: number;
}

interface RevocationCounts {
  clients: number;
  accessTokens: number;
  refreshTokens: number;
}

export interface RuntimeControlPlaneOptions {
  ownerToken: string;
  generation: string;
  isClosing(): boolean;
  workspaceDatabaseReady(): boolean;
  oauthDatabaseReady(): boolean;
  mcpUsage(): McpUsage;
  processUsage(): ProcessUsage;
  workspaceUsage(): WorkspaceUsage;
  oauthUsage(): OAuthUsage;
  revokeAll(): RevocationCounts;
  runtimeDiagnostics: RuntimeDiagnostics;
  onGlobalRevocation(counts: RevocationCounts): void;
}

export function createRuntimeControlPlane(options: RuntimeControlPlaneOptions): Router {
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

  router.get("/internal/diagnostics", (req, res) => {
    if (!validInternalDiagnosticsToken(options.ownerToken, req.header("x-devspace-internal-token"))) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const mcpUsage = options.mcpUsage();
    const processUsage = options.processUsage();
    const workspaceUsage = options.workspaceUsage();
    const oauthUsage = options.oauthUsage();
    res.setHeader("Cache-Control", "no-store");
    res.json({
      generatedAt: new Date().toISOString(),
      version: DEVSPACE_VERSION,
      generation: options.generation,
      uptimeSeconds: Math.floor(process.uptime()),
      usage: {
        mcpSessions: {
          active: mcpUsage.sessions,
          reserved: mcpUsage.reservations,
          limit: finiteLimit(mcpUsage.limit),
        },
        processSessions: {
          active: processUsage.sessions,
          running: processUsage.running,
          limit: finiteLimit(processUsage.limit),
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
          accessTokens: oauthUsage.accessTokens,
          refreshTokens: oauthUsage.refreshTokens,
          expiredRecords: oauthUsage.expiredAccessTokens + oauthUsage.expiredRefreshTokens,
        },
      },
      recentFailures: options.runtimeDiagnostics.snapshot(),
    });
  });

  router.post("/internal/security/revoke", express.json({ limit: "1kb" }), (req, res) => {
    if (!validInternalRevocationToken(options.ownerToken, req.header("x-devspace-internal-token"))) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (req.body?.scope !== "all_clients_and_tokens") {
      res.status(400).json({ error: "invalid_scope" });
      return;
    }
    const revoked = options.revokeAll();
    res.setHeader("Cache-Control", "no-store");
    options.onGlobalRevocation(revoked);
    res.json({ ok: true, revoked });
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
