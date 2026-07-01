import dotenv from "dotenv";
import path from "path";

const GUARD_STATE = Symbol.for("asystence.databaseSafetyGuard");

const explicitEnv = new Set(Object.keys(process.env));
const explicitValues = {
  ALLOW_PRODUCTION_MIGRATION: process.env.ALLOW_PRODUCTION_MIGRATION,
  CONFIRM_PRODUCTION_MIGRATION: process.env.CONFIRM_PRODUCTION_MIGRATION,
};

const DEFAULT_PRODUCTION_HOSTS = [
  "db.jygpfnpdphbnmysnyyww.supabase.co",
];

const DEFAULT_PRODUCTION_SUPABASE_PROJECT_IDS = [
  "jygpfnpdphbnmysnyyww",
];

function splitList(value) {
  return String(value || "")
    .split(/[,\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function safeTrim(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseUrl(value) {
  const raw = safeTrim(value);
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function databaseNameFromUrl(parsed) {
  return decodeURIComponent(parsed?.pathname?.replace(/^\/+/, "") || "");
}

function isLocalHost(host) {
  const value = safeTrim(host).toLowerCase();
  return [
    "localhost",
    "127.0.0.1",
    "::1",
    "0.0.0.0",
    "postgres",
    "asystence-postgres-staging",
  ].includes(value);
}

function knownProductionHosts() {
  return new Set([
    ...DEFAULT_PRODUCTION_HOSTS,
    ...splitList(process.env.PRODUCTION_DATABASE_HOSTS),
  ]);
}

function knownProductionSupabaseProjectIds() {
  return new Set([
    ...DEFAULT_PRODUCTION_SUPABASE_PROJECT_IDS,
    ...splitList(process.env.PRODUCTION_SUPABASE_PROJECT_IDS),
    ...splitList(process.env.SUPABASE_PRODUCTION_PROJECT_IDS),
  ]);
}

function supabaseProjectIdsFromTarget(target) {
  const ids = new Set();
  const host = safeTrim(target.host).toLowerCase();
  const username = safeTrim(target.username).toLowerCase();
  const raw = safeTrim(target.raw).toLowerCase();

  const directHost = host.match(/^db\.([a-z0-9]{15,})\.supabase\.co$/);
  if (directHost) ids.add(directHost[1]);

  const subdomainHost = host.match(/^([a-z0-9]{15,})\.supabase\.co$/);
  if (subdomainHost) ids.add(subdomainHost[1]);

  const poolerUser = username.match(/^postgres\.([a-z0-9]{15,})$/);
  if (poolerUser) ids.add(poolerUser[1]);

  for (const knownId of knownProductionSupabaseProjectIds()) {
    if (raw.includes(knownId) || host.includes(knownId) || username.includes(knownId)) {
      ids.add(knownId);
    }
  }

  return [...ids];
}

function classifyTarget(target) {
  const host = safeTrim(target.host).toLowerCase();
  const database = safeTrim(target.database).toLowerCase();
  const envName = (
    safeTrim(process.env.DATABASE_ENV) ||
    safeTrim(process.env.APP_ENV) ||
    safeTrim(process.env.NODE_ENV)
  ).toLowerCase();
  const hostSet = knownProductionHosts();
  const projectIds = supabaseProjectIdsFromTarget(target);
  const productionIds = knownProductionSupabaseProjectIds();
  const hasKnownProductionProject = projectIds.some((id) => productionIds.has(id));

  if (isLocalHost(host)) return "local";
  if (hostSet.has(host) || hasKnownProductionProject) return "production";
  if (envName === "production" && host) return "production";
  if (/staging|stage|preview|preprod/.test(`${host} ${database} ${envName}`)) {
    return "staging";
  }
  if (/development|develop|dev|test/.test(`${host} ${database} ${envName}`)) {
    return "development";
  }
  return "unknown";
}

function primaryDbTarget() {
  const parsed = parseUrl(process.env.DATABASE_URL);
  if (parsed) {
    return {
      label: "primary",
      source: "DATABASE_URL",
      host: parsed.hostname,
      port: parsed.port || "",
      database: databaseNameFromUrl(parsed),
      username: parsed.username,
      raw: safeTrim(process.env.DATABASE_URL),
      loadedFromDotenv:
        !explicitEnv.has("DATABASE_URL") && Boolean(safeTrim(process.env.DATABASE_URL)),
    };
  }

  return {
    label: "primary",
    source: "DB_HOST/DB_NAME",
    host: safeTrim(process.env.DB_HOST),
    port: safeTrim(process.env.DB_PORT),
    database: safeTrim(process.env.DB_NAME),
    username: safeTrim(process.env.DB_USER),
    raw: [
      safeTrim(process.env.DB_HOST),
      safeTrim(process.env.DB_PORT),
      safeTrim(process.env.DB_NAME),
      safeTrim(process.env.DB_USER),
    ].join(" "),
    loadedFromDotenv:
      !explicitEnv.has("DB_HOST") && Boolean(safeTrim(process.env.DB_HOST)),
  };
}

function dbHostTarget() {
  return {
    label: "source",
    source: "DB_HOST/DB_NAME",
    host: safeTrim(process.env.DB_HOST),
    port: safeTrim(process.env.DB_PORT),
    database: safeTrim(process.env.DB_NAME),
    username: safeTrim(process.env.DB_USER),
    raw: [
      safeTrim(process.env.DB_HOST),
      safeTrim(process.env.DB_PORT),
      safeTrim(process.env.DB_NAME),
      safeTrim(process.env.DB_USER),
    ].join(" "),
    loadedFromDotenv:
      !explicitEnv.has("DB_HOST") && Boolean(safeTrim(process.env.DB_HOST)),
  };
}

function newDatabaseUrlTarget() {
  const parsed = parseUrl(process.env.NEW_DATABASE_URL);
  if (!parsed) return null;
  return {
    label: "destination",
    source: "NEW_DATABASE_URL",
    host: parsed.hostname,
    port: parsed.port || "",
    database: databaseNameFromUrl(parsed),
    username: parsed.username,
    raw: safeTrim(process.env.NEW_DATABASE_URL),
    loadedFromDotenv:
      !explicitEnv.has("NEW_DATABASE_URL") && Boolean(safeTrim(process.env.NEW_DATABASE_URL)),
  };
}

function targetKey(target) {
  return `${safeTrim(target.host)}/${safeTrim(target.database)}`;
}

function uniqueTargets(targets) {
  const seen = new Set();
  return targets.filter((target) => {
    if (!target) return false;
    const key = `${target.label}:${target.source}:${targetKey(target)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function currentEntrypoint() {
  return process.argv[1] ? path.basename(process.argv[1]) : "";
}

function isDatabaseScriptEntrypoint(entrypoint = currentEntrypoint()) {
  const name = safeTrim(entrypoint).toLowerCase();
  return (
    name === "migrate-to-supabase.js" ||
    name.startsWith("run-") && name.includes("migration") ||
    name.startsWith("verify-") ||
    process.env.DATABASE_SAFETY_GUARD === "required"
  );
}

function resolveTargets(entrypoint = currentEntrypoint()) {
  if (entrypoint === "migrate-to-supabase.js") {
    return uniqueTargets([dbHostTarget(), newDatabaseUrlTarget()]);
  }
  return uniqueTargets([primaryDbTarget()]);
}

function printTargetReport({ entrypoint, targets }) {
  console.log("[db-safety] Database script target review");
  console.log(`[db-safety] Entrypoint: ${entrypoint || "(unknown)"}`);
  for (const target of targets) {
    const classification = target.classification || classifyTarget(target);
    const port = target.port ? `:${target.port}` : "";
    console.log(`[db-safety] Target: ${target.label}`);
    console.log(`[db-safety]   source: ${target.source}`);
    console.log(`[db-safety]   host: ${target.host || "(unset)"}${port}`);
    console.log(`[db-safety]   database: ${target.database || "(unset)"}`);
    console.log(`[db-safety]   classification: ${classification}`);
    if (target.loadedFromDotenv) {
      console.log("[db-safety]   note: value was loaded from .env");
    }
  }
}

function fail(message, details = []) {
  console.error(`[db-safety] Refusing to continue: ${message}`);
  for (const detail of details) {
    console.error(`[db-safety] ${detail}`);
  }
  const error = new Error(`database_safety_guard_blocked: ${message}`);
  error.code = "DATABASE_SAFETY_GUARD_BLOCKED";
  if (process.env.DATABASE_SAFETY_GUARD_THROW === "true") {
    throw error;
  }
  process.exit(1);
  throw error;
}

export function describeDatabaseTargets({ includeNewDatabaseUrl = false } = {}) {
  dotenv.config({ quiet: true });
  const targets = includeNewDatabaseUrl
    ? uniqueTargets([primaryDbTarget(), newDatabaseUrlTarget()])
    : resolveTargets(currentEntrypoint());
  return targets.map((target) => ({
    ...target,
    classification: classifyTarget(target),
    supabaseProjectIds: supabaseProjectIdsFromTarget(target),
  }));
}

export function assertDatabaseScriptSafety({
  operation = "database script",
  force = false,
} = {}) {
  const state = globalThis[GUARD_STATE] || {};
  if (state.checked) return state.result;

  const entrypoint = currentEntrypoint();
  if (!force && !isDatabaseScriptEntrypoint(entrypoint)) {
    state.checked = true;
    state.result = { skipped: true, reason: "entrypoint_not_database_script" };
    globalThis[GUARD_STATE] = state;
    return state.result;
  }

  dotenv.config({ quiet: true });

  const targets = resolveTargets(entrypoint).map((target) => ({
    ...target,
    classification: classifyTarget(target),
    supabaseProjectIds: supabaseProjectIdsFromTarget(target),
  }));

  printTargetReport({ entrypoint, targets });

  const productionTargets = targets.filter(
    (target) => target.classification === "production"
  );

  if (productionTargets.length > 0) {
    const expectedConfirmation = [...new Set(productionTargets.map(targetKey))].join(",");
    const allowWasExplicit = explicitEnv.has("ALLOW_PRODUCTION_MIGRATION");
    const confirmationWasExplicit = explicitEnv.has("CONFIRM_PRODUCTION_MIGRATION");
    const allowValue = safeTrim(explicitValues.ALLOW_PRODUCTION_MIGRATION);
    const confirmationValue = safeTrim(explicitValues.CONFIRM_PRODUCTION_MIGRATION);

    if (!allowWasExplicit || allowValue !== "true") {
      fail("production database detected", [
        `Set ALLOW_PRODUCTION_MIGRATION=true in the shell/CI environment only if this is intentional.`,
        `Do not place ALLOW_PRODUCTION_MIGRATION in .env.`,
        `Production target confirmation token: ${expectedConfirmation}`,
        `For local/staging, set DATABASE_URL to a local URL or a single space and set DB_HOST/DB_PORT/DB_NAME explicitly.`,
      ]);
    }

    if (!confirmationWasExplicit || confirmationValue !== expectedConfirmation) {
      fail("production confirmation missing or incorrect", [
        `Set CONFIRM_PRODUCTION_MIGRATION=${expectedConfirmation}`,
        `Operation: ${operation}`,
      ]);
    }

    console.log("[db-safety] Production override accepted.");
  }

  state.checked = true;
  state.result = {
    skipped: false,
    entrypoint,
    targets,
    production: productionTargets.length > 0,
  };
  globalThis[GUARD_STATE] = state;
  return state.result;
}

export function assertDatabaseScriptSafetyIfNeeded() {
  return assertDatabaseScriptSafety();
}

export function assertApplicationDatabaseSafety({
  operation = "application runtime",
} = {}) {
  const entrypoint = currentEntrypoint();
  if (isDatabaseScriptEntrypoint(entrypoint)) {
    return { skipped: true, reason: "database_script_guard_handles_entrypoint" };
  }

  dotenv.config({ quiet: true });

  const envName = (
    safeTrim(process.env.DATABASE_ENV) ||
    safeTrim(process.env.APP_ENV) ||
    safeTrim(process.env.NODE_ENV) ||
    "development"
  ).toLowerCase();
  const isProductionLike = ["production", "staging", "stage", "preview", "preprod"].includes(envName);
  if (isProductionLike) {
    return { skipped: true, reason: "production_like_runtime", envName };
  }

  const targets = [primaryDbTarget()].map((target) => ({
    ...target,
    classification: classifyTarget(target),
    supabaseProjectIds: supabaseProjectIdsFromTarget(target),
  }));
  const productionTargets = targets.filter((target) => target.classification === "production");
  if (productionTargets.length === 0) {
    return { skipped: false, targets, production: false };
  }

  if (safeTrim(process.env.ALLOW_LOCAL_PRODUCTION_DATABASE) === "true") {
    console.warn("[db-safety] Local production database override accepted.");
    return { skipped: false, targets, production: true, override: true };
  }

  const summary = productionTargets
    .map((target) => `${target.source} -> ${target.host || "(unset)"}/${target.database || "(unset)"}`)
    .join(", ");
  const error = new Error(
    `database_safety_guard_blocked: ${operation} cannot use a production database in ${envName} runtime (${summary}). ` +
      "Set DATABASE_URL/DB_HOST to a local or staging database, or explicitly set ALLOW_LOCAL_PRODUCTION_DATABASE=true only for intentional read/write testing."
  );
  error.code = "DATABASE_SAFETY_GUARD_BLOCKED";
  error.targets = productionTargets.map((target) => ({
    source: target.source,
    host: target.host,
    database: target.database,
    classification: target.classification,
  }));
  throw error;
}
