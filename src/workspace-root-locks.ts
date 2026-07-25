export type WorkspaceRootLockMode = "read" | "write";

import {
  CrossProcessWorkspaceRootLock,
  type CrossProcessWorkspaceRootLockOptions,
  type WorkspaceRootLease,
  type WorkspaceRootLeaseMetadata,
  type WorkspaceRootProcessOwner,
} from "./cross-process-root-lock.js";

export {
  WorkspaceRootLockTimeoutError,
  defaultWorkspaceRootLockDirectory,
} from "./cross-process-root-lock.js";
export type {
  WorkspaceRootLease,
  WorkspaceRootLeaseMetadata,
  WorkspaceRootProcessOwner,
} from "./cross-process-root-lock.js";

interface LockWaiter {
  mode: WorkspaceRootLockMode;
  resolve(release: () => void): void;
}

interface RootLockState {
  readers: number;
  writer: boolean;
  queue: LockWaiter[];
}

/**
 * Fair process-local read/write locks keyed by canonical workspace root.
 * Readers share the lock until a writer queues; later readers wait behind that
 * writer so a steady stream of inspection calls cannot starve mutations.
 */
export class WorkspaceRootLockManager {
  private readonly states = new Map<string, RootLockState>();
  private readonly crossProcess?: CrossProcessWorkspaceRootLock;

  constructor(options: {
    crossProcessLockRoot?: string;
    acquireTimeoutMs?: number;
    pollIntervalMs?: number;
  } = {}) {
    if (options.crossProcessLockRoot) {
      const crossProcessOptions: CrossProcessWorkspaceRootLockOptions = {
        root: options.crossProcessLockRoot,
        ...(options.acquireTimeoutMs === undefined
          ? {}
          : { acquireTimeoutMs: options.acquireTimeoutMs }),
        ...(options.pollIntervalMs === undefined
          ? {}
          : { pollIntervalMs: options.pollIntervalMs }),
      };
      this.crossProcess = new CrossProcessWorkspaceRootLock(crossProcessOptions);
    }
  }

  async withLock<T>(
    key: string,
    mode: WorkspaceRootLockMode,
    callback: () => T | Promise<T>,
    metadata: WorkspaceRootLeaseMetadata = {},
  ): Promise<T> {
    const release = await this.acquire(key, mode, metadata);
    try {
      return await callback();
    } finally {
      release();
    }
  }

  async acquire(
    key: string,
    mode: WorkspaceRootLockMode,
    metadata: WorkspaceRootLeaseMetadata = {},
  ): Promise<WorkspaceRootLease> {
    if (!key) return Promise.reject(new TypeError("Workspace root lock key is required."));
    if (mode !== "read" && mode !== "write") {
      return Promise.reject(new TypeError("Workspace root lock mode must be read or write."));
    }
    const releaseLocal = await this.acquireLocal(key, mode);
    let crossProcessLease: WorkspaceRootLease | undefined;
    try {
      crossProcessLease = await this.crossProcess?.acquire(key, mode, metadata);
    } catch (error) {
      releaseLocal();
      throw error;
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      crossProcessLease?.release();
      releaseLocal();
    };
    const lease = (() => release()) as WorkspaceRootLease;
    lease.release = release;
    lease.heartbeat = async () => {
      await crossProcessLease?.heartbeat();
    };
    lease.attachProcess = async (owner: WorkspaceRootProcessOwner) => {
      await crossProcessLease?.attachProcess(owner);
    };
    return lease;
  }

  private acquireLocal(key: string, mode: WorkspaceRootLockMode): Promise<() => void> {
    const state = this.states.get(key) ?? { readers: 0, writer: false, queue: [] };
    this.states.set(key, state);
    return new Promise((resolve) => {
      state.queue.push({ mode, resolve });
      this.drain(key, state);
    });
  }

  private drain(key: string, state: RootLockState): void {
    if (state.writer) return;
    if (state.readers > 0 && state.queue[0]?.mode === "write") return;

    if (state.readers === 0 && state.queue[0]?.mode === "write") {
      const waiter = state.queue.shift()!;
      state.writer = true;
      waiter.resolve(this.releaseOnce(key, state, "write"));
      return;
    }

    while (state.queue[0]?.mode === "read" && !state.writer) {
      const waiter = state.queue.shift()!;
      state.readers += 1;
      waiter.resolve(this.releaseOnce(key, state, "read"));
    }
  }

  private releaseOnce(
    key: string,
    state: RootLockState,
    mode: WorkspaceRootLockMode,
  ): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (mode === "write") state.writer = false;
      else state.readers -= 1;
      if (state.readers < 0) throw new Error("Workspace root lock reader count underflow.");
      if (!state.writer && state.readers === 0 && state.queue.length === 0) {
        if (this.states.get(key) === state) this.states.delete(key);
        return;
      }
      this.drain(key, state);
    };
  }
}
