import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import bcrypt from "bcryptjs";
import pool from "../db.js";
import { getGrowthDashboard } from "../growth/growthDashboard.service.js";
import {
  changeSuperadminPassword,
  isSuperadminSessionActive,
  refreshSuperadminSession,
  resetSuperadminPassword,
  revokeSuperadminSession,
  superadminLogin,
  verifySuperadminAccessToken,
} from "../services/superadmin.service.js";

const migration = fs.readFileSync(
  new URL("../migrations/20260629_superadmin_growth_intelligence.sql", import.meta.url),
  "utf8"
);
const passwordRecoveryMigration = fs.readFileSync(
  new URL("../migrations/20260629_superadmin_password_recovery.sql", import.meta.url),
  "utf8"
);

const DAY_MS = 86_400_000;
// Use an isolated future range so production telemetry cannot affect deterministic assertions.
const now = new Date("2099-06-29T12:00:00.000Z");
const fromDate = new Date(now.getTime() - 6 * DAY_MS).toISOString().slice(0, 10);
const toDate = now.toISOString().slice(0, 10);
const actorId = crypto.randomUUID();
const workspaceId = crypto.randomUUID();
const anonymousId = `validation-${crypto.randomUUID()}`;
const sessionId = `validation-${crypto.randomUUID()}`;

const definitions = [
  ["website.page_view", "website", null, null, "/pricing", "Website"],
  ["product.signup_completed", "acquisition", actorId, workspaceId, null, "Signup"],
  ["product.workspace_created", "activation", actorId, workspaceId, null, "Workspace"],
  ["product.project_created", "activation", actorId, workspaceId, null, "Projects"],
  ["product.task_created", "activation", actorId, workspaceId, null, "Tasks"],
  ["product.team_member_added", "activation", actorId, workspaceId, null, "Team"],
  ["product.chat_message_sent", "engagement", actorId, workspaceId, null, "Chat"],
  ["product.huddle_created", "engagement", actorId, workspaceId, null, "Huddles"],
  ["product.ai_used", "engagement", actorId, workspaceId, null, "AI"],
];

const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query(migration);
  await client.query(passwordRecoveryMigration);

  const validationAdminId = crypto.randomUUID();
  const validationEmail = `validation-${validationAdminId}@example.invalid`;
  const validationPassword = "Validation-Only-Password-42!";
  await client.query(
    "INSERT INTO superadmins (id, email, password_hash) VALUES ($1, $2, $3)",
    [validationAdminId, validationEmail, await bcrypt.hash(validationPassword, 4)]
  );
  const login = await superadminLogin(validationEmail, validationPassword, {
    database: client,
    ipAddress: "127.0.0.1",
    userAgent: "transactional-validation",
  });
  assert.equal(login.superadmin.id, validationAdminId);
  assert.equal(verifySuperadminAccessToken(login.token).type, "superadmin");
  const refreshed = await refreshSuperadminSession(login.refreshToken, {
    database: client,
    ipAddress: "127.0.0.1",
    userAgent: "transactional-validation",
  });
  assert.notEqual(refreshed.token, login.token);
  await revokeSuperadminSession(login.refreshToken, client);
  await assert.rejects(
    () => refreshSuperadminSession(login.refreshToken, { database: client }),
    /expired or invalid/
  );

  const resetSourceSession = await superadminLogin(validationEmail, validationPassword, {
    database: client,
  });
  const resetSourceClaims = verifySuperadminAccessToken(resetSourceSession.token);
  assert.equal(
    await isSuperadminSessionActive(validationAdminId, resetSourceClaims.sid, client),
    true
  );
  const resetToken = crypto.randomBytes(32).toString("base64url");
  const resetTokenHash = crypto.createHash("sha256").update(resetToken).digest("hex");
  await client.query(
    `INSERT INTO superadmin_password_reset_tokens
       (superadmin_id, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '1 hour')`,
    [validationAdminId, resetTokenHash]
  );
  const resetPassword = "Reset-Validation-Password-43!";
  await resetSuperadminPassword(resetToken, resetPassword, { database: client });
  assert.equal(
    await isSuperadminSessionActive(validationAdminId, resetSourceClaims.sid, client),
    false
  );
  assert.equal(await superadminLogin(validationEmail, validationPassword, { database: client }), null);
  await assert.rejects(
    () => refreshSuperadminSession(resetSourceSession.refreshToken, { database: client }),
    /expired or invalid/
  );
  await assert.rejects(
    () => resetSuperadminPassword(resetToken, "Another-Validation-Password-44!", { database: client }),
    /Invalid or expired/
  );

  const resetLogin = await superadminLogin(validationEmail, resetPassword, { database: client });
  assert.equal(resetLogin.superadmin.id, validationAdminId);
  const finalPassword = "Final-Validation-Password-45!";
  await changeSuperadminPassword(validationAdminId, resetPassword, finalPassword, {
    database: client,
  });
  assert.equal(await superadminLogin(validationEmail, resetPassword, { database: client }), null);
  await assert.rejects(
    () => refreshSuperadminSession(resetLogin.refreshToken, { database: client }),
    /expired or invalid/
  );
  const finalLogin = await superadminLogin(validationEmail, finalPassword, { database: client });
  assert.equal(finalLogin.superadmin.id, validationAdminId);
  await revokeSuperadminSession(finalLogin.refreshToken, client);

  for (const [eventName, category, eventActor, eventWorkspace, pagePath, featureName] of definitions) {
    await client.query(
      `INSERT INTO growth_events
         (id, event_name, category, source, actor_user_id, workspace_id, anonymous_id,
          session_id, page_path, landing_page, traffic_source, device_type, browser,
          country_code, properties, occurred_at)
       VALUES ($1, $2, $3, 'server', $4, $5, $6, $7, $8, $9, 'direct', 'desktop',
               'Chrome', 'IN', $10::jsonb, $11)
       ON CONFLICT (id) DO NOTHING`,
      [
        crypto.randomUUID(), eventName, category, eventActor, eventWorkspace,
        anonymousId, sessionId, pagePath, pagePath,
        JSON.stringify({ feature_name: featureName }), now,
      ]
    );
  }

  await client.query(
    `INSERT INTO growth_events
       (id, event_name, category, source, actor_user_id, workspace_id, properties, occurred_at)
     VALUES ($1, 'product.feature_used', 'engagement', 'server', $2, $3, $4::jsonb, $5)`,
    [crypto.randomUUID(), actorId, workspaceId, JSON.stringify({ feature_name: "Projects" }), new Date(now.getTime() - 8 * DAY_MS)]
  );

  const dashboard = await getGrowthDashboard({ from: fromDate, to: toDate }, client);
  assert.equal(dashboard.overview.page_views, 1);
  assert.equal(dashboard.overview.signups, 1);
  assert.equal(dashboard.overview.active_users, 1);
  assert.equal(dashboard.overview.returning_users, 1);
  assert.equal(dashboard.funnel.find((stage) => stage.key === "product.activation_reached")?.count, 1);
  assert.ok(dashboard.engagement.feature_adoption.length >= 3);
  assert.ok(dashboard.insights.length >= 2);
  assert.equal(dashboard.intelligence.ai_extension_ready, true);

  console.log(JSON.stringify({
    transactionalDatabaseValidation: "passed",
    committed: false,
    superadminLoginRefreshLogoutContract: "passed",
    superadminResetAndChangePasswordContract: "passed",
    overview: dashboard.overview,
    funnelStages: dashboard.funnel.length,
    featureRows: dashboard.engagement.feature_adoption.length,
    insightRows: dashboard.insights.length,
  }, null, 2));
} finally {
  await client.query("ROLLBACK").catch(() => {});
  client.release();
  await pool.end();
}
