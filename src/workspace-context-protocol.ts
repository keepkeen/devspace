import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { WorkspaceMode, WorkspaceWriteAccess } from "./workspace-store.js";

export const WORKSPACE_CONTEXT_SCHEMA_VERSION = 5 as const;
export const WORKSPACE_CONTEXT_TEXT =
  "Workspace context manifest loaded. Load instructions for the intended target paths before mutation or command execution.";
export const WORKSPACE_SELECTED_TEXT =
  "Workspace selected. Load its context manifest before reading, inspecting, or modifying local files.";
export const WORKSPACE_TARGET_SCOPED_TEXT =
  "Target-scoped workspace instructions loaded.";

const RECEIPT_DOMAIN = "devspace-workspace-context-receipt-v5\0";
const RECEIPT_PREFIX = "wctx5.";
const RECEIPT_BYTES = 32;
const RECEIPT_BODY_LENGTH = 43;
const MIN_RECEIPT_KEY_BYTES = 32;
const MAX_RECEIPT_KEY_BYTES = 64;
const MAX_RECEIPT_FIELD_BYTES = 1_024;
const DEFAULT_MAX_RECEIPTS = 4_096;
const MAX_RECEIPTS = 65_536;
const DEFAULT_MAX_RECEIPTS_PER_PRINCIPAL = 128;
const DEFAULT_RECEIPT_TTL_MS = 6 * 60 * 60 * 1_000;
const MAX_RECEIPT_TTL_MS = 24 * 60 * 60 * 1_000;

export interface WorkspaceContextReceiptBinding {
  connectionPrincipalId: string;
  workspaceId: string;
  alias: string;
  projectFingerprint: string;
  contextSessionId: string;
  generation: number;
  instructionRevision: string;
  skillRevision: string;
  phase: WorkspaceContextPhase;
}

export interface WorkspaceContextReceipt {
  receipt: string;
  expiresAt: number;
}

export interface ResolvedWorkspaceContextReceipt {
  binding: WorkspaceContextReceiptBinding;
  expiresAt: number;
}

export type WorkspaceContextPhase = "selected" | "context_loaded" | "target_scoped";

export interface WorkspaceContextReceiptManager {
  issue(binding: WorkspaceContextReceiptBinding): WorkspaceContextReceipt;
  verify(receipt: string, binding: WorkspaceContextReceiptBinding): boolean;
  resolve(receipt: string): ResolvedWorkspaceContextReceipt | undefined;
}

export type WorkspaceContextInstructionSource = "repository" | "user" | "admin" | "bundled";
export type WorkspaceContextInstructionTrust =
  | "repository_untrusted"
  | "user_trusted"
  | "admin_trusted"
  | "bundled_trusted";

interface WorkspaceContextInstructionItemBase {
  scope: string;
  path: string;
  hash: string;
  bytes: number;
}

export type WorkspaceContextInstructionManifestItem = WorkspaceContextInstructionItemBase & (
  | { source: "repository"; trust: "repository_untrusted" }
  | { source: "user"; trust: "user_trusted" }
  | { source: "admin"; trust: "admin_trusted" }
  | { source: "bundled"; trust: "bundled_trusted" }
);

export type WorkspaceContextInstructionItem = WorkspaceContextInstructionManifestItem & {
  content: string;
};

export interface WorkspaceContextSkillItem {
  skillId: string;
  name: string;
  description: string;
  source: WorkspaceContextInstructionSource;
  trust: WorkspaceContextInstructionTrust;
  path?: string;
  scope?: string;
  explicitOnly?: true;
}

export interface WorkspaceContextProtocolInput {
  connectionPrincipalId: string;
  workspaceId: string;
  contextSessionId: string;
  phase: WorkspaceContextPhase;
  workspace: {
    ref: string;
    alias: string;
    projectFingerprint: string;
    generation: number;
    mode: WorkspaceMode;
    writeAccess: WorkspaceWriteAccess;
  };
  instructionManifest: {
    revision: string;
    complete: boolean;
    included: boolean;
    loadedForScope: boolean;
    reviewedRevision?: string;
    files: readonly WorkspaceContextInstructionManifestItem[];
    incompleteReason?: string;
  };
  skills: {
    revision: string;
    count: number;
    included: boolean;
    items: readonly WorkspaceContextSkillItem[];
    warningCount?: number;
  };
}

export interface WorkspaceContextDiagnostics {
  instructions?: { reason: string };
  skills?: { omitted?: number; warnings?: number };
}

export interface WorkspaceContextProtocolResult {
  content: [{
    type: "text";
    text:
      | typeof WORKSPACE_CONTEXT_TEXT
      | typeof WORKSPACE_SELECTED_TEXT
      | typeof WORKSPACE_TARGET_SCOPED_TEXT;
  }];
  structuredContent: {
    schemaVersion: typeof WORKSPACE_CONTEXT_SCHEMA_VERSION;
    state: { phase: WorkspaceContextPhase };
    workspace: WorkspaceContextProtocolInput["workspace"];
    instructionManifest: Pick<
      WorkspaceContextProtocolInput["instructionManifest"],
      | "revision"
      | "complete"
      | "included"
      | "loadedForScope"
      | "reviewedRevision"
      | "files"
    >;
    skills: Pick<WorkspaceContextProtocolInput["skills"], "revision" | "count" | "included" | "items">;
    continuation: {
      receipt: string;
      phase: WorkspaceContextPhase;
      expiresAt: string;
      instructionRevision: string;
      skillRevision: string;
    };
    diagnostics?: WorkspaceContextDiagnostics;
  };
}

export function createWorkspaceContextReceiptManager(options: {
  key?: Uint8Array;
  processGeneration?: string;
  maxReceipts?: number;
  maxReceiptsPerPrincipal?: number;
  ttlMs?: number;
  now?: () => number;
} = {}): WorkspaceContextReceiptManager {
  const key = options.key === undefined ? randomBytes(RECEIPT_BYTES) : validateKey(options.key);
  const processGeneration = options.processGeneration ?? randomBytes(16).toString("base64url");
  const maxReceipts = options.maxReceipts ?? DEFAULT_MAX_RECEIPTS;
  const maxReceiptsPerPrincipal = options.maxReceiptsPerPrincipal ??
    Math.min(DEFAULT_MAX_RECEIPTS_PER_PRINCIPAL, maxReceipts);
  const ttlMs = options.ttlMs ?? DEFAULT_RECEIPT_TTL_MS;
  const now = options.now ?? Date.now;
  assertBoundedString("processGeneration", processGeneration);
  if (!Number.isSafeInteger(maxReceipts) || maxReceipts < 1 || maxReceipts > MAX_RECEIPTS) {
    throw new RangeError(`maxReceipts must be an integer from 1 to ${MAX_RECEIPTS}.`);
  }
  if (
    !Number.isSafeInteger(maxReceiptsPerPrincipal) ||
    maxReceiptsPerPrincipal < 1 ||
    maxReceiptsPerPrincipal > maxReceipts
  ) {
    throw new RangeError("maxReceiptsPerPrincipal must be an integer from 1 to maxReceipts.");
  }
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_RECEIPT_TTL_MS) {
    throw new RangeError(`ttlMs must be an integer from 1 to ${MAX_RECEIPT_TTL_MS}.`);
  }
  const issued = new Map<string, {
    binding: WorkspaceContextReceiptBinding;
    expiresAt: number;
    lastUsedAt: number;
  }>();
  const issuedByPrincipal = new Map<string, Map<string, true>>();

  const removeReceipt = (receipt: string): void => {
    const entry = issued.get(receipt);
    if (!entry) return;
    issued.delete(receipt);
    const principalReceipts = issuedByPrincipal.get(entry.binding.connectionPrincipalId);
    principalReceipts?.delete(receipt);
    if (principalReceipts?.size === 0) {
      issuedByPrincipal.delete(entry.binding.connectionPrincipalId);
    }
  };

  const touchReceipt = (
    receipt: string,
    entry: {
      binding: WorkspaceContextReceiptBinding;
      expiresAt: number;
      lastUsedAt: number;
    },
  ): void => {
    issued.delete(receipt);
    issued.set(receipt, entry);
    const principalId = entry.binding.connectionPrincipalId;
    const principalReceipts = issuedByPrincipal.get(principalId) ?? new Map<string, true>();
    principalReceipts.delete(receipt);
    principalReceipts.set(receipt, true);
    issuedByPrincipal.set(principalId, principalReceipts);
  };

  const enforceLimits = (principalId: string): void => {
    const principalReceipts = issuedByPrincipal.get(principalId);
    while ((principalReceipts?.size ?? 0) > maxReceiptsPerPrincipal) {
      const oldest = principalReceipts?.keys().next().value as string | undefined;
      if (!oldest) break;
      removeReceipt(oldest);
    }
    while (issued.size > maxReceipts) {
      const oldest = issued.keys().next().value as string | undefined;
      if (!oldest) break;
      removeReceipt(oldest);
    }
  };

  const cleanupExpiredReceipts = (currentTime: number): void => {
    for (const [receipt, entry] of issued) {
      if (entry.expiresAt <= currentTime) removeReceipt(receipt);
    }
  };

  const digest = (binding: WorkspaceContextReceiptBinding): Buffer => {
    assertReceiptBinding(binding);
    const hmac = createHmac("sha256", key);
    hmac.update(RECEIPT_DOMAIN, "utf8");
    updateFramed(hmac, processGeneration);
    updateFramed(hmac, binding.connectionPrincipalId);
    updateFramed(hmac, binding.workspaceId);
    updateFramed(hmac, binding.alias);
    updateFramed(hmac, binding.projectFingerprint);
    updateFramed(hmac, binding.contextSessionId);
    updateFramed(hmac, String(binding.generation));
    updateFramed(hmac, binding.instructionRevision);
    updateFramed(hmac, binding.skillRevision);
    updateFramed(hmac, binding.phase);
    return hmac.digest();
  };

  const signatureMatches = (receipt: string, binding: WorkspaceContextReceiptBinding): boolean => {
    try {
      if (typeof receipt !== "string" || receipt.length !== RECEIPT_PREFIX.length + RECEIPT_BODY_LENGTH) {
        return false;
      }
      const body = receipt.startsWith(RECEIPT_PREFIX) ? receipt.slice(RECEIPT_PREFIX.length) : "";
      const encodingValid = /^[A-Za-z0-9_-]{43}$/.test(body);
      const supplied = Buffer.alloc(RECEIPT_BYTES);
      if (encodingValid) Buffer.from(body, "base64url").copy(supplied);
      const matches = timingSafeEqual(digest(binding), supplied);
      return encodingValid && matches;
    } catch {
      return false;
    }
  };

  return {
    issue(binding) {
      const receipt = `${RECEIPT_PREFIX}${digest(binding).toString("base64url")}`;
      const issuedAt = now();
      cleanupExpiredReceipts(issuedAt);
      removeReceipt(receipt);
      const entry = {
        binding: { ...binding },
        expiresAt: issuedAt + ttlMs,
        lastUsedAt: issuedAt,
      };
      touchReceipt(receipt, entry);
      enforceLimits(binding.connectionPrincipalId);
      return { receipt, expiresAt: entry.expiresAt };
    },
    verify(receipt, binding) {
      const entry = issued.get(receipt);
      if (!entry || entry.expiresAt <= now()) {
        if (entry) removeReceipt(receipt);
        return false;
      }
      return signatureMatches(receipt, binding);
    },
    resolve(receipt) {
      const entry = issued.get(receipt);
      if (!entry || entry.expiresAt <= now()) {
        if (entry) removeReceipt(receipt);
        return undefined;
      }
      if (!signatureMatches(receipt, entry.binding)) return undefined;
      entry.lastUsedAt = now();
      touchReceipt(receipt, entry);
      return { binding: { ...entry.binding }, expiresAt: entry.expiresAt };
    },
  };
}

export function serializeWorkspaceContext(
  input: WorkspaceContextProtocolInput,
  receipts: WorkspaceContextReceiptManager,
): WorkspaceContextProtocolResult {
  if (input.workspace.ref !== input.workspaceId) {
    throw new Error("workspace.ref must match workspaceId.");
  }
  assertContextPhase(input.phase);
  assertBoundedString("contextSessionId", input.contextSessionId);
  assertPositiveSafeInteger("workspace.generation", input.workspace.generation);
  assertNonNegativeSafeInteger("skills.count", input.skills.count);
  assertNonNegativeSafeInteger("skills.warningCount", input.skills.warningCount ?? 0);
  if (input.skills.count < input.skills.items.length) {
    throw new Error("skills.count cannot be smaller than skills.items.length.");
  }
  if (input.instructionManifest.incompleteReason !== undefined) {
    assertBoundedString(
      "instructionManifest.incompleteReason",
      input.instructionManifest.incompleteReason,
    );
  }
  if (
    input.phase === "selected" &&
    (input.instructionManifest.included || input.instructionManifest.files.length > 0 ||
      input.skills.included || input.skills.items.length > 0)
  ) {
    throw new Error("selected context cannot include instruction manifests or Skills.");
  }
  if (
    input.phase === "selected" &&
    (input.instructionManifest.loadedForScope ||
      input.instructionManifest.reviewedRevision !== undefined)
  ) {
    throw new Error("selected context cannot mark scoped instructions as loaded.");
  }

  const omitted = input.skills.count - input.skills.items.length;
  const warningCount = input.skills.warningCount ?? 0;
  const diagnostics: WorkspaceContextDiagnostics = {
    ...(!input.instructionManifest.complete
      ? {
          instructions: {
            reason: input.instructionManifest.incompleteReason ?? "unknown",
          },
        }
      : {}),
    ...(omitted > 0 || warningCount > 0
      ? {
          skills: {
            ...(omitted > 0 ? { omitted } : {}),
            ...(warningCount > 0 ? { warnings: warningCount } : {}),
          },
        }
      : {}),
  };
  const issuedReceipt = receipts.issue({
    connectionPrincipalId: input.connectionPrincipalId,
    workspaceId: input.workspaceId,
    alias: input.workspace.alias,
    projectFingerprint: input.workspace.projectFingerprint,
    contextSessionId: input.contextSessionId,
    generation: input.workspace.generation,
    instructionRevision: input.instructionManifest.revision,
    skillRevision: input.skills.revision,
    phase: input.phase,
  });

  return {
    content: [{
      type: "text",
      text: input.phase === "selected"
        ? WORKSPACE_SELECTED_TEXT
        : input.phase === "target_scoped"
          ? WORKSPACE_TARGET_SCOPED_TEXT
          : WORKSPACE_CONTEXT_TEXT,
    }],
    structuredContent: {
      schemaVersion: WORKSPACE_CONTEXT_SCHEMA_VERSION,
      state: { phase: input.phase },
      workspace: input.workspace,
      instructionManifest: {
        revision: input.instructionManifest.revision,
        complete: input.instructionManifest.complete,
        included: input.instructionManifest.included,
        loadedForScope: input.instructionManifest.loadedForScope,
        ...(input.instructionManifest.reviewedRevision
          ? { reviewedRevision: input.instructionManifest.reviewedRevision }
          : {}),
        files: input.instructionManifest.files,
      },
      skills: {
        revision: input.skills.revision,
        count: input.skills.count,
        included: input.skills.included,
        items: input.skills.items,
      },
      continuation: {
        receipt: issuedReceipt.receipt,
        phase: input.phase,
        expiresAt: new Date(issuedReceipt.expiresAt).toISOString(),
        instructionRevision: input.instructionManifest.revision,
        skillRevision: input.skills.revision,
      },
      ...(Object.keys(diagnostics).length > 0 ? { diagnostics } : {}),
    },
  };
}

function validateKey(key: Uint8Array): Buffer {
  if (!(key instanceof Uint8Array)) throw new TypeError("Receipt key must be a Uint8Array.");
  if (key.byteLength < MIN_RECEIPT_KEY_BYTES || key.byteLength > MAX_RECEIPT_KEY_BYTES) {
    throw new RangeError(
      `Receipt key must be ${MIN_RECEIPT_KEY_BYTES}-${MAX_RECEIPT_KEY_BYTES} bytes.`,
    );
  }
  return Buffer.from(key);
}

function assertReceiptBinding(binding: WorkspaceContextReceiptBinding): void {
  assertBoundedString("connectionPrincipalId", binding.connectionPrincipalId);
  assertBoundedString("workspaceId", binding.workspaceId);
  assertBoundedString("alias", binding.alias);
  assertBoundedString("projectFingerprint", binding.projectFingerprint);
  assertBoundedString("contextSessionId", binding.contextSessionId);
  assertPositiveSafeInteger("generation", binding.generation);
  assertBoundedString("instructionRevision", binding.instructionRevision);
  assertBoundedString("skillRevision", binding.skillRevision);
  assertContextPhase(binding.phase);
}

function assertContextPhase(value: WorkspaceContextPhase): void {
  if (
    value !== "selected" &&
    value !== "context_loaded" &&
    value !== "target_scoped"
  ) {
    throw new TypeError("phase must be selected, context_loaded, or target_scoped.");
  }
}

function assertBoundedString(name: string, value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_RECEIPT_FIELD_BYTES) {
    throw new RangeError(`${name} exceeds ${MAX_RECEIPT_FIELD_BYTES} UTF-8 bytes.`);
  }
}

function assertPositiveSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}

function assertNonNegativeSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
}

function updateFramed(hmac: ReturnType<typeof createHmac>, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  hmac.update(`${bytes.byteLength}:`, "utf8");
  hmac.update(bytes);
}
