import type {
  WorkspaceContextPhase,
  WorkspaceContextReceiptBinding,
} from "./workspace-context-protocol.js";

const DEFAULT_BINDING_TTL_MS = 6 * 60 * 60_000;
const DEFAULT_MAX_BINDINGS = 4_096;
const DEFAULT_MAX_BINDINGS_PER_PRINCIPAL = 128;

export interface HostAuthorizationContext {
  principalId: string;
  grantId: string;
  authorizationEpoch: number;
  sessionHash?: string;
}

export interface HostWorkspaceBindingSnapshot {
  binding: WorkspaceContextReceiptBinding;
  phase: WorkspaceContextPhase;
  expiresAt: number;
}

interface StoredHostWorkspaceBinding extends HostWorkspaceBindingSnapshot {
  grantId: string;
  authorizationEpoch: number;
  lastUsedAt: number;
}

export interface HostWorkspaceBindingStoreOptions {
  now?: () => number;
  ttlMs?: number;
  maxBindings?: number;
  maxBindingsPerPrincipal?: number;
}

/**
 * Process-local continuity for hosts that supply an opaque conversation
 * identifier on every tool call. The OAuth grant and authorization epoch are
 * checked on every lookup; a session hint never grants authority by itself.
 */
export class HostWorkspaceBindingStore {
  private readonly entries = new Map<string, StoredHostWorkspaceBinding>();
  private readonly entriesByPrincipal = new Map<string, Map<string, true>>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxBindings: number;
  private readonly maxBindingsPerPrincipal: number;

  constructor(options: HostWorkspaceBindingStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = positiveInteger(options.ttlMs ?? DEFAULT_BINDING_TTL_MS, "ttlMs");
    this.maxBindings = positiveInteger(
      options.maxBindings ?? DEFAULT_MAX_BINDINGS,
      "maxBindings",
    );
    this.maxBindingsPerPrincipal = positiveInteger(
      options.maxBindingsPerPrincipal ?? DEFAULT_MAX_BINDINGS_PER_PRINCIPAL,
      "maxBindingsPerPrincipal",
    );
    if (this.maxBindingsPerPrincipal > this.maxBindings) {
      throw new RangeError("maxBindingsPerPrincipal cannot exceed maxBindings.");
    }
  }

  resolve(context: HostAuthorizationContext): HostWorkspaceBindingSnapshot | undefined {
    const key = bindingKey(context);
    if (!key) return undefined;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const now = this.now();
    if (
      entry.expiresAt <= now ||
      entry.grantId !== context.grantId ||
      entry.authorizationEpoch !== context.authorizationEpoch
    ) {
      this.remove(key);
      return undefined;
    }
    entry.lastUsedAt = now;
    this.touch(key, entry);
    return {
      binding: { ...entry.binding },
      phase: entry.phase,
      expiresAt: entry.expiresAt,
    };
  }

  bind(
    context: HostAuthorizationContext,
    binding: WorkspaceContextReceiptBinding,
  ): HostWorkspaceBindingSnapshot | undefined {
    const key = bindingKey(context);
    if (!key) return undefined;
    if (binding.connectionPrincipalId !== context.principalId) {
      throw new Error("Host Workspace binding belongs to a different principal.");
    }
    const now = this.now();
    this.cleanupExpired(now);
    this.remove(key);
    const entry: StoredHostWorkspaceBinding = {
      binding: { ...binding },
      phase: binding.phase,
      grantId: context.grantId,
      authorizationEpoch: context.authorizationEpoch,
      expiresAt: now + this.ttlMs,
      lastUsedAt: now,
    };
    this.touch(key, entry);
    this.enforceLimits(context.principalId);
    return {
      binding: { ...entry.binding },
      phase: entry.phase,
      expiresAt: entry.expiresAt,
    };
  }

  clearSession(context: HostAuthorizationContext): boolean {
    const key = bindingKey(context);
    if (!key || !this.entries.has(key)) return false;
    this.remove(key);
    return true;
  }

  clearWorkspace(principalId: string, workspaceId: string): number {
    let removed = 0;
    for (const [key, entry] of [...this.entries]) {
      if (
        entry.binding.connectionPrincipalId === principalId &&
        entry.binding.workspaceId === workspaceId
      ) {
        this.remove(key);
        removed += 1;
      }
    }
    return removed;
  }

  invalidatePrincipal(principalId: string): number {
    const keys = [...(this.entriesByPrincipal.get(principalId)?.keys() ?? [])];
    for (const key of keys) this.remove(key);
    return keys.length;
  }

  clearAll(): number {
    const removed = this.entries.size;
    this.entries.clear();
    this.entriesByPrincipal.clear();
    return removed;
  }

  get size(): number {
    return this.entries.size;
  }

  private cleanupExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.remove(key);
    }
  }

  private touch(key: string, entry: StoredHostWorkspaceBinding): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    const principalId = entry.binding.connectionPrincipalId;
    const principalEntries = this.entriesByPrincipal.get(principalId) ?? new Map<string, true>();
    principalEntries.delete(key);
    principalEntries.set(key, true);
    this.entriesByPrincipal.set(principalId, principalEntries);
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    const principalEntries = this.entriesByPrincipal.get(entry.binding.connectionPrincipalId);
    principalEntries?.delete(key);
    if (principalEntries?.size === 0) {
      this.entriesByPrincipal.delete(entry.binding.connectionPrincipalId);
    }
  }

  private enforceLimits(principalId: string): void {
    const principalEntries = this.entriesByPrincipal.get(principalId);
    while ((principalEntries?.size ?? 0) > this.maxBindingsPerPrincipal) {
      const oldest = principalEntries?.keys().next().value as string | undefined;
      if (!oldest) break;
      this.remove(oldest);
    }
    while (this.entries.size > this.maxBindings) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.remove(oldest);
    }
  }
}

function bindingKey(context: HostAuthorizationContext): string | undefined {
  if (!context.sessionHash) return undefined;
  if (!context.principalId || !context.grantId) {
    throw new TypeError("Host authorization context is incomplete.");
  }
  if (!Number.isSafeInteger(context.authorizationEpoch) || context.authorizationEpoch < 1) {
    throw new RangeError("authorizationEpoch must be a positive safe integer.");
  }
  return `${context.principalId}\0${context.sessionHash}`;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}
