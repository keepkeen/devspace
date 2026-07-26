export class AsyncConcurrencyGateBusyError extends Error {
  constructor() {
    super("The bounded async work queue is full.");
    this.name = "AsyncConcurrencyGateBusyError";
  }
}

interface Waiter {
  resolve(release: () => void): void;
  reject(error: unknown): void;
}

/** Fair FIFO gate for expensive asynchronous work. */
export class AsyncConcurrencyGate {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(
    readonly limit: number,
    readonly maxQueue = 64,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError("Async concurrency limit must be a positive integer.");
    }
    if (!Number.isSafeInteger(maxQueue) || maxQueue < 0) {
      throw new RangeError("Async concurrency queue limit must be a non-negative integer.");
    }
  }

  usage(): { active: number; queued: number; limit: number; maxQueue: number } {
    return { active: this.active, queued: this.queue.length, limit: this.limit, maxQueue: this.maxQueue };
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await task();
    } finally {
      release();
    }
  }

  private acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.releaseOnce());
    }
    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(new AsyncConcurrencyGateBusyError());
    }
    return new Promise<() => void>((resolve, reject) => {
      this.queue.push({ resolve, reject });
    });
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      if (this.active < 0) throw new Error("Async concurrency gate active count underflow.");
      const next = this.queue.shift();
      if (!next) return;
      this.active += 1;
      next.resolve(this.releaseOnce());
    };
  }
}
