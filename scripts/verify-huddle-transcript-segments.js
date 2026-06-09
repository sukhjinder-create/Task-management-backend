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

const migration = read("migrations/20260609_huddle_transcript_segments.sql");
const service = read("services/huddleTranscript.service.js");
const route = read("routes/huddleTranscript.routes.js");
const index = read("index.js");
const packageJson = JSON.parse(read("package.json"));

const {
  HUDDLE_TRANSCRIPT_EVENTS,
  HUDDLE_TRANSCRIPT_PERMISSION_REASONS,
  HUDDLE_TRANSCRIPT_SEGMENT_STATUSES,
  evaluateTranscriptPermission,
  getHuddleTranscriptDiagnostics,
} = await import("../services/huddleTranscript.service.js");

assert.match(
  migration,
  /CREATE TABLE IF NOT EXISTS huddle_transcript_segments/,
  "migration must create first-class transcript segment persistence"
);
for (const column of [
  "workspace_id",
  "session_id",
  "participant_id",
  "participant_device_id",
  "speaker_kind",
  "speaker_user_id",
  "speaker_guest_id",
  "speaker_label",
  "source_provider",
  "source_segment_id",
  "source_event_id",
  "language",
  "transcript_text",
  "status",
  "confidence",
  "started_at",
  "ended_at",
  "finalized_at",
  "sequence_number",
  "revision",
  "metadata",
]) {
  assert.match(migration, new RegExp(`\\b${column}\\b`), `migration must include ${column}`);
}

assert.match(
  migration,
  /CHECK \(status IN \('partial', 'final', 'retracted'\)\)/,
  "migration must constrain partial/final/retracted lifecycle"
);
assert.match(
  migration,
  /confidence >= 0 AND confidence <= 1/,
  "migration must constrain confidence to 0..1"
);
assert.match(
  migration,
  /uniq_huddle_transcript_segments_source/,
  "migration must support source-provider idempotency"
);
assert.match(
  migration,
  /huddle_transcript_segments_session_workspace_fk/,
  "migration must enforce session/workspace ownership"
);
assert.match(
  migration,
  /validate_huddle_transcript_segment_ownership/,
  "migration must validate participant, event, speaker, and device ownership"
);
assert.match(
  migration,
  /idx_huddle_transcript_segments_search/,
  "migration must support transcript search indexing"
);

for (const fn of [
  "createTranscriptSegment",
  "updateTranscriptSegment",
  "finalizeTranscriptSegment",
  "listTranscriptSegments",
  "listTranscriptEvents",
  "getTranscriptSegment",
  "evaluateTranscriptPermission",
]) {
  assert.match(service, new RegExp(`export (async )?function ${fn}`), `service must export ${fn}`);
}

assert.equal(HUDDLE_TRANSCRIPT_SEGMENT_STATUSES.PARTIAL, "partial");
assert.equal(HUDDLE_TRANSCRIPT_SEGMENT_STATUSES.FINAL, "final");
assert.equal(HUDDLE_TRANSCRIPT_EVENTS.SEGMENT_CREATED, "huddle.transcript.segment_created");
assert.equal(HUDDLE_TRANSCRIPT_EVENTS.SEGMENT_UPDATED, "huddle.transcript.segment_updated");
assert.equal(HUDDLE_TRANSCRIPT_EVENTS.SEGMENT_FINALIZED, "huddle.transcript.segment_finalized");

const privateSession = {
  id: "session-a",
  workspace_id: "workspace-a",
  visibility: "session_participants",
  started_by: "user-host",
  host_user_id: "user-host",
};
const workspaceSession = {
  ...privateSession,
  visibility: "workspace",
};
const participant = {
  id: "participant-a",
  user_id: "user-a",
  join_state: "joined",
  left_at: null,
};

assert.equal(
  evaluateTranscriptPermission({
    session: privateSession,
    userId: "user-outsider",
    role: "user",
    action: "read",
  }).reason,
  HUDDLE_TRANSCRIPT_PERMISSION_REASONS.PARTICIPATION_REQUIRED,
  "private transcript reads must require participation"
);
assert.equal(
  evaluateTranscriptPermission({
    session: workspaceSession,
    userId: "user-outsider",
    role: "user",
    action: "read",
  }).allowed,
  true,
  "workspace-visible transcript reads must remain additive for workspace members"
);
assert.equal(
  evaluateTranscriptPermission({
    session: privateSession,
    participant,
    userId: "user-a",
    role: "user",
    action: "write",
    targetSpeakerUserId: "user-a",
    targetParticipantId: "participant-a",
  }).allowed,
  true,
  "joined participants must be able to write their own transcript segments"
);
assert.equal(
  evaluateTranscriptPermission({
    session: privateSession,
    userId: "user-outsider",
    role: "user",
    action: "write",
  }).reason,
  HUDDLE_TRANSCRIPT_PERMISSION_REASONS.WRITE_PARTICIPATION_REQUIRED,
  "non-participants must not write transcript segments"
);
assert.equal(
  evaluateTranscriptPermission({
    session: privateSession,
    participant,
    userId: "user-a",
    role: "user",
    action: "write",
    targetSpeakerUserId: "user-b",
  }).reason,
  HUDDLE_TRANSCRIPT_PERMISSION_REASONS.ATTRIBUTION_FORBIDDEN,
  "non-privileged participants must not attribute speech to another user"
);
assert.equal(
  evaluateTranscriptPermission({
    session: privateSession,
    userId: "admin-a",
    role: "admin",
    action: "write",
    targetSpeakerUserId: "user-b",
  }).allowed,
  true,
  "privileged roles must support correction/provider ingestion workflows"
);
assert.equal(
  evaluateTranscriptPermission({
    session: privateSession,
    userId: "user-host",
    role: "user",
    action: "write",
    targetSpeakerUserId: "user-host",
  }).allowed,
  true,
  "session host must be able to write transcript segments"
);

assert.match(route, /router\.get\("\/diagnostics"/, "route must expose diagnostics");
assert.match(route, /router\.get\("\/sessions\/:sessionId\/segments"/, "route must list segments");
assert.match(route, /router\.post\("\/sessions\/:sessionId\/segments"/, "route must create segments");
assert.match(route, /router\.get\("\/sessions\/:sessionId\/events"/, "route must list transcript events");
assert.match(route, /router\.patch\("\/segments\/:segmentId"/, "route must update segments");
assert.match(route, /router\.post\("\/segments\/:segmentId\/finalize"/, "route must finalize segments");

assert.match(
  index,
  /import huddleTranscriptRoutes from "\.\/routes\/huddleTranscript\.routes\.js"/,
  "index must import transcript routes"
);
assert.match(
  index,
  /app\.use\("\/huddle\/transcripts", authMiddleware, requireWorkspaceForUser, huddleTranscriptRoutes\)/,
  "index must mount transcript routes behind auth and workspace middleware"
);

assert.equal(
  packageJson.scripts["migrate:huddle-transcript-segments"],
  "node --import ./scripts/database-safety-guard.js run-huddle-transcript-segments-migration.js"
);
assert.equal(
  packageJson.scripts["verify:huddle-transcript-segments"],
  "node scripts/verify-huddle-transcript-segments.js"
);

const diagnostics = getHuddleTranscriptDiagnostics();
assert.equal(diagnostics.ready, true);
assert.equal(diagnostics.aiGenerationEnabled, false);
assert.equal(diagnostics.captionsEnabled, false);
assert.deepEqual(
  diagnostics.eventTypes,
  Object.values(HUDDLE_TRANSCRIPT_EVENTS),
  "diagnostics must expose transcript event model"
);

console.log("Huddle transcript segment architecture verification passed");
