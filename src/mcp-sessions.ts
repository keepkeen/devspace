export interface ClosableMcpTransport {
  close(): Promise<void>;
}

export interface McpSessionCloseResult {
  sessionId: string;
  error?: unknown;
}

export interface McpSessionReservationResult {
  reservation?: McpSessionReservation;
  reclaimed?: McpSessionCloseResult;
}

export interface McpSessionOwner {
  readonly principalId: string;
  readonly grantId: string;
  readonly authorizationEpoch: number;
}

export interface McpSessionReservation {
  readonly id: symbol;
  readonly reclaimsSessionId?: string;
  readonly owner: McpSessionOwner;
}

export interface StatelessMcpRequestLease {
  readonly id: symbol;
  readonly owner: McpSessionOwner;
  readonly acquiredAt: number;
}

export interface StatelessMcpRequestLeaseUsage {
  agesMs: number[];
}

interface McpSessionEntry<TTransport> {
  transport: TTransport;
  owner: McpSessionOwner;
  lastActivityAt: number;
  activeRequests: number;
  closing: boolean;
  closePromise?: Promise<McpSessionCloseResult>;
  activeRequestDrain?: {
    promise: Promise<void>;
    resolve: () => void;
  };
}

interface McpSessionCloseAttempt {
  underlying: Promise<void>;
  owner: McpSessionOwner;
}

export interface McpSessionRegistryOptions {
  now?: () => number;
  maxSessions?: number;
  closeTimeoutMs?: number;
}

export interface McpSessionUsageSnapshot {
  sessions: number;
  reservations: number;
  statelessRequests: number;
  statelessLeases: StatelessMcpRequestLeaseUsage;
  limit: number;
}

export class McpSessionRegistry<TTransport extends ClosableMcpTransport> {
  private readonly sessions = new Map<string, McpSessionEntry<TTransport>>();
  private readonly inFlightClosings = new Map<string, McpSessionCloseAttempt>();
  private readonly revokedAuthorizations = new Set<string>();
  private readonly statelessAuthorizationDrains = new Map<string, {
    promise: Promise<void>;
    resolve: () => void;
  }>();
  private readonly now: () => number;
  private readonly maxSessions: number;
  private readonly reservations = new Set<McpSessionReservation>();
  private readonly statelessRequests = new Set<StatelessMcpRequestLease>();
  private readonly closeTimeoutMs: number;
  private sealed = false;

  constructor(options: McpSessionRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxSessions = options.maxSessions ?? Number.POSITIVE_INFINITY;
    this.closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
  }

  get size(): number {
    let size = this.sessions.size;
    for (const sessionId of this.inFlightClosings.keys()) {
      if (!this.sessions.has(sessionId)) size += 1;
    }
    return size;
  }

  tryReserve(owner: McpSessionOwner): McpSessionReservation | undefined {
    if (
      this.sealed ||
      this.revokedAuthorizations.has(authorizationKey(owner)) ||
      this.occupiedSlots() >= this.maxSessions
    ) {
      return undefined;
    }
    const reservation = { id: Symbol("mcp-session-reservation"), owner: copyOwner(owner) };
    this.reservations.add(reservation);
    return reservation;
  }

  tryAcquireStatelessRequest(
    owner: McpSessionOwner,
  ): StatelessMcpRequestLease | undefined {
    if (
      this.sealed ||
      this.revokedAuthorizations.has(authorizationKey(owner)) ||
      this.occupiedSlots() >= this.maxSessions
    ) {
      return undefined;
    }
    const lease = {
      id: Symbol("stateless-mcp-request"),
      owner: copyOwner(owner),
      acquiredAt: this.now(),
    };
    this.statelessRequests.add(lease);
    return lease;
  }

  releaseStatelessRequest(lease: StatelessMcpRequestLease): boolean {
    const released = this.statelessRequests.delete(lease);
    if (released) this.resolveStatelessAuthorizationDrain(lease.owner);
    return released;
  }

  async reserveWithIdleReclaim(owner: McpSessionOwner): Promise<McpSessionReservationResult> {
    const available = this.tryReserve(owner);
    if (available) return { reservation: available };
    if (this.sealed || this.revokedAuthorizations.has(authorizationKey(owner))) return {};

    const candidate = this.oldestInactiveSession();
    if (!candidate) return {};

    const reservation = {
      id: Symbol("mcp-session-reclaim-reservation"),
      reclaimsSessionId: candidate.sessionId,
      owner: copyOwner(owner),
    };
    this.reservations.add(reservation);
    const reclaimed = await this.beginClosing(candidate.sessionId, candidate.entry).promise;
    if (reclaimed.error || this.sealed || !this.reservations.has(reservation)) {
      this.reservations.delete(reservation);
      return { reclaimed };
    }
    return { reservation, reclaimed };
  }

  releaseReservation(reservation: McpSessionReservation): void {
    this.reservations.delete(reservation);
  }

  seal(): void {
    this.sealed = true;
    this.reservations.clear();
  }

  register(
    sessionId: string,
    owner: McpSessionOwner,
    transport: TTransport,
    reservation?: McpSessionReservation,
    activeRequests = 0,
  ): void {
    if (this.sealed) throw new Error("The MCP session registry is closed.");
    if (this.revokedAuthorizations.has(authorizationKey(owner))) {
      throw new Error("The MCP session authorization has been revoked.");
    }
    if (reservation && !this.reservations.has(reservation)) {
      throw new Error("The MCP session reservation is no longer valid.");
    }
    if (this.sessions.has(sessionId)) {
      throw new Error(`Duplicate MCP session: ${sessionId}`);
    }
    if (reservation && !sameOwner(reservation.owner, owner)) {
      throw new Error("The MCP session reservation belongs to a different authorization.");
    }
    if (this.occupiedSlots(reservation) >= this.maxSessions) {
      throw new Error(`MCP session limit reached (${this.maxSessions}).`);
    }
    if (reservation) this.reservations.delete(reservation);
    this.sessions.set(sessionId, {
      transport,
      owner: copyOwner(owner),
      lastActivityAt: this.now(),
      activeRequests,
      closing: false,
    });
  }

  get(sessionId: string, owner: McpSessionOwner): TTransport | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.closing || !sameOwner(entry.owner, owner)) return undefined;

    entry.lastActivityAt = this.now();
    return entry.transport;
  }

  acquire(sessionId: string, owner: McpSessionOwner): TTransport | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.closing || !sameOwner(entry.owner, owner)) return undefined;
    entry.lastActivityAt = this.now();
    entry.activeRequests += 1;
    return entry.transport;
  }

  release(sessionId: string, owner: McpSessionOwner): void {
    const entry = this.sessions.get(sessionId);
    if (!entry || !sameOwner(entry.owner, owner)) return;
    entry.activeRequests = Math.max(0, entry.activeRequests - 1);
    entry.lastActivityAt = this.now();
    if (entry.activeRequests === 0) this.resolveActiveRequestDrain(entry);
  }

  remove(sessionId: string, owner: McpSessionOwner): boolean {
    const entry = this.sessions.get(sessionId);
    return entry !== undefined && sameOwner(entry.owner, owner) && this.sessions.delete(sessionId);
  }

  removeOnTransportClose(
    sessionId: string,
    owner: McpSessionOwner,
  ): "intentional" | "unexpected" | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry || !sameOwner(entry.owner, owner)) return undefined;
    this.sessions.delete(sessionId);
    this.resolveActiveRequestDrain(entry);
    return entry.closing ? "intentional" : "unexpected";
  }

  async closeIdle(idleTimeoutMs: number): Promise<McpSessionCloseResult[]> {
    const cutoff = this.now() - idleTimeoutMs;
    const idleClosings: Array<Promise<McpSessionCloseResult>> = [];

    for (const [sessionId, entry] of this.sessions) {
      if (
        entry.closePromise ||
        entry.activeRequests > 0 ||
        (!entry.closing && entry.lastActivityAt > cutoff)
      ) {
        continue;
      }
      const closing = this.beginClosing(sessionId, entry);
      if (closing.initiated) idleClosings.push(closing.promise);
    }

    return Promise.all(idleClosings);
  }

  async closeAll(): Promise<McpSessionCloseResult[]> {
    this.seal();
    return this.closeActive();
  }

  /**
   * Quarantines sessions for one revoked authorization tuple, waits for their
   * admitted requests to drain, and closes them. Other grants on the same
   * principal remain active. Capacity is released only after close succeeds or
   * the transport reports that it closed.
   */
  async closeAuthorizationSessions(
    owner: McpSessionOwner,
  ): Promise<McpSessionCloseResult[]> {
    this.revokedAuthorizations.add(authorizationKey(owner));
    for (const reservation of [...this.reservations]) {
      if (sameOwner(reservation.owner, owner)) this.reservations.delete(reservation);
    }
    const closings: Array<Promise<McpSessionCloseResult>> = [];
    for (const [sessionId, entry] of this.sessions) {
      if (!sameOwner(entry.owner, owner)) continue;
      closings.push(this.beginClosing(sessionId, entry, true).promise);
    }
    const [closeResults] = await Promise.all([
      Promise.all(closings),
      this.waitForStatelessAuthorizationDrain(owner),
    ]);
    return closeResults;
  }

  async closeActive(): Promise<McpSessionCloseResult[]> {
    this.reservations.clear();
    const allClosings = new Map<string, Promise<McpSessionCloseResult>>();
    for (const [sessionId, entry] of this.sessions) {
      const closing = this.beginClosing(sessionId, entry);
      allClosings.set(sessionId, closing.promise);
    }
    for (const [sessionId, closing] of this.inFlightClosings) {
      if (!allClosings.has(sessionId)) {
        allClosings.set(
          sessionId,
          closeSession(sessionId, closing.underlying, this.closeTimeoutMs),
        );
      }
    }
    return Promise.all(allClosings.values());
  }

  usageSnapshot(): McpSessionUsageSnapshot {
    return {
      sessions: this.size,
      reservations: this.reservations.size,
      statelessRequests: this.statelessRequests.size,
      statelessLeases: this.statelessLeaseUsage(),
      limit: this.maxSessions,
    };
  }

  private statelessLeaseUsage(): StatelessMcpRequestLeaseUsage {
    const now = this.now();
    const agesMs: number[] = [];

    for (const lease of this.statelessRequests) {
      const ageMs = Math.max(0, now - lease.acquiredAt);
      agesMs.push(ageMs);
    }

    agesMs.sort((left, right) => right - left);
    return { agesMs };
  }

  private beginClosing(
    sessionId: string,
    entry: McpSessionEntry<TTransport>,
    drainActiveRequests = false,
  ): { promise: Promise<McpSessionCloseResult>; initiated: boolean } {
    if (entry.closePromise) return { promise: entry.closePromise, initiated: false };

    const existingClose = this.inFlightClosings.get(sessionId);
    if (existingClose) {
      return {
        promise: closeSession(sessionId, existingClose.underlying, this.closeTimeoutMs),
        initiated: false,
      };
    }

    entry.closing = true;
    const underlyingClose = Promise.resolve().then(async () => {
      if (drainActiveRequests && entry.activeRequests > 0) {
        await this.waitForActiveRequests(entry);
      }
      if (this.sessions.get(sessionId) !== entry) return;
      await entry.transport.close();
    });
    const promise = closeSession(sessionId, underlyingClose, this.closeTimeoutMs);
    entry.closePromise = promise;
    const attempt = { underlying: underlyingClose, owner: entry.owner };
    this.inFlightClosings.set(sessionId, attempt);

    void underlyingClose.then(
      () => {
        if (this.sessions.get(sessionId) === entry) this.sessions.delete(sessionId);
        if (this.inFlightClosings.get(sessionId) === attempt) {
          this.inFlightClosings.delete(sessionId);
        }
      },
      () => {
        if (this.inFlightClosings.get(sessionId) === attempt) {
          this.inFlightClosings.delete(sessionId);
        }
      },
    );
    void promise.then((result) => {
      if (!result.error && this.sessions.get(sessionId) === entry) {
        this.sessions.delete(sessionId);
      }
      if (entry.closePromise === promise) entry.closePromise = undefined;
    });
    return { promise, initiated: true };
  }

  private oldestInactiveSession(): {
    sessionId: string;
    entry: McpSessionEntry<TTransport>;
  } | undefined {
    let oldest: {
      sessionId: string;
      entry: McpSessionEntry<TTransport>;
    } | undefined;

    for (const [sessionId, entry] of this.sessions) {
      if (
        entry.closePromise ||
        this.inFlightClosings.has(sessionId) ||
        entry.activeRequests > 0
      ) {
        continue;
      }
      if (!oldest || entry.lastActivityAt < oldest.entry.lastActivityAt) {
        oldest = { sessionId, entry };
      }
    }

    return oldest;
  }

  private occupiedSlots(excludedReservation?: McpSessionReservation): number {
    let occupied = this.size + this.statelessRequests.size;
    for (const reservation of this.reservations) {
      if (reservation === excludedReservation) continue;
      if (
        reservation.reclaimsSessionId &&
        (this.sessions.has(reservation.reclaimsSessionId) ||
          this.inFlightClosings.has(reservation.reclaimsSessionId))
      ) {
        continue;
      }
      occupied += 1;
    }
    return occupied;
  }

  private waitForActiveRequests(entry: McpSessionEntry<TTransport>): Promise<void> {
    if (entry.activeRequests === 0) return Promise.resolve();
    if (entry.activeRequestDrain) return entry.activeRequestDrain.promise;
    let resolveDrain!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveDrain = resolve;
    });
    entry.activeRequestDrain = { promise, resolve: resolveDrain };
    return promise;
  }

  private resolveActiveRequestDrain(entry: McpSessionEntry<TTransport>): void {
    const drain = entry.activeRequestDrain;
    if (!drain) return;
    entry.activeRequestDrain = undefined;
    drain.resolve();
  }

  private waitForStatelessAuthorizationDrain(owner: McpSessionOwner): Promise<void> {
    if (this.exactStatelessRequestCount(owner) === 0) return Promise.resolve();
    const key = authorizationKey(owner);
    const existing = this.statelessAuthorizationDrains.get(key);
    if (existing) return existing.promise;
    let resolveDrain!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveDrain = resolve;
    });
    this.statelessAuthorizationDrains.set(key, { promise, resolve: resolveDrain });
    return promise;
  }

  private resolveStatelessAuthorizationDrain(owner: McpSessionOwner): void {
    if (this.exactStatelessRequestCount(owner) > 0) return;
    const key = authorizationKey(owner);
    const drain = this.statelessAuthorizationDrains.get(key);
    if (!drain) return;
    this.statelessAuthorizationDrains.delete(key);
    drain.resolve();
  }

  private exactStatelessRequestCount(owner: McpSessionOwner): number {
    let count = 0;
    for (const request of this.statelessRequests) {
      if (sameOwner(request.owner, owner)) count += 1;
    }
    return count;
  }
}

function copyOwner(owner: McpSessionOwner): McpSessionOwner {
  return Object.freeze({
    principalId: owner.principalId,
    grantId: owner.grantId,
    authorizationEpoch: owner.authorizationEpoch,
  });
}

function sameOwner(left: McpSessionOwner, right: McpSessionOwner): boolean {
  return left.principalId === right.principalId &&
    left.grantId === right.grantId &&
    left.authorizationEpoch === right.authorizationEpoch;
}

function authorizationKey(owner: McpSessionOwner): string {
  return JSON.stringify([
    owner.principalId,
    owner.grantId,
    owner.authorizationEpoch,
  ]);
}

async function closeSession(
  sessionId: string,
  underlyingClose: Promise<void>,
  closeTimeoutMs: number,
): Promise<McpSessionCloseResult> {
  try {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        underlyingClose,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Timed out closing MCP session after ${closeTimeoutMs}ms.`)),
            closeTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return { sessionId };
  } catch (error) {
    return { sessionId, error };
  }
}
