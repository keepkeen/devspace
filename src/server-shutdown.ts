export interface ClosableHttpServer {
  close(callback: (error?: Error) => void): void;
  closeAllConnections?(): void;
}

export async function shutdownHttpServer(
  httpServer: ClosableHttpServer,
  closeApplication: () => Promise<void>,
  drainTimeoutMs = 30_000,
): Promise<void> {
  const httpClosed = new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });

  const errors: unknown[] = [];
  let httpError: unknown;
  let httpRejected = false;
  const observedHttpClose = httpClosed.then(
    () => true,
    (error) => {
      httpRejected = true;
      httpError = error;
      return true;
    },
  );
  let drained = await settlesBefore(observedHttpClose, drainTimeoutMs);
  if (!drained) {
    httpServer.closeAllConnections?.();
    drained = await settlesBefore(observedHttpClose, Math.min(drainTimeoutMs, 1_000));
    if (!drained) {
      errors.push(new Error(`HTTP server did not drain within ${drainTimeoutMs}ms.`));
    }
  }
  if (httpRejected) errors.push(httpError);
  try {
    await closeApplication();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "HTTP and application shutdown both failed");
}

async function settlesBefore(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
