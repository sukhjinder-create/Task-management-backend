// ops/startupValidation.js
//
// Production-readiness startup validation. PURE + deterministic: given an env object
// (+ the migration filenames present in the bundle) it reports configuration errors and
// warnings WITHOUT ever printing secret values. Used by the /readyz endpoint and by a
// one-time boot diagnostic. Additive — it never mutates state and never blocks boot on
// its own (the caller decides how to react).

const TRUTHY = new Set(["1", "true", "yes", "on"]);
export function truthy(v) { return TRUTHY.has(String(v ?? "").trim().toLowerCase()); }

// Master switches for the additive platforms — safe production default is OFF.
export const PLATFORM_MASTER_FLAGS = Object.freeze([
  "EXEC_ENABLED", "EXEC_SIDE_EFFECTS_ENABLED", "EI_STUDIO_ENABLED", "EI_V2_ENABLED",
  "EI_EVENT_PIPELINE_ENABLED", "EI_ATTRIBUTION_ENABLED", "EI_EVIDENCE_ENABLED",
  "EI_REASONING_ENABLED", "EI_PREDICTION_ENABLED", "EI_RECOMMENDATION_ENABLED",
  "EI_EXECUTIVE_ENABLED", "EI_NARRATION_ENABLED", "EI_METRICS_ENABLED",
  "EI_OUTCOMES_ENABLED", "EI_EFFECTIVENESS_ENABLED", "EI_VALIDATION_ENABLED",
  "EI_CALIBRATION_ENABLED", "EI_LEARNING_ENABLED", "EI_EXPERIMENTS_ENABLED",
  "EI_MEMORY_ENABLED", "EI_HEALTH_ENABLED",
]);

// Migrations that ship the additive platforms (presence check only — never executed).
export const EXPECTED_MIGRATIONS = Object.freeze([
  "20260707_ei_events.sql", "20260707b_ei_attributions.sql", "20260707c_ei_evidence.sql",
  "20260707d_ei_reasoning_traces.sql", "20260707e_ei_predictions.sql", "20260708a_ei_recommendations.sql",
  "20260708b_ei_outcomes.sql", "20260708c_ei_calibration_models.sql", "20260708d_ei_learning.sql",
  "20260708e_ei_experiments.sql", "20260708f_ei_org_memory.sql", "20260708g_execution_platform.sql",
]);

// Known weak/default secrets (compared by value; the value is NEVER emitted).
const WEAK_SECRETS = new Set(["task_management_secret", "super-secret-token", "secret", "changeme", "password", "test"]);

/** Flag-safety checks (pure). */
export function validateFlagSafety(env = process.env, production = false) {
  const warnings = [];
  const enabled = PLATFORM_MASTER_FLAGS.filter((f) => truthy(env[f]));
  if (truthy(env.EXEC_SIDE_EFFECTS_ENABLED) && !truthy(env.EXEC_ENABLED)) {
    warnings.push("EXEC_SIDE_EFFECTS_ENABLED is set while EXEC_ENABLED is off — side effects cannot run; likely a misconfiguration.");
  }
  if (production && enabled.length) {
    warnings.push(`Non-default platform flags enabled in production: ${enabled.join(", ")}. Confirm each was canary-validated before enabling for all workspaces.`);
  }
  return { warnings, enabled };
}

/**
 * Full startup validation.
 * @param {object} p { env, migrationFiles, isProduction }
 * @returns {{ok, production, errors, warnings, checks}}  — no secret values are included.
 */
export function validateStartup({ env = process.env, migrationFiles = [], isProduction = null } = {}) {
  const production = isProduction != null ? isProduction : ["production", "prod"].includes(String(env.APP_ENV || env.NODE_ENV || "").toLowerCase());
  const errors = [];
  const warnings = [];

  const hasDb = Boolean(env.DATABASE_URL || env.PGDATABASE || env.PGHOST || env.DB_HOST);
  if (!hasDb) (production ? errors : warnings).push("No database configuration found (DATABASE_URL / PG* / DB_HOST).");

  const hasJwt = Boolean(env.JWT_SECRET);
  if (!hasJwt) (production ? errors : warnings).push("JWT_SECRET is not set.");
  else if (WEAK_SECRETS.has(env.JWT_SECRET)) warnings.push("JWT_SECRET is a known weak/default value — rotate before production.");
  if (env.AI_SERVICE_SECRET && WEAK_SECRETS.has(env.AI_SERVICE_SECRET)) warnings.push("AI_SERVICE_SECRET is a known weak/default value — rotate before production.");

  const flags = validateFlagSafety(env, production);
  warnings.push(...flags.warnings);

  const missingMigrations = EXPECTED_MIGRATIONS.filter((f) => !migrationFiles.includes(f));
  if (missingMigrations.length) warnings.push(`Additive migration files not present in bundle: ${missingMigrations.join(", ")}.`);

  return {
    ok: errors.length === 0,
    production,
    errors,
    warnings,
    checks: {
      database: hasDb,
      jwtSecret: hasJwt,
      migrationsPresent: EXPECTED_MIGRATIONS.length - missingMigrations.length,
      migrationsExpected: EXPECTED_MIGRATIONS.length,
      platformFlagsEnabled: flags.enabled,
      safeDefaults: flags.enabled.length === 0,
    },
  };
}
