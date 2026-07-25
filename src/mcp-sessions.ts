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

export interface McpSessionReservation {
  readonly id: symbol;
  readonly reclaimsSessionId?: string;
  readonly connectionPrincipalId?: string;
}

export interface StatelessMcpRequestOwnerRefs {
  readonly principalRef: string;
  readonly clientRef: string;
}

export interface StatelessMcpRequestLease {
  readonly id: symbol;
  readonly connectionPrincipalId: string;
  readonly acquiredAt: number;
  readonly principalRef: string;
  readonly clientRef: string;
}

export interface StatelessMcpRequestLeaseUsage {
  agesMs: number[];
  byOwner: Array<{
    principalRef: string;
    clientRef: string;
    active: number;
    oldestLeaseAgeMs: number;
  }>;
}

interface McpSessionEntry<TTransport> {
  transport: TTransport;
  connectionPrincipalId: string;
  lastActivityAt: number;
  activeRequests: number;
  closing: boolean;
  closePromise?: Promise<McpSessionCloseResult>;
}

interface McpSessionCloseAttempt {
  underlying: Promise<void>;
  connectionPrincipalId: string;
}

export interface McpSessionRegistryOptions {
  now?: () => number;
  maxSessions?: number;
  maxSessionsPerClient?: number;
  closeTimeoutMs?: number;
}

export interface McpSessionUsageSnapshot {
  sessions: number;
  reservations: number;
  statelessRequests: number;
  statelessLeases: StatelessMcpRequestLeaseUsage;
  limit: number;
  owner?: {
    sessions: number;
    reservations: number;
    statelessRequests: number;
    limit: number;
  };
}

export class McpSessionRegistry<TTransport extends ClosableMcpTransport> {
  private readonly sessions = new Map<string, McpSessionEntry<TTransport>>();
  private readonly inFlightClosings = new Map<string, McpSessionCloseAttempt>();
  private readonly now: () => number;
  private readonly maxSessions: number;
  private readonly maxSessionsPerClient: number;
  private readonly reservations = new Set<McpSessionReservation>();
  private readonly statelessRequests = new Set<StatelessMcpRequestLease>();
  private readonly closeTimeoutMs: number;
  private sealed = false;

  constructor(options: McpSessionRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxSessions = options.maxSessions ?? Number.POSITIVE_INFINITY;
    this.maxSessionsPerClient = options.maxSessionsPerClient ?? Number.POSITIVE_INFINITY;
    this.closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
  }

  get size(): number {
    let size = this.sessions.size;
    for (const sessionId of this.inFlightClosings.keys()) {
      if (!this.sessions.has(sessionId)) size += 1;
    }
    return size;
  }

  tryReserve(connectionPrincipalId?: string): McpSessionReservation | undefined {
    if (
      this.sealed ||
      this.occupiedSlots() >= this.maxSessions ||
      (connectionPrincipalId !== undefined &&
        this.occupiedClientSlots(connectionPrincipalId) >= this.maxSessionsPerClient)
    ) {
      return undefined;
    }
    const reservation = { id: Symbol("mcp-session-reservation"), connectionPrincipalId };
    this.reservations.add(reservation);
    return reservation;
  }

  tryAcquireStatelessRequest(
    connectionPrincipalId: string,
    ownerRefs: StatelessMcpRequestOwnerRefs,
  ): StatelessMcpRequestLease | undefined {
    if (
      this.sealed ||
      this.occupiedSlots() >= this.maxSessions ||
      this.occupiedClientSlots(connectionPrincipalId) >= this.maxSessionsPerClient
    ) {
      return undefined;
    }
    const lease = {
      id: Symbol("stateless-mcp-request"),
      connectionPrincipalId,
      acquiredAt: this.now(),
      ...ownerRefs,
    };
    this.statelessRequests.add(lease);
    return lease;
  }

  releaseStatelessRequest(lease: StatelessMcpRequestLease): boolean {
    return this.statelessRequests.delete(lease);
  }

  async reserveWithIdleReclaim(connectionPrincipalId: string): Promise<McpSessionReservationResult> {
    const available = this.tryReserve(connectionPrincipalId);
    if (available) return { reservation: available };
    if (this.sealed) return {};

    const clientAtCapacity = this.occupiedClientSlots(connectionPrincipalId) >= this.maxSessionsPerClient;
    const candidate = this.oldestInactiveSession(connectionPrincipalId, clientAtCapacity);
    if (!candidate) return {};

    const reservation = {
      id: Symbol("mcp-session-reclaim-reservation"),
      reclaimsSessionId: candidate.sessionId,
      connectionPrincipalId,
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
    this.statelessRequests.clear();
  }

  register(
    sessionId: string,
    connectionPrincipalId: string,
    transport: TTransport,
    reservation?: McpSessionReservation,
    activeRequests = 0,
  ): void {
    if (this.sealed) throw new Error("The MCP session registry is closed.");
    if (reservation && !this.reservations.has(reservation)) {
      throw new Error("The MCP session reservation is no longer valid.");
    }
    if (this.sessions.has(sessionId)) {
      throw new Error(`Duplicate MCP session: ${sessionId}`);
    }
    if (reservation?.connectionPrincipalId && reservation.connectionPrincipalId !== connectionPrincipalId) {
      throw new Error("The MCP session reservation belongs to a different OAuth client.");
    }
    if (this.occupiedSlots(reservation) >= this.maxSessions) {
      throw new Error(`MCP session limit reached (${this.maxSessions}).`);
    }
    if (this.occupiedClientSlots(connectionPrincipalId, reservation) >= this.maxSessionsPerClient) {
      throw new Error(`MCP session limit reached for this OAuth client (${this.maxSessionsPerClient}).`);
    }
    if (reservation) this.reservations.delete(reservation);
    this.sessions.set(sessionId, {
      transport,
      connectionPrincipalId,
      lastActivityAt: this.now(),
      activeRequests,
      closing: false,
    });
  }

  get(sessionId: string, connectionPrincipalId: string): TTransport | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.closing || entry.connectionPrincipalId !== connectionPrincipalId) return undefined;

    entry.lastActivityAt = this.now();
    return entry.transport;
  }

  acquire(sessionId: string, connectionPrincipalId: string): TTransport | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.closing || entry.connectionPrincipalId !== connectionPrincipalId) return undefined;
    entry.lastActivityAt = this.now();
    entry.activeRequests += 1;
    return entry.transport;
  }

  release(sessionId: string, connectionPrincipalId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.connectionPrincipalId !== connectionPrincipalId) return;
    entry.activeRequests = Math.max(0, entry.activeRequests - 1);
    entry.lastActivityAt = this.now();
  }

  remove(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  removeOnTransportClose(sessionId: string): "intentional" | "unexpected" | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry) return undefined;
    this.sessions.delete(sessionId);
    const inFlightClosing = this.inFlightClosings.get(sessionId);
    if (entry.closing && inFlightClosing?.connectionPrincipalId === entry.connectionPrincipalId) {
      this.inFlightClosings.delete(sessionId);
    }
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

  async closeActive(): Promise<McpSessionCloseResult[]> {
    this.reservations.clear();
    const allClosings = new Set<Promise<McpSessionCloseResult>>();
    for (const [sessionId, closing] of [...this.inFlightClosings]) {
      allClosings.add(closeSession(sessionId, closing.underlying, this.closeTimeoutMs));
    }
    const initiatedClosings: Array<Promise<McpSessionCloseResult>> = [];

    for (const [sessionId, entry] of [...this.sessions]) {
      const closing = this.beginClosing(sessionId, entry);
      allClosings.add(closing.promise);
      if (closing.initiated) initiatedClosings.push(closing.promise);
    }

    await Promise.all([...allClosings]);
    return Promise.all(initiatedClosings);
  }

  usageSnapshot(connectionPrincipalId?: string): McpSessionUsageSnapshot {
    return {
      sessions: this.size,
      reservations: this.reservations.size,
      statelessRequests: this.statelessRequests.size,
      statelessLeases: this.statelessLeaseUsage(),
      limit: this.maxSessions,
      ...(connectionPrincipalId === undefined ? {} : {
        owner: {
          sessions: this.clientSessionCount(connectionPrincipalId),
          reservations: this.clientReservationCount(connectionPrincipalId),
          statelessRequests: this.clientStatelessRequestCount(connectionPrincipalId),
          limit: this.maxSessionsPerClient,
        },
      }),
    };
  }

  private statelessLeaseUsage(): StatelessMcpRequestLeaseUsage {
    const now = this.now();
    const agesMs: number[] = [];
    const groups = new Map<string, StatelessMcpRequestLeaseUsage["byOwner"][number]>();

    for (const lease of this.statelessRequests) {
      const ageMs = Math.max(0, now - lease.acquiredAt);
      agesMs.push(ageMs);
      const key = `${lease.principalRef}\0${lease.clientRef}`;
      const current = groups.get(key);
      if (current) {
        current.active += 1;
        current.oldestLeaseAgeMs = Math.max(current.oldestLeaseAgeMs, ageMs);
      } else {
        groups.set(key, {
          principalRef: lease.principalRef,
          clientRef: lease.clientRef,
          active: 1,
          oldestLeaseAgeMs: ageMs,
        });
      }
    }

    agesMs.sort((left, right) => right - left);
    const byOwner = [...groups.values()].sort((left, right) =>
      left.principalRef.localeCompare(right.principalRef) ||
      left.clientRef.localeCompare(right.clientRef));
    return { agesMs, byOwner };
  }

  private beginClosing(
    sessionId: string,
    entry: McpSessionEntry<TTransport>,
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
    const underlyingClose = Promise.resolve().then(() => entry.transport.close());
    const promise = closeSession(sessionId, underlyingClose, this.closeTimeoutMs);
    entry.closePromise = promise;
    const attempt = { underlying: underlyingClose, connectionPrincipalId: entry.connectionPrincipalId };
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

  private oldestInactiveSession(connectionPrincipalId: string, ownerOnly = false): {
    sessionId: string;
    entry: McpSessionEntry<TTransport>;
  } | undefined {
    let oldestForOwner: { sessionId: string; entry: McpSessionEntry<TTransport> } | undefined;
    let oldestGlobal: { sessionId: string; entry: McpSessionEntry<TTransport> } | undefined;

    for (const [sessionId, entry] of this.sessions) {
      if (entry.closePromise || entry.activeRequests > 0) continue;
      if (!oldestGlobal || entry.lastActivityAt < oldestGlobal.entry.lastActivityAt) {
        oldestGlobal = { sessionId, entry };
      }
      if (
        entry.connectionPrincipalId === connectionPrincipalId &&
        (!oldestForOwner || entry.lastActivityAt < oldestForOwner.entry.lastActivityAt)
      ) {
        oldestForOwner = { sessionId, entry };
      }
    }

    return oldestForOwner ?? (ownerOnly ? undefined : oldestGlobal);
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

  private occupiedClientSlots(
    connectionPrincipalId: string,
    excludedReservation?: McpSessionReservation,
  ): number {
    let occupied =
      this.clientSessionCount(connectionPrincipalId) + this.clientStatelessRequestCount(connectionPrincipalId);
    for (const reservation of this.reservations) {
      if (reservation === excludedReservation || reservation.connectionPrincipalId !== connectionPrincipalId) continue;
      if (
        reservation.reclaimsSessionId &&
        this.occupiedSessionOwner(reservation.reclaimsSessionId) === connectionPrincipalId
      ) {
        continue;
      }
      occupied += 1;
    }
    return occupied;
  }

  private clientSessionCount(connectionPrincipalId: string): number {
    let count = 0;
    for (const entry of this.sessions.values()) {
      if (entry.connectionPrincipalId === connectionPrincipalId) count += 1;
    }
    for (const [sessionId, attempt] of this.inFlightClosings) {
      if (!this.sessions.has(sessionId) && attempt.connectionPrincipalId === connectionPrincipalId) count += 1;
    }
    return count;
  }

  private clientReservationCount(connectionPrincipalId: string): number {
    let count = 0;
    for (const reservation of this.reservations) {
      if (reservation.connectionPrincipalId === connectionPrincipalId) count += 1;
    }
    return count;
  }

  private clientStatelessRequestCount(connectionPrincipalId: string): number {
    let count = 0;
    for (const request of this.statelessRequests) {
      if (request.connectionPrincipalId === connectionPrincipalId) count += 1;
    }
    return count;
  }

  private occupiedSessionOwner(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.connectionPrincipalId
      ?? this.inFlightClosings.get(sessionId)?.connectionPrincipalId;
  }
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
