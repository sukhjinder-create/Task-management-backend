import pg from "pg";

const { Pool } = pg;

function safeTrim(value) {
  return typeof value === "string" ? value.trim() : "";
}

function decodePart(value) {
  try {
    return decodeURIComponent(value || "");
  } catch {
    return value || "";
  }
}

function isLocalHost(host) {
  const value = safeTrim(host).toLowerCase();
  return ["localhost", "127.0.0.1", "::1", "0.0.0.0", "postgres"].includes(value) ||
    value.endsWith(".local");
}

/**
 * Connection URL for backup/restore (pg_dump / psql) operations.
 *
 * These tools need a SESSION-mode connection: pg_dump holds a consistent
 * snapshot across many statements, which a transaction-mode pooler cannot
 * provide (each statement may land on a different backend). The application
 * pool deliberately uses transaction mode for concurrency, so backups get
 * their own endpoint via BACKUP_DATABASE_URL. Falls back to DATABASE_URL when
 * unset, preserving previous behaviour.
 */
function backupDatabaseUrl() {
  return safeTrim(process.env.BACKUP_DATABASE_URL) || process.env.DATABASE_URL;
}

function parseDatabaseUrl(value = backupDatabaseUrl()) {
  const raw = safeTrim(value);
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function databaseNameFromUrl(parsed) {
  return decodePart(parsed?.pathname?.replace(/^\/+/, "") || "");
}

function explicitDbSslMode() {
  const raw = safeTrim(process.env.DB_SSL).toLowerCase();
  if (!raw) return null;
  if (["true", "1", "require"].includes(raw)) return "require";
  if (["false", "0", "disable"].includes(raw)) return "disable";
  return raw;
}

function sslModeForParsedUrl(parsed) {
  const urlMode = safeTrim(parsed?.searchParams?.get("sslmode")).toLowerCase();
  if (urlMode) return urlMode;

  const explicit = explicitDbSslMode();
  if (explicit) return explicit;

  return parsed && !isLocalHost(parsed.hostname) ? "require" : null;
}

function sslOptionsForMode(sslMode) {
  if (!sslMode || sslMode === "disable") return {};
  return { ssl: { rejectUnauthorized: false } };
}

function normalizeUrlDatabase(rawUrl, database) {
  const parsed = parseDatabaseUrl(rawUrl);
  if (!parsed) return null;
  const dbName = safeTrim(database) || databaseNameFromUrl(parsed) || "postgres";
  parsed.pathname = `/${encodeURIComponent(dbName)}`;
  return parsed.toString();
}

function targetFromDatabaseUrl({ rawUrl = backupDatabaseUrl(), databaseOverride = null } = {}) {
  const parsed = parseDatabaseUrl(rawUrl);
  if (!parsed) return null;

  const database = safeTrim(databaseOverride) || databaseNameFromUrl(parsed) || "postgres";
  const sslMode = sslModeForParsedUrl(parsed);
  return {
    source: "DATABASE_URL",
    host: parsed.hostname,
    port: parsed.port || "5432",
    user: decodePart(parsed.username || "postgres"),
    password: decodePart(parsed.password || ""),
    database,
    sslMode,
    connectionString: normalizeUrlDatabase(rawUrl, database),
    sslOptions: sslOptionsForMode(sslMode),
  };
}

function targetFromDbVars({ databaseOverride = null } = {}) {
  const sslMode = explicitDbSslMode();
  return {
    source: "DB_HOST/DB_NAME",
    host: safeTrim(process.env.DB_HOST) || "localhost",
    port: safeTrim(process.env.DB_PORT) || "5432",
    user: safeTrim(process.env.DB_USER) || "postgres",
    password: process.env.DB_PASSWORD || "",
    database: safeTrim(databaseOverride) || safeTrim(process.env.DB_NAME) || "postgres",
    sslMode,
    connectionString: null,
    sslOptions: sslOptionsForMode(sslMode),
  };
}

export function getPrimaryDatabaseTarget({ databaseOverride = null } = {}) {
  return targetFromDatabaseUrl({ databaseOverride }) || targetFromDbVars({ databaseOverride });
}

export function getPoolConfig(databaseOverride = null) {
  const target = getPrimaryDatabaseTarget({ databaseOverride });
  if (target.connectionString) {
    return {
      connectionString: target.connectionString,
      ...target.sslOptions,
    };
  }

  return {
    host: target.host,
    port: Number(target.port || 5432),
    user: target.user,
    password: target.password,
    database: target.database,
    ...target.sslOptions,
  };
}

export function getPoolConfigFromConnectionString(connectionString) {
  const parsed = parseDatabaseUrl(connectionString);
  if (!parsed) return { connectionString };
  const sslMode = sslModeForParsedUrl(parsed);
  return {
    connectionString,
    ...sslOptionsForMode(sslMode),
  };
}

export function createConfiguredPool(databaseOverride = null) {
  return new Pool(getPoolConfig(databaseOverride));
}

export function createPoolFromConnectionString(connectionString) {
  return new Pool(getPoolConfigFromConnectionString(connectionString));
}

export function getLibpqEnv(databaseOverride = null) {
  const target = getPrimaryDatabaseTarget({ databaseOverride });
  const env = {
    ...process.env,
    PGHOST: target.host,
    PGPORT: String(target.port || 5432),
    PGUSER: target.user,
    PGPASSWORD: target.password,
    PGDATABASE: target.database,
  };

  if (target.sslMode) {
    env.PGSSLMODE = target.sslMode;
  } else {
    delete env.PGSSLMODE;
  }

  return env;
}

export function buildDatabaseUrl(databaseOverride) {
  const target = getPrimaryDatabaseTarget({ databaseOverride });
  if (target.connectionString) return target.connectionString;

  const user = encodeURIComponent(target.user);
  const pass = encodeURIComponent(target.password);
  const host = target.host;
  const port = String(target.port || 5432);
  const database = encodeURIComponent(target.database);
  const query = target.sslMode ? `?sslmode=${encodeURIComponent(target.sslMode)}` : "";
  return `postgresql://${user}:${pass}@${host}:${port}/${database}${query}`;
}

export function describePrimaryDatabaseTarget(databaseOverride = null) {
  const target = getPrimaryDatabaseTarget({ databaseOverride });
  return {
    source: target.source,
    host: target.host,
    port: target.port,
    database: target.database,
    sslMode: target.sslMode || null,
  };
}
