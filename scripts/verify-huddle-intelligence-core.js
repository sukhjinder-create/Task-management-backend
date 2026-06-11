import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.DATABASE_URL = " ";
process.env.DB_HOST = "localhost";
process.env.DB_PORT = "5432";
process.env.DB_NAME = "asystence_local";
process.env.NODE_ENV = "test";

const root = process.cwd();
const suiteArg = process.argv.find((arg) => arg.startsWith("--suite="));
const requestedSuite = suiteArg ? suiteArg.split("=")[1] : "all";

function read(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function shouldRun(name) {
  return requestedSuite === "all" || requestedSuite === name;
}

const migration = read("migrations/20260609_huddle_zz_intelligence_core.sql");
const service = read("services/huddleIntelligence.service.js");
const worker = read("services/huddleIntelligenceWorker.service.js");
const route = read("routes/huddleIntelligence.routes.js");
const index = read("index.js");
const packageJson = JSON.parse(read("package.json"));

const {
  HUDDLE_INTELLIGENCE_JOB_STATUSES,
  HUDDLE_INTELLIGENCE_JOB_TYPES,
  HUDDLE_TRANSCRIPT_PROCESSING_STATUSES,
  getHuddleIntelligenceDiagnostics,
} = await import("../services/huddleIntelligence.service.js");
const {
  getHuddleIntelligenceWorkerDiagnostics,
} = await import("../services/huddleIntelligenceWorker.service.js");

function verifySchemaCore() {
  for (const table of [
    "huddle_intelligence_jobs",
    "huddle_transcript_processing_state",
    "huddle_speaker_attributions",
    "huddle_caption_events",
    "huddle_timeline_entries",
    "huddle_ownership_resolutions",
    "huddle_memory_candidates",
    "huddle_meeting_digests",
    "huddle_intelligence_consent_records",
    "huddle_intelligence_retention_policies",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`), `missing ${table}`);
  }
  assert.match(index, /huddleIntelligenceRoutes/, "index must import huddle intelligence routes");
  assert.match(
    index,
    /app\.use\("\/huddle\/intelligence", authMiddleware, requireWorkspaceForUser, huddleIntelligenceRoutes\)/,
    "intelligence APIs must be mounted behind auth and workspace middleware"
  );
  assert.match(route, /allowRoles\("admin", "manager", "owner"\)/, "intelligence write APIs must be admin/manager/owner gated");
  assert.match(route, /if \(\["GET", "HEAD", "OPTIONS"\]\.includes\(req\.method\)\)/, "intelligence read APIs must remain workspace-readable");
  assert.equal(
    packageJson.scripts["migrate:huddle-intelligence-core"],
    "node --import ./scripts/database-safety-guard.js run-huddle-intelligence-core-migration.js"
  );
  assert.equal(
    packageJson.scripts["verify:huddle-intelligence-core"],
    "node scripts/verify-huddle-intelligence-core.js"
  );
}

function verifyJobs() {
  for (const jobType of [
    "transcript_finalization",
    "caption_generation",
    "summary_generation",
    "decision_extraction",
    "action_item_extraction",
    "ownership_resolution",
    "timeline_generation",
    "memory_promotion",
    "meeting_digest_generation",
  ]) {
    assert.match(migration, new RegExp(`'${jobType}'`), `missing job type ${jobType}`);
  }
  for (const status of ["queued", "processing", "completed", "failed", "cancelled"]) {
    assert.match(migration, new RegExp(`'${status}'`), `missing job status ${status}`);
  }
  for (const fn of [
    "enqueueIntelligenceJob",
    "getIntelligenceJob",
    "listIntelligenceJobs",
    "claimNextIntelligenceJob",
    "completeIntelligenceJob",
    "failIntelligenceJob",
    "cancelIntelligenceJob",
  ]) {
    assert.match(service, new RegExp(`export async function ${fn}`), `missing ${fn}`);
  }
  assert.match(migration, /attempt_count/, "jobs must track attempts");
  assert.match(migration, /max_attempts/, "jobs must support retry limits");
  assert.match(migration, /idempotency_key/, "jobs must support idempotency");
  assert.match(migration, /provenance_json/, "jobs must support provenance");
  assert.match(worker, /generationEnabled: false/, "worker must not enable generation");
  assert.match(worker, /orchestrationEnabled: true/, "worker must enable durable orchestration");
  assert.match(worker, /generationState: "awaiting_generator"/, "generation jobs must remain explicitly pending");
}

function verifyTranscriptProcessing() {
  for (const status of ["idle", "ingesting", "partial", "finalizing", "finalized", "retracted", "failed"]) {
    assert.match(migration, new RegExp(`'${status}'`), `missing transcript processing status ${status}`);
  }
  assert.match(service, /updateTranscriptProcessingState/, "service must update transcript processing state");
  assert.match(service, /getTranscriptProcessingState/, "service must retrieve transcript processing state");
  assert.match(route, /\/sessions\/:sessionId\/transcript-processing/, "API must expose transcript processing state");
  assert.equal(HUDDLE_TRANSCRIPT_PROCESSING_STATUSES.FINALIZED, "finalized");
}

function verifySpeakerAttribution() {
  for (const token of [
    "participant_id",
    "participant_device_id",
    "provider_identity_id",
    "confidence",
    "correction_of_id",
    "corrected_by",
    "provider_speaker_id",
  ]) {
    assert.match(migration, new RegExp(token), `speaker attribution missing ${token}`);
  }
  assert.match(service, /recordSpeakerAttribution/, "service must record speaker attribution");
  assert.match(route, /speaker-attributions/, "API must expose speaker attribution");
}

function verifyCaptionArchitecture() {
  for (const token of ["caption_text", "partial", "final", "retracted", "replayable", "sequence_number"]) {
    assert.match(migration, new RegExp(token), `caption architecture missing ${token}`);
  }
  assert.match(service, /createCaptionEvent/, "service must create caption events");
  assert.match(service, /listCaptionEvents/, "service must replay caption events");
  assert.match(route, /\/sessions\/:sessionId\/captions/, "API must expose captions");
}

function verifyArtifactLifecycle() {
  for (const token of [
    "artifact_id",
    "output_artifact_id",
    "transcript_segment_id",
    "summary_generation",
    "decision_extraction",
    "action_item_extraction",
    "timeline_generation",
    "memory_promotion",
  ]) {
    assert.match(migration, new RegExp(token), `artifact lifecycle integration missing ${token}`);
  }
  assert.match(route, /artifacts\/:artifactId\/processing/, "API must expose artifact processing state");
}

function verifyTimeline() {
  for (const entryType of ["transcript", "decision", "action_item", "join", "leave", "milestone"]) {
    assert.match(migration, new RegExp(`'${entryType}'`), `timeline missing entry type ${entryType}`);
  }
  assert.match(service, /createTimelineEntry/, "service must create timeline entries");
  assert.match(service, /listTimelineEntries/, "service must list timeline entries");
  assert.match(route, /\/sessions\/:sessionId\/timeline/, "API must expose timeline retrieval");
}

function verifyOwnership() {
  for (const token of [
    "suggested_owner_user_id",
    "confidence",
    "approval_required",
    "reassigned",
    "rejected",
  ]) {
    assert.match(migration, new RegExp(token), `ownership framework missing ${token}`);
  }
  assert.match(service, /createOwnershipResolution/, "service must create ownership resolutions");
  assert.match(route, /\/sessions\/:sessionId\/ownership/, "API must expose ownership framework");
}

function verifyMemoryPromotion() {
  for (const token of [
    "huddle_memory_candidates",
    "candidate_text",
    "pending_approval",
    "promoted_memory_id",
    "memory_promotion",
  ]) {
    assert.match(migration, new RegExp(token), `memory promotion framework missing ${token}`);
  }
  assert.match(service, /createMemoryCandidate/, "service must create memory candidates");
  assert.match(route, /memory-candidates/, "API must expose memory candidates");
}

function verifyDigestConsentRetention() {
  for (const token of [
    "huddle_meeting_digests",
    "summary_artifact_id",
    "decisions_artifact_id",
    "actions_artifact_id",
    "timeline_artifact_id",
    "huddle_intelligence_consent_records",
    "transcription",
    "ai_processing",
    "memory_promotion",
    "huddle_intelligence_retention_policies",
    "retention_days",
    "legal_hold",
  ]) {
    assert.match(migration, new RegExp(token), `digest/consent/retention missing ${token}`);
  }
  assert.match(route, /\/sessions\/:sessionId\/digests/, "API must expose meeting digests");
  assert.match(route, /\/sessions\/:sessionId\/consent/, "API must expose consent records");
  assert.match(route, /\/sessions\/:sessionId\/retention/, "API must expose retention policies");
}

function verifyDiagnostics() {
  const diagnostics = getHuddleIntelligenceDiagnostics();
  assert.equal(diagnostics.ready, true);
  assert.equal(diagnostics.separatedFromMedia, true);
  assert.equal(diagnostics.generationEnabled, false);
  assert.equal(diagnostics.sttProviderEnabled, true);
  assert.equal(diagnostics.captionsUiEnabled, true);
  assert.equal(diagnostics.memoryPromotionEnabled, false);
  assert.equal(diagnostics.taskCreationEnabled, false);
  assert.deepEqual(diagnostics.jobTypes, Object.values(HUDDLE_INTELLIGENCE_JOB_TYPES));
  assert.deepEqual(diagnostics.jobStatuses, Object.values(HUDDLE_INTELLIGENCE_JOB_STATUSES));

  const workerDiagnostics = getHuddleIntelligenceWorkerDiagnostics();
  assert.equal(workerDiagnostics.ready, true);
  assert.equal(workerDiagnostics.architectureOnly, false);
  assert.equal(workerDiagnostics.orchestrationEnabled, true);
  assert.equal(workerDiagnostics.generationEnabled, false);
  assert.equal(workerDiagnostics.sttProviderEnabled, true);
  assert.equal(workerDiagnostics.retryRecoveryEnabled, true);
  assert.equal(workerDiagnostics.dependencySchedulingEnabled, true);
}

verifySchemaCore();
if (shouldRun("jobs")) verifyJobs();
if (shouldRun("transcript-processing")) verifyTranscriptProcessing();
if (shouldRun("speaker-attribution")) verifySpeakerAttribution();
if (shouldRun("artifact-lifecycle")) verifyArtifactLifecycle();
if (shouldRun("timeline")) verifyTimeline();
if (shouldRun("memory-promotion")) verifyMemoryPromotion();
if (shouldRun("ownership")) verifyOwnership();
if (requestedSuite === "all") {
  verifyJobs();
  verifyTranscriptProcessing();
  verifySpeakerAttribution();
  verifyCaptionArchitecture();
  verifyArtifactLifecycle();
  verifyTimeline();
  verifyOwnership();
  verifyMemoryPromotion();
  verifyDigestConsentRetention();
  verifyDiagnostics();
}

console.log(`Huddle Intelligence Core verification passed (${requestedSuite})`);
