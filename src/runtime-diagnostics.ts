export interface RuntimeFailure {
  at: string;
  event: string;
  category: string;
  requestId?: string;
  tool?: string;
  connectionRef?: string;
  workspaceActivityRef?: string;
  errorCode?: string;
  errorFingerprint?: string;
}

export interface RuntimeFailureContext {
  requestId?: string;
  tool?: string;
  connectionRef?: string;
  workspaceActivityRef?: string;
  errorCode?: string;
  errorFingerprint?: string;
}

export class RuntimeDiagnostics {
  private readonly failures: RuntimeFailure[] = [];

  constructor(
    private readonly maxFailures = 50,
    private readonly now: () => Date = () => new Date(),
  ) {}

  recordFailure(
    event: string,
    error?: unknown,
    context: RuntimeFailureContext = {},
  ): void {
    this.failures.push({
      at: this.now().toISOString(),
      event: safeLabel(event, "unknown_failure"),
      category: errorCategory(error),
      ...safeContext(context),
    });
    if (this.failures.length > this.maxFailures) {
      this.failures.splice(0, this.failures.length - this.maxFailures);
    }
  }

  snapshot(): RuntimeFailure[] {
    return this.failures.map((entry) => ({ ...entry }));
  }
}

function safeContext(context: RuntimeFailureContext): RuntimeFailureContext {
  return Object.fromEntries(Object.entries(context).flatMap(([key, value]) => {
    if (typeof value !== "string" || value.length === 0) return [];
    return [[key, safeLabel(value, "unknown")]];
  })) as RuntimeFailureContext;
}

function errorCategory(error: unknown): string {
  if (error instanceof Error) return safeLabel(error.name, "Error");
  if (typeof error === "string") return "Error";
  return error === undefined ? "Unknown" : "NonError";
}

function safeLabel(value: string, fallback: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80);
  return normalized || fallback;
}
