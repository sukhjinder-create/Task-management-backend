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

const migration = read("migrations/20260609_huddle_zzz_transcription_caption_foundation.sql");
const sttProvider = read("services/huddleSttProvider.service.js");
const pipeline = read("services/huddleTranscriptionPipeline.service.js");
const route = read("routes/huddleTranscription.routes.js");
const index = read("index.js");
const compatibilityAdapter = read("services/huddleCompatibilityAdapter.service.js");
const packageJson = JSON.parse(read("package.json"));
const deployWorkflow = read(".github/workflows/deploy.yml");

const {
  HUDDLE_STT_PROVIDERS,
  buildDeepgramListenUrl,
  getHuddleSttProviderDiagnostics,
} = await import("../services/huddleSttProvider.service.js");
const {
  getHuddleTranscriptionDiagnostics,
} = await import("../services/huddleTranscriptionPipeline.service.js");

function verifySchema() {
  for (const table of [
    "huddle_transcription_policies",
    "huddle_transcription_sessions",
    "huddle_transcription_provider_events",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`), `missing ${table}`);
  }
  for (const token of [
    "workspace_id",
    "session_id",
    "provider_name",
    "require_consent",
    "retention_days",
    "partial_segment_count",
    "final_segment_count",
    "caption_event_count",
    "speaker_attribution_id",
    "provider_payload",
  ]) {
    assert.match(migration, new RegExp(token), `schema missing ${token}`);
  }
  for (const status of ["pending", "active", "paused", "finalizing", "finalized", "failed", "cancelled"]) {
    assert.match(migration, new RegExp(`'${status}'`), `missing transcription session status ${status}`);
  }
  for (const eventType of ["token_granted", "partial", "final", "retracted", "provider_error", "session_started", "session_finalized"]) {
    assert.match(migration, new RegExp(`'${eventType}'`), `missing provider event type ${eventType}`);
  }
}

function verifyProviderAbstraction() {
  for (const provider of ["deepgram", "openai", "groq", "assemblyai", "livekit_native", "mock"]) {
    assert.match(sttProvider, new RegExp(provider), `provider contract missing ${provider}`);
    assert.match(migration, new RegExp(`'${provider}'`), `schema provider check missing ${provider}`);
  }
  assert.equal(HUDDLE_STT_PROVIDERS.DEEPGRAM, "deepgram");
  assert.match(sttProvider, /createSttProviderGrant/, "provider abstraction must expose grant creation");
  assert.match(sttProvider, /buildDeepgramListenUrl/, "Deepgram listen URL builder required");
  assert.match(sttProvider, /DEEPGRAM_API_KEY/, "Deepgram API key must be env-driven");
  assert.match(sttProvider, /HUDDLE_TRANSCRIPTION_PROVIDER/, "selected provider must be env-driven");
  assert.match(sttProvider, /stt_provider_not_implemented/, "future providers must fail explicitly");
  const multilingualUrl = new URL(buildDeepgramListenUrl({
    model: "nova-3",
    language: "multi",
  }));
  assert.equal(multilingualUrl.searchParams.get("language"), "multi");
  assert.equal(multilingualUrl.searchParams.get("endpointing"), "100");
}

function verifyIngestionPipeline() {
  for (const fn of [
    "grantTranscriptionProviderToken",
    "ingestTranscriptionProviderEvent",
    "normalizeTranscriptionProviderEvent",
  ]) {
    assert.match(pipeline, new RegExp(`export (async )?function ${fn}`), `missing ${fn}`);
  }
  assert.match(pipeline, /createTranscriptSegment/, "ingestion must create canonical transcript segments");
  assert.match(pipeline, /updateTranscriptSegment/, "ingestion must support revisions/retractions");
  assert.match(pipeline, /recordSpeakerAttribution/, "ingestion must record speaker attribution");
  assert.match(pipeline, /createCaptionEvent/, "ingestion must emit caption events");
  assert.match(pipeline, /updateTranscriptProcessingState/, "ingestion must update transcript processing state");
  assert.match(pipeline, /findSegmentBySource/, "provider source segments must be idempotent");
  assert.match(pipeline, /huddle_transcription_provider_events/, "provider event audit trail required");
}

function verifyConsentRetentionFinalization() {
  assert.match(pipeline, /huddle_intelligence_consent_records/, "consent records must gate transcription when required");
  assert.match(pipeline, /requireConsent/, "policy must support consent requirement");
  assert.match(pipeline, /retentionExpiresAt/, "retention expiry must be calculated for transcript artifacts");
  assert.match(pipeline, /createHuddleArtifact/, "finalization must create transcript artifact through artifact service");
  assert.match(pipeline, /artifactType: "transcript"/, "finalization must create transcript artifacts only");
  assert.match(pipeline, /sourceKind: "transcript_segment"/, "artifact provenance must link transcript segments");
  assert.match(compatibilityAdapter, /finalizeHuddleTranscript/, "Huddle end path must trigger transcript finalization");
}

function verifyApis() {
  assert.match(index, /huddleTranscriptionRoutes/, "index must import huddle transcription routes");
  assert.match(
    index,
    /app\.use\("\/huddle\/transcription", authMiddleware, requireWorkspaceForUser, huddleTranscriptionRoutes\)/,
    "transcription APIs must be mounted behind auth and workspace middleware"
  );
  for (const routePattern of [
    "/diagnostics",
    "/sessions/:sessionId/diagnostics",
    "/sessions/:sessionId/policy",
    "/workspace/policy",
    "/sessions/:sessionId/grant",
    "/sessions/:sessionId/events",
    "/sessions/:sessionId/finalize",
  ]) {
    assert.match(route, new RegExp(routePattern.replace(/[/:]/g, (value) => value === "/" ? "\\/" : ".+")), `missing route ${routePattern}`);
  }
  assert.match(route, /allowRoles\("admin", "manager", "owner"\)/, "policy/finalize writes must be role-gated");
}

function verifyDeploymentWiring() {
  assert.equal(
    packageJson.scripts["migrate:huddle-transcription-caption-foundation"],
    "node --import ./scripts/database-safety-guard.js run-huddle-transcription-caption-foundation-migration.js"
  );
  assert.equal(
    packageJson.scripts["verify:huddle-transcription-caption-foundation"],
    "node scripts/verify-huddle-transcription-caption-foundation.js"
  );
  for (const script of [
    "verify:huddle-stt-provider",
    "verify:huddle-transcript-ingestion",
    "verify:huddle-caption-events",
    "verify:huddle-transcription-speaker-attribution",
    "verify:huddle-transcript-finalization",
    "verify:huddle-transcription-consent",
    "verify:huddle-transcription-retention",
  ]) {
    assert.match(packageJson.scripts[script] || "", /verify-huddle-transcription-caption-foundation\.js/, `missing ${script}`);
  }
  for (const envName of [
    "HUDDLE_TRANSCRIPTION_ENABLED",
    "HUDDLE_TRANSCRIPTION_PROVIDER",
    "HUDDLE_TRANSCRIPTION_MODEL",
    "HUDDLE_TRANSCRIPTION_LANGUAGE",
    "HUDDLE_CAPTIONS_ENABLED",
    "HUDDLE_TRANSCRIPT_ARTIFACTS_ENABLED",
    "DEEPGRAM_API_KEY",
  ]) {
    assert.match(deployWorkflow, new RegExp(envName), `deploy workflow missing ${envName}`);
  }
}

function verifyDiagnostics() {
  process.env.HUDDLE_TRANSCRIPTION_ENABLED = "true";
  process.env.HUDDLE_TRANSCRIPTION_PROVIDER = "deepgram";
  process.env.DEEPGRAM_API_KEY = "test";
  const providerDiagnostics = getHuddleSttProviderDiagnostics();
  assert.equal(providerDiagnostics.ready, true);
  assert.equal(providerDiagnostics.provider, "deepgram");
  assert.equal(providerDiagnostics.productionProvider, "deepgram");

  const transcriptionDiagnostics = getHuddleTranscriptionDiagnostics();
  assert.equal(transcriptionDiagnostics.ready, true);
  assert.equal(transcriptionDiagnostics.providerNeutral, true);
  assert.equal(transcriptionDiagnostics.productionProvider, "deepgram");
  assert.equal(transcriptionDiagnostics.canonicalStores.transcriptSegments, "huddle_transcript_segments");
  assert.equal(transcriptionDiagnostics.canonicalStores.captionEvents, "huddle_caption_events");
}

function verifyRestrictions() {
  for (const forbidden of [
    "summary_generation",
    "decision_extraction",
    "action_item_extraction",
    "memory_promotion",
    "createTask",
    "OpenAI",
    "Groq",
  ]) {
    assert.doesNotMatch(pipeline, new RegExp(forbidden, "i"), `pipeline must not implement ${forbidden}`);
  }
}

verifySchema();
if (shouldRun("stt-provider")) verifyProviderAbstraction();
if (shouldRun("transcript-ingestion")) verifyIngestionPipeline();
if (shouldRun("caption-events")) verifyIngestionPipeline();
if (shouldRun("speaker-attribution")) verifyIngestionPipeline();
if (shouldRun("transcript-finalization")) verifyConsentRetentionFinalization();
if (shouldRun("consent")) verifyConsentRetentionFinalization();
if (shouldRun("retention")) verifyConsentRetentionFinalization();

if (requestedSuite === "all") {
  verifyProviderAbstraction();
  verifyIngestionPipeline();
  verifyConsentRetentionFinalization();
  verifyApis();
  verifyDeploymentWiring();
  verifyDiagnostics();
  verifyRestrictions();
}

console.log(`Huddle transcription and caption foundation verification passed (${requestedSuite})`);
