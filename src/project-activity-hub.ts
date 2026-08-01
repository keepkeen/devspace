export interface ProjectActivityNotification {
  threadId: string;
  sequence: number;
}

interface ActivityWaiter {
  afterSequence: number;
  timer: NodeJS.Timeout;
  resolve: (available: boolean) => void;
}

/**
 * In-memory low-latency wake-up channel for durable Project activity events.
 * The SQLite journal remains authoritative; callers must always re-read it
 * after a wake-up because notifications may be coalesced or lost on restart.
 */
export class ProjectActivityHub {
  private readonly latestSequence = new Map<string, number>();
  private readonly waiters = new Map<string, Set<ActivityWaiter>>();
  private closed = false;

  publish(notification: ProjectActivityNotification): void {
    if (this.closed) return;
    const previous = this.latestSequence.get(notification.threadId) ?? 0;
    if (notification.sequence > previous) {
      this.latestSequence.set(notification.threadId, notification.sequence);
    }
    const waiters = this.waiters.get(notification.threadId);
    if (!waiters) return;
    for (const waiter of [...waiters]) {
      if (notification.sequence <= waiter.afterSequence) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(true);
    }
    if (waiters.size === 0) this.waiters.delete(notification.threadId);
  }

  waitForAfter(threadId: string, afterSequence: number, waitMs: number): Promise<boolean> {
    if (this.closed || waitMs <= 0) return Promise.resolve(false);
    if ((this.latestSequence.get(threadId) ?? 0) > afterSequence) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const waiters = this.waiters.get(threadId) ?? new Set<ActivityWaiter>();
      const waiter: ActivityWaiter = {
        afterSequence,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          if (waiters.size === 0) this.waiters.delete(threadId);
          resolve(false);
        }, waitMs),
        resolve,
      };
      waiter.timer.unref();
      waiters.add(waiter);
      this.waiters.set(threadId, waiters);
      // Close the race between the pre-registration check and insertion.
      if ((this.latestSequence.get(threadId) ?? 0) > afterSequence) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        if (waiters.size === 0) this.waiters.delete(threadId);
        resolve(true);
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(false);
      }
    }
    this.waiters.clear();
    this.latestSequence.clear();
  }
}
