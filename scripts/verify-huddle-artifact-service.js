import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.DATABASE_URL = " ";
process.env.DB_HOST = "localhost";
process.env.DB_PORT = "5432";
process.env.DB_NAME = "asystence_local";
process.env.NODE_ENV = "test";

const root = process.cwd();

function read(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

const migration = read("migrations/20260609_huddle_z_artifact_service.sql");
const service = read("services/huddleArtifact.service.js");
const route = read("routes/huddleArtifact.routes.js");
const index = read("index.js");
const packageJson = JSON.parse(read("package.json"));

const {
  HUDDLE_ARTIFACT_APPROVAL_STATUSES,
  HUDDLE_ARTIFACT_EVENTS,
  HUDDLE_ARTIFACT_PERMISSION_REASONS,
  HUDDLE_ARTIFACT_STATUSES,
  HUDDLE_ARTIFACT_TYPES,
  HUDDLE_ARTIFACT_VISIBILITIES,
  evaluateArtifactPermission,
  getHuddleArtifactDiagnostics,
} = await import("../services/huddleArtifact.service.js");

assert.match(
  migration,
  /ALTER TABLE huddle_artifacts[\s\S]*ADD COLUMN IF NOT EXISTS current_revision/,
  "migration must extend huddle_artifacts with domain columns"
);
for (const token of [
  "approval_status",
  "retention_expires_at",
  "retention_hold",
  "provenance_json",
  "huddle_artifact_revisions",
  "huddle_artifact_sources",
  "huddle_artifact_permissions",
  "transcript_segment_id",
]) {
  assert.match(migration, new RegExp(token), `migration must include ${token}`);
}

for (const artifactType of ["transcript", "summary", "decision", "action_item", "timeline", "memory"]) {
  assert.match(migration, new RegExp(`'${artifactType}'`), `migration must support ${artifactType}`);
}

for (const lifecycleState of ["draft", "pending", "processing", "ready", "failed", "archived", "superseded", "deleted"]) {
  assert.match(migration, new RegExp(`'${lifecycleState}'`), `migration must support ${lifecycleState}`);
}

for (const approvalState of ["not_required", "pending", "approved", "rejected", "revoked"]) {
  assert.match(migration, new RegExp(`'${approvalState}'`), `migration must support approval ${approvalState}`);
}

assert.match(
  migration,
  /huddle_artifact_sources_transcript_segment_session_workspace_fk/,
  "artifact sources must reference transcript segments with workspace/session fencing"
);
assert.match(
  migration,
  /validate_huddle_artifact_permission_ownership/,
  "artifact permissions must validate workspace ownership"
);
assert.match(
  migration,
  /idx_huddle_artifacts_retention/,
  "artifact retention diagnostics must be indexable"
);

for (const fn of [
  "createHuddleArtifact",
  "updateHuddleArtifact",
  "approveHuddleArtifact",
  "rejectHuddleArtifact",
  "getHuddleArtifact",
  "listHuddleArtifacts",
  "listArtifactRevisions",
  "listArtifactSources",
  "addArtifactSources",
  "grantArtifactPermission",
  "listArtifactPermissions",
  "evaluateArtifactPermission",
]) {
  assert.match(service, new RegExp(`export (async )?function ${fn}`), `service must export ${fn}`);
}

assert.equal(HUDDLE_ARTIFACT_TYPES.TRANSCRIPT, "transcript");
assert.equal(HUDDLE_ARTIFACT_TYPES.SUMMARY, "summary");
assert.equal(HUDDLE_ARTIFACT_TYPES.DECISION, "decision");
assert.equal(HUDDLE_ARTIFACT_TYPES.ACTION_ITEM, "action_item");
assert.equal(HUDDLE_ARTIFACT_TYPES.TIMELINE, "timeline");
assert.equal(HUDDLE_ARTIFACT_TYPES.MEMORY, "memory");
assert.equal(HUDDLE_ARTIFACT_STATUSES.READY, "ready");
assert.equal(HUDDLE_ARTIFACT_APPROVAL_STATUSES.APPROVED, "approved");
assert.equal(HUDDLE_ARTIFACT_EVENTS.CREATED, "huddle.artifact.created");

const session = {
  id: "session-a",
  workspace_id: "workspace-a",
  visibility: "session_participants",
  started_by: "host-a",
  host_user_id: "host-a",
};
const participant = {
  id: "participant-a",
  user_id: "user-a",
  join_state: "joined",
  left_at: null,
};
const artifact = {
  id: "artifact-a",
  created_by: "user-a",
  visibility: HUDDLE_ARTIFACT_VISIBILITIES.SESSION_PARTICIPANTS,
  status: HUDDLE_ARTIFACT_STATUSES.READY,
  approval_status: HUDDLE_ARTIFACT_APPROVAL_STATUSES.PENDING,
};

assert.equal(
  evaluateArtifactPermission({
    session,
    participant,
    artifact,
    userId: "user-a",
    role: "user",
    action: "read",
  }).allowed,
  true,
  "session participants must read session artifacts"
);

assert.equal(
  evaluateArtifactPermission({
    session,
    artifact,
    userId: "user-b",
    role: "user",
    action: "read",
  }).reason,
  HUDDLE_ARTIFACT_PERMISSION_REASONS.PARTICIPATION_REQUIRED,
  "non-participants must not read session participant artifacts"
);

assert.equal(
  evaluateArtifactPermission({
    session,
    artifact: {
      ...artifact,
      visibility: HUDDLE_ARTIFACT_VISIBILITIES.PRIVATE,
      created_by: "user-a",
    },
    userId: "user-b",
    role: "user",
    action: "read",
  }).reason,
  HUDDLE_ARTIFACT_PERMISSION_REASONS.PRIVATE_ARTIFACT,
  "private artifacts must stay private without grants"
);

assert.equal(
  evaluateArtifactPermission({
    session,
    artifact: {
      ...artifact,
      visibility: HUDDLE_ARTIFACT_VISIBILITIES.WORKSPACE_ADMINS,
    },
    userId: "admin-a",
    role: "admin",
    action: "read",
  }).allowed,
  true,
  "workspace admins must read admin-scoped artifacts"
);

assert.equal(
  evaluateArtifactPermission({
    session,
    artifact,
    userId: "host-a",
    role: "user",
    action: "approve",
  }).allowed,
  true,
  "Huddle host must be able to approve artifacts"
);

assert.equal(
  evaluateArtifactPermission({
    session,
    artifact,
    userId: "user-b",
    role: "user",
    action: "approve",
  }).reason,
  HUDDLE_ARTIFACT_PERMISSION_REASONS.APPROVAL_FORBIDDEN,
  "ordinary users must not approve artifacts"
);

assert.equal(
  evaluateArtifactPermission({
    session,
    artifact: {
      ...artifact,
      approval_status: HUDDLE_ARTIFACT_APPROVAL_STATUSES.APPROVED,
    },
    userId: "user-a",
    role: "user",
    action: "write",
  }).reason,
  HUDDLE_ARTIFACT_PERMISSION_REASONS.WRITE_FORBIDDEN,
  "approved artifacts must be immutable to non-privileged writers"
);

assert.equal(
  evaluateArtifactPermission({
    session,
    artifact,
    grants: [{ principal_kind: "user", user_id: "user-b", permission: "read" }],
    userId: "user-b",
    role: "user",
    action: "read",
  }).allowed,
  true,
  "explicit grants must allow artifact access"
);

for (const pattern of [
  /router\.get\("\/diagnostics"/,
  /router\.get\("\/sessions\/:sessionId"/,
  /router\.post\("\/sessions\/:sessionId"/,
  /router\.get\("\/:artifactId\/revisions"/,
  /router\.get\("\/:artifactId\/sources"/,
  /router\.post\("\/:artifactId\/sources"/,
  /router\.get\("\/:artifactId\/permissions"/,
  /router\.post\("\/:artifactId\/permissions"/,
  /router\.post\("\/:artifactId\/approve"/,
  /router\.post\("\/:artifactId\/reject"/,
  /router\.patch\("\/:artifactId"/,
]) {
  assert.match(route, pattern, `route missing ${pattern}`);
}

assert.match(
  index,
  /import huddleArtifactRoutes from "\.\/routes\/huddleArtifact\.routes\.js"/,
  "index must import artifact routes"
);
assert.match(
  index,
  /app\.use\("\/huddle\/artifacts", authMiddleware, requireWorkspaceForUser, huddleArtifactRoutes\)/,
  "index must mount artifact routes behind auth and workspace middleware"
);

assert.equal(
  packageJson.scripts["migrate:huddle-artifact-service"],
  "node --import ./scripts/database-safety-guard.js run-huddle-artifact-service-migration.js"
);
assert.equal(
  packageJson.scripts["verify:huddle-artifact-service"],
  "node scripts/verify-huddle-artifact-service.js"
);

const diagnostics = getHuddleArtifactDiagnostics();
assert.equal(diagnostics.ready, true);
assert.deepEqual(diagnostics.canonicalTypes, Object.values(HUDDLE_ARTIFACT_TYPES));
assert.equal(diagnostics.revisionTable, "huddle_artifact_revisions");
assert.equal(diagnostics.sourceTable, "huddle_artifact_sources");
assert.equal(diagnostics.permissionTable, "huddle_artifact_permissions");
assert.equal(diagnostics.aiGenerationEnabled, false);
assert.equal(diagnostics.captionsEnabled, false);
assert.equal(diagnostics.memoryPromotionEnabled, false);

console.log("Huddle artifact service architecture verification passed");
