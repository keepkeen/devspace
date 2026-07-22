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
  readonly ownerClientId?: string;
}

interface McpSessionEntry<TTransport> {
  transport: TTransport;
  ownerClientId: string;
  lastActivityAt: number;
  activeRequests: number;
  closing: boolean;
  closePromise?: Promise<McpSessionCloseResult>;
}

interface McpSessionCloseAttempt {
  underlying: Promise<void>;
  ownerClientId: string;
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
  limit: number;
  owner?: {
    sessions: number;
    reservations: number;
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

  tryReserve(ownerClientId?: string): McpSessionReservation | undefined {
    if (
      this.sealed ||
      this.occupiedSlots() >= this.maxSessions ||
      (ownerClientId !== undefined &&
        this.occupiedClientSlots(ownerClientId) >= this.maxSessionsPerClient)
    ) {
      return undefined;
    }
    const reservation = { id: Symbol("mcp-session-reservation"), ownerClientId };
    this.reservations.add(reservation);
    return reservation;
  }

  async reserveWithIdleReclaim(ownerClientId: string): Promise<McpSessionReservationResult> {
    const available = this.tryReserve(ownerClientId);
    if (available) return { reservation: available };
    if (this.sealed) return {};

    const clientAtCapacity = this.occupiedClientSlots(ownerClientId) >= this.maxSessionsPerClient;
    const candidate = this.oldestInactiveSession(ownerClientId, clientAtCapacity);
    if (!candidate) return {};

    const reservation = {
      id: Symbol("mcp-session-reclaim-reservation"),
      reclaimsSessionId: candidate.sessionId,
      ownerClientId,
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
    ownerClientId: string,
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
    if (reservation?.ownerClientId && reservation.ownerClientId !== ownerClientId) {
      throw new Error("The MCP session reservation belongs to a different OAuth client.");
    }
    if (this.occupiedSlots(reservation) >= this.maxSessions) {
      throw new Error(`MCP session limit reached (${this.maxSessions}).`);
    }
    if (this.occupiedClientSlots(ownerClientId, reservation) >= this.maxSessionsPerClient) {
      throw new Error(`MCP session limit reached for this OAuth client (${this.maxSessionsPerClient}).`);
    }
    if (reservation) this.reservations.delete(reservation);
    this.sessions.set(sessionId, {
      transport,
      ownerClientId,
      lastActivityAt: this.now(),
      activeRequests,
      closing: false,
    });
  }

  get(sessionId: string, ownerClientId: string): TTransport | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.closing || entry.ownerClientId !== ownerClientId) return undefined;

    entry.lastActivityAt = this.now();
    return entry.transport;
  }

  acquire(sessionId: string, ownerClientId: string): TTransport | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.closing || entry.ownerClientId !== ownerClientId) return undefined;
    entry.lastActivityAt = this.now();
    entry.activeRequests += 1;
    return entry.transport;
  }

  release(sessionId: string, ownerClientId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.ownerClientId !== ownerClientId) return;
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
    const allClosings = new Set<Promise<McpSessionCloseResult>>();
    for (const [sessionId, closing] of this.inFlightClosings) {
      allClosings.add(closeSession(sessionId, closing.underlying, this.closeTimeoutMs));
    }
    const initiatedClosings: Array<Promise<McpSessionCloseResult>> = [];

    for (const [sessionId, entry] of this.sessions) {
      const closing = this.beginClosing(sessionId, entry);
      allClosings.add(closing.promise);
      if (closing.initiated) initiatedClosings.push(closing.promise);
    }

    await Promise.all([...allClosings]);
    return Promise.all(initiatedClosings);
  }

  usageSnapshot(ownerClientId?: string): McpSessionUsageSnapshot {
    return {
      sessions: this.size,
      reservations: this.reservations.size,
      limit: this.maxSessions,
      ...(ownerClientId === undefined ? {} : {
        owner: {
          sessions: this.clientSessionCount(ownerClientId),
          reservations: this.clientReservationCount(ownerClientId),
          limit: this.maxSessionsPerClient,
        },
      }),
    };
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
    const attempt = { underlying: underlyingClose, ownerClientId: entry.ownerClientId };
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

  private oldestInactiveSession(ownerClientId: string, ownerOnly = false): {
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
        entry.ownerClientId === ownerClientId &&
        (!oldestForOwner || entry.lastActivityAt < oldestForOwner.entry.lastActivityAt)
      ) {
        oldestForOwner = { sessionId, entry };
      }
    }

    return oldestForOwner ?? (ownerOnly ? undefined : oldestGlobal);
  }

  private occupiedSlots(excludedReservation?: McpSessionReservation): number {
    let occupied = this.size;
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
    ownerClientId: string,
    excludedReservation?: McpSessionReservation,
  ): number {
    let occupied = this.clientSessionCount(ownerClientId);
    for (const reservation of this.reservations) {
      if (reservation === excludedReservation || reservation.ownerClientId !== ownerClientId) continue;
      if (
        reservation.reclaimsSessionId &&
        this.occupiedSessionOwner(reservation.reclaimsSessionId) === ownerClientId
      ) {
        continue;
      }
      occupied += 1;
    }
    return occupied;
  }

  private clientSessionCount(ownerClientId: string): number {
    let count = 0;
    for (const entry of this.sessions.values()) {
      if (entry.ownerClientId === ownerClientId) count += 1;
    }
    for (const [sessionId, attempt] of this.inFlightClosings) {
      if (!this.sessions.has(sessionId) && attempt.ownerClientId === ownerClientId) count += 1;
    }
    return count;
  }

  private clientReservationCount(ownerClientId: string): number {
    let count = 0;
    for (const reservation of this.reservations) {
      if (reservation.ownerClientId === ownerClientId) count += 1;
    }
    return count;
  }

  private occupiedSessionOwner(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.ownerClientId
      ?? this.inFlightClosings.get(sessionId)?.ownerClientId;
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
