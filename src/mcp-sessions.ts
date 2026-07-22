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
}

interface McpSessionEntry<TTransport> {
  transport: TTransport;
  ownerClientId: string;
  lastActivityAt: number;
  activeRequests: number;
  closing: boolean;
}

export interface McpSessionRegistryOptions {
  now?: () => number;
  maxSessions?: number;
  closeTimeoutMs?: number;
}

export class McpSessionRegistry<TTransport extends ClosableMcpTransport> {
  private readonly sessions = new Map<string, McpSessionEntry<TTransport>>();
  private readonly now: () => number;
  private readonly maxSessions: number;
  private readonly reservations = new Set<McpSessionReservation>();
  private readonly closeTimeoutMs: number;
  private sealed = false;

  constructor(options: McpSessionRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxSessions = options.maxSessions ?? Number.POSITIVE_INFINITY;
    this.closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
  }

  get size(): number {
    return this.sessions.size;
  }

  tryReserve(): McpSessionReservation | undefined {
    if (this.sealed || this.occupiedSlots() >= this.maxSessions) {
      return undefined;
    }
    const reservation = { id: Symbol("mcp-session-reservation") };
    this.reservations.add(reservation);
    return reservation;
  }

  async reserveWithIdleReclaim(ownerClientId: string): Promise<McpSessionReservationResult> {
    const available = this.tryReserve();
    if (available) return { reservation: available };
    if (this.sealed) return {};

    const candidate = this.oldestInactiveSession(ownerClientId);
    if (!candidate) return {};

    candidate.entry.closing = true;
    const reservation = {
      id: Symbol("mcp-session-reclaim-reservation"),
      reclaimsSessionId: candidate.sessionId,
    };
    this.reservations.add(reservation);
    const [reclaimed] = await closeSessions(
      [{ sessionId: candidate.sessionId, transport: candidate.entry.transport }],
      this.closeTimeoutMs,
    );
    if (!reclaimed) {
      this.reservations.delete(reservation);
      return {};
    }

    this.finishClosing([reclaimed]);
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
    if (this.occupiedSlots(reservation) >= this.maxSessions) {
      throw new Error(`MCP session limit reached (${this.maxSessions}).`);
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

  async closeIdle(idleTimeoutMs: number): Promise<McpSessionCloseResult[]> {
    const cutoff = this.now() - idleTimeoutMs;
    const idleSessions: Array<{ sessionId: string; transport: TTransport }> = [];

    for (const [sessionId, entry] of this.sessions) {
      if (entry.closing || entry.activeRequests > 0 || entry.lastActivityAt > cutoff) continue;

      entry.closing = true;
      idleSessions.push({ sessionId, transport: entry.transport });
    }

    const results = await closeSessions(idleSessions, this.closeTimeoutMs);
    this.finishClosing(results);
    return results;
  }

  async closeAll(): Promise<McpSessionCloseResult[]> {
    this.seal();
    const sessions = Array.from(this.sessions, ([sessionId, entry]) => {
      entry.closing = true;
      return {
        sessionId,
        transport: entry.transport,
      };
    });
    const results = await closeSessions(sessions, this.closeTimeoutMs);
    this.finishClosing(results);
    return results;
  }

  private finishClosing(results: McpSessionCloseResult[]): void {
    for (const result of results) {
      const entry = this.sessions.get(result.sessionId);
      if (!entry) continue;
      if (!result.error) {
        this.sessions.delete(result.sessionId);
      }
    }
  }

  private oldestInactiveSession(ownerClientId: string): {
    sessionId: string;
    entry: McpSessionEntry<TTransport>;
  } | undefined {
    let oldestForOwner: { sessionId: string; entry: McpSessionEntry<TTransport> } | undefined;
    let oldestGlobal: { sessionId: string; entry: McpSessionEntry<TTransport> } | undefined;

    for (const [sessionId, entry] of this.sessions) {
      if (entry.closing || entry.activeRequests > 0) continue;
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

    return oldestForOwner ?? oldestGlobal;
  }

  private occupiedSlots(excludedReservation?: McpSessionReservation): number {
    let occupied = this.sessions.size;
    for (const reservation of this.reservations) {
      if (reservation === excludedReservation) continue;
      if (
        reservation.reclaimsSessionId &&
        this.sessions.has(reservation.reclaimsSessionId)
      ) {
        continue;
      }
      occupied += 1;
    }
    return occupied;
  }
}

async function closeSessions<TTransport extends ClosableMcpTransport>(
  sessions: Array<{ sessionId: string; transport: TTransport }>,
  closeTimeoutMs: number,
): Promise<McpSessionCloseResult[]> {
  return Promise.all(
    sessions.map(async ({ sessionId, transport }) => {
      try {
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            transport.close(),
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
    }),
  );
}
