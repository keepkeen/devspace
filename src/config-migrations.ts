export const CURRENT_CONFIG_SCHEMA_VERSION = 2 as const;

export interface ConfigMigrationResult {
  config: Record<string, unknown>;
  fromVersion: number;
  toVersion: typeof CURRENT_CONFIG_SCHEMA_VERSION;
  changed: boolean;
}

export function migrateConfigDocument(input: unknown): ConfigMigrationResult {
  if (!isRecord(input)) throw new Error("The DevSpace config must be a JSON object.");

  const configuredVersion = input.schemaVersion;
  const fromVersion = configuredVersion === undefined ? 0 : configuredVersion;
  if (!Number.isSafeInteger(fromVersion) || (fromVersion as number) < 0) {
    throw new Error("config.schemaVersion must be a non-negative integer.");
  }
  if ((fromVersion as number) > CURRENT_CONFIG_SCHEMA_VERSION) {
    throw new Error(
      `Config schema version ${String(fromVersion)} is newer than this DevSpace version supports (${CURRENT_CONFIG_SCHEMA_VERSION}).`,
    );
  }

  let config = { ...input };
  let version = fromVersion as number;
  while (version < CURRENT_CONFIG_SCHEMA_VERSION) {
    if (version === 0) config = migrateVersionZero(config);
    if (version === 1) config = migrateVersionOne(config);
    version += 1;
  }

  return {
    config,
    fromVersion: fromVersion as number,
    toVersion: CURRENT_CONFIG_SCHEMA_VERSION,
    changed: fromVersion !== CURRENT_CONFIG_SCHEMA_VERSION,
  };
}

function migrateVersionZero(config: Record<string, unknown>): Record<string, unknown> {
  const migrated: Record<string, unknown> = { ...config, schemaVersion: 1 };
  if (
    migrated.projectDocFallbackFilenames === undefined &&
    Array.isArray(migrated.project_doc_fallback_filenames)
  ) {
    migrated.projectDocFallbackFilenames = migrated.project_doc_fallback_filenames;
  }
  delete migrated.project_doc_fallback_filenames;
  return migrated;
}

function migrateVersionOne(config: Record<string, unknown>): Record<string, unknown> {
  const migrated: Record<string, unknown> = { ...config, schemaVersion: 2 };
  if (
    migrated.projectDocFallbackFilenames === undefined &&
    Array.isArray(migrated.project_doc_fallback_filenames)
  ) {
    migrated.projectDocFallbackFilenames = migrated.project_doc_fallback_filenames;
  }
  delete migrated.project_doc_fallback_filenames;
  delete migrated.toolMode;
  delete migrated.agentDir;
  return migrated;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
