import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.DATABASE_URL = " ";
process.env.DB_HOST = "localhost";
process.env.DB_PORT = "5432";
process.env.DB_NAME = "asystence_local";
process.env.NODE_ENV = "test";

const root = process.cwd();
const read = (relativePath) => readFileSync(join(root, relativePath), "utf8");

const migration = read("migrations/20260611_huddle_intelligence_worker_framework.sql");
const service = read("services/huddleIntelligence.service.js");
const worker = read("services/huddleIntelligenceWorker.service.js");
const generation = read("services/huddleIntelligenceGeneration.service.js");
const cron = read("cron/huddleIntelligence.cron.js");
const route = read("routes/huddleIntelligence.routes.js");
const compatibility = read("services/huddleCompatibilityAdapter.service.js");
const artifactService = read("services/huddleArtifact.service.js");
const transcriptService = read("services/huddleTranscript.service.js");
const transcriptionPipeline = read("services/huddleTranscriptionPipeline.service.js");
const workflow = read(".github/workflows/deploy.yml");
const packageJson = JSON.parse(read("package.json"));

const {
  getHuddleIntelligenceWorkerDiagnostics,
} = await import("../services/huddleIntelligenceWorker.service.js");

for (const table of [
  "huddle_intelligence_job_attempts",
  "huddle_intelligence_job_dependencies",
]) {
  assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`), `missing ${table}`);
}

for (const column of [
  "lease_expires_at",
  "heartbeat_at",
  "last_recovered_at",
  "attempt_number",
  "depends_on_job_id",
  "dependency_type",
]) {
  assert.match(migration, new RegExp(column), `worker schema missing ${column}`);
}

for (const fn of [
  "heartbeatIntelligenceJob",
  "recoverStaleIntelligenceJobs",
  "listIntelligenceJobAttempts",
  "listIntelligenceJobDependencies",
]) {
  assert.match(service, new RegExp(`export async function ${fn}`), `missing ${fn}`);
}

assert.match(service, /FOR UPDATE SKIP LOCKED/, "job claims and recovery must be concurrency safe");
assert.match(service, /dependency\.dependency_type = 'hard'/, "hard dependencies must gate claims");
assert.match(service, /meeting_digest_generation', 'ownership_resolution'/, "digest and ownership jobs must tolerate terminal failed generation dependencies");
assert.match(service, /upstream\.status IN \('failed', 'cancelled'\)/, "terminal failed dependencies must not strand delivery jobs");
assert.match(service, /upsertMeetingDigest/, "digest jobs must refresh existing digest rows after artifact regeneration");
assert.match(worker, /upsertMeetingDigest/, "worker must call the digest upsert path");
assert.match(service, /UPDATE huddle_meeting_digests/, "meeting digest upsert must refresh the existing canonical digest row");
assert.match(service, /WHERE workspace_id = \$1\s+AND session_id = \$2\s+AND digest_type = \$3/, "meeting digest refresh must target one canonical digest per session/type");
assert.match(service, /values\.slice\(0,\s*12\)/, "meeting digest refresh update must pass only the 12 parameters used by the update SQL");
assert.match(service, /INSERT INTO huddle_meeting_digests/, "meeting digest upsert must insert when no digest row exists");
assert.match(service, /retry_scheduled/, "retry attempts must be auditable");
for (const [name, source] of [
  ["intelligence", service],
  ["artifact", artifactService],
  ["transcript", transcriptService],
  ["transcription pipeline", transcriptionPipeline],
]) {
  assert.match(
    source,
    /\[89ab\]\[0-9a-f\]\{3\}-\[0-9a-f\]\{12\}/,
    `${name} UUID validation must preserve canonical UUID references`
  );
}
assert.match(worker, /processTranscriptFinalization/, "transcript finalization handler required");
assert.match(worker, /enqueueTranscriptWorkflow/, "transcript workflow fan-out required");
assert.match(worker, /ensurePendingArtifact/, "artifact preparation handler required");
assert.match(worker, /generateHuddleArtifact/, "artifact generation handler required");
assert.match(worker, /createOwnershipSuggestions/, "ownership generation handler required");
assert.match(generation, /approvalStatus: "pending"/, "generated intelligence must require approval");
assert.match(generation, /taskCreationEnabled: false/, "task creation must remain disabled");
assert.match(worker, /automaticPromotionEnabled: false/, "memory promotion must remain approval-only");
assert.match(worker, /runHuddleIntelligenceWorkerCycle/, "worker batch runner required");
assert.match(cron, /HUDDLE_INTELLIGENCE_WORKER_ENABLED/, "worker startup must be feature flagged");
assert.match(cron, /runHuddleIntelligenceWorkerCycle/, "cron must execute worker cycles");
assert.match(compatibility, /transcript-workflow:/, "Huddle end must enqueue the transcript workflow");
assert.match(route, /jobs\/:jobId\/attempts/, "attempt audit API required");
assert.match(route, /jobs\/:jobId\/dependencies/, "dependency diagnostics API required");
assert.match(workflow, /HUDDLE_INTELLIGENCE_WORKER_ENABLED=true/, "production worker flag required");
assert.equal(
  packageJson.scripts["migrate:huddle-intelligence-worker"],
  "node --import ./scripts/database-safety-guard.js run-huddle-intelligence-worker-migration.js"
);
assert.equal(
  packageJson.scripts["verify:huddle-intelligence-worker"],
  "node scripts/verify-huddle-intelligence-worker.js"
);

const diagnostics = getHuddleIntelligenceWorkerDiagnostics();
assert.equal(diagnostics.ready, true);
assert.equal(diagnostics.orchestrationEnabled, true);
assert.equal(diagnostics.generationEnabled, false);
assert.equal(diagnostics.retryRecoveryEnabled, true);
assert.equal(diagnostics.dependencySchedulingEnabled, true);
assert.equal(diagnostics.attemptAuditEnabled, true);

console.log("Huddle Intelligence worker verification passed");
