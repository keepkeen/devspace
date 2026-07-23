export class ActiveRequestBarrier {
  private active = 0;
  private readonly idleWaiters = new Set<() => void>();

  enter(): () => void {
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      if (this.active !== 0) return;
      for (const resolve of this.idleWaiters) resolve();
      this.idleWaiters.clear();
    };
  }

  async track<T>(operation: () => T | Promise<T>): Promise<T> {
    const release = this.enter();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async waitForIdle(timeoutMs?: number): Promise<boolean> {
    if (this.active === 0) return true;
    if (timeoutMs === undefined) {
      return await new Promise<true>((resolve) => {
        this.idleWaiters.add(() => resolve(true));
      });
    }
    let timer: NodeJS.Timeout | undefined;
    let resolveIdle: (() => void) | undefined;
    try {
      return await Promise.race([
        new Promise<true>((resolve) => {
          resolveIdle = () => resolve(true);
          this.idleWaiters.add(resolveIdle);
        }),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (resolveIdle) this.idleWaiters.delete(resolveIdle);
    }
  }
}
