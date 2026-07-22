export interface RuntimeFailure {
  at: string;
  event: string;
  category: string;
}

export class RuntimeDiagnostics {
  private readonly failures: RuntimeFailure[] = [];

  constructor(
    private readonly maxFailures = 50,
    private readonly now: () => Date = () => new Date(),
  ) {}

  recordFailure(event: string, error?: unknown): void {
    this.failures.push({
      at: this.now().toISOString(),
      event: safeLabel(event, "unknown_failure"),
      category: errorCategory(error),
    });
    if (this.failures.length > this.maxFailures) {
      this.failures.splice(0, this.failures.length - this.maxFailures);
    }
  }

  snapshot(): RuntimeFailure[] {
    return this.failures.map((entry) => ({ ...entry }));
  }
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
