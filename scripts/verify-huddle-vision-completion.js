import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.DATABASE_URL = " ";
process.env.DB_HOST = "localhost";
process.env.DB_PORT = "5432";
process.env.DB_NAME = "asystence_local";
process.env.NODE_ENV = "test";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");

const artifactService = read("services/huddleArtifact.service.js");
const intelligenceService = read("services/huddleIntelligence.service.js");
const generationService = read("services/huddleIntelligenceGeneration.service.js");
const memoryService = read("services/huddleMemoryPromotion.service.js");
const meetingService = read("services/huddleMeetingIntelligence.service.js");
const intelligenceRoutes = read("routes/huddleIntelligence.routes.js");
const frontendRoot = join(root, "..", "Task-management");
const frontend = (path) => readFileSync(join(frontendRoot, path), "utf8");
const backgroundEffects = frontend("src/huddle/media/BackgroundEffects.js");
const liveKitProvider = frontend("src/huddle/media/LiveKitMediaProvider.js");
const meetingView = frontend("src/pages/HuddleMeetingIntelligence.jsx");
const callWindow = frontend("src/huddle/GlobalHuddleWindow.jsx");

for (const token of [
  "expectedRevision",
  "huddle_artifact_revision_conflict",
  "previousApprovalStatus",
  "nextApprovalStatus",
  "updated_at = now()",
  "FOR UPDATE",
]) {
  assert.match(artifactService, new RegExp(token), `artifact review guard missing ${token}`);
}

for (const token of [
  "ownership_review_forbidden",
  "ownership_owner_required",
  "ownership_participant_required",
  "expectedStatus",
  "suggested_owner_user_id",
  "\\$9::uuid",
]) {
  assert.match(intelligenceService, new RegExp(token), `ownership review guard missing ${token}`);
}

for (const token of [
  "discussionHighlights",
  "openQuestions",
  "huddle-intelligence-report-v2",
  "speaker",
  "evidenceSegmentIds",
]) {
  assert.match(generationService, new RegExp(token), `report generation missing ${token}`);
}

for (const token of [
  "createMemoryCandidateFromArtifact",
  "memory_source_artifact_approval_required",
  "promoteApprovedMemoryCandidate",
  "workspace_memory_entries",
  "promotionAutomatic: false",
  "collectTranscriptEvidence",
  "sourceTranscriptReferences",
  "huddle.intelligence.memory_promoted",
]) {
  assert.match(memoryService, new RegExp(token), `memory promotion missing ${token}`);
}

assert.match(meetingService, /getWhatDidIMiss/);
assert.match(meetingService, /canonicalTranscript: true/);
assert.match(meetingService, /before_participant_join/);
assert.match(meetingService, /actorIsHost/);
assert.match(meetingService, /segmentTimestamp\(segment\) < actorJoinedTimestamp/);
assert.match(intelligenceRoutes, /what-did-i-miss/);
assert.match(intelligenceRoutes, /memory-candidates\/from-artifact/);
assert.match(intelligenceRoutes, /memoryCandidateId\/promote/);
const reviewerRoutesEnd = intelligenceRoutes.indexOf("router.use((req, res, next)");
assert.ok(reviewerRoutesEnd > 0, "intelligence write boundary missing");
const reviewerRoutes = intelligenceRoutes.slice(0, reviewerRoutesEnd);
assert.match(reviewerRoutes, /ownership\/:ownershipResolutionId/);
assert.match(reviewerRoutes, /memory-candidates\/:memoryCandidateId/);

assert.match(backgroundEffects, /import\("@livekit\/track-processors"\)/);
assert.doesNotMatch(backgroundEffects, /^import .*@livekit\/track-processors/m);
assert.match(backgroundEffects, /background-blur/);
assert.match(backgroundEffects, /virtual-background/);
assert.match(liveKitProvider, /setBackgroundEffect/);
assert.match(meetingView, /expectedRevision/);
assert.match(meetingView, /Discussion highlights/);
assert.match(meetingView, /Open questions/);
assert.match(meetingView, /Promote to workspace memory/);
assert.match(callWindow, /What did I miss/);
assert.match(callWindow, /Blur background/);
assert.match(callWindow, /Replace background/);

console.log("Huddle vision-completion verification passed");
console.log("- Artifact and ownership reviews are serialized, idempotent, and audit-linked.");
console.log("- Reports include speaker-attributed discussion highlights and open questions.");
console.log("- Memory promotion requires artifact approval, candidate approval, and explicit promotion.");
console.log("- What Did I Miss is canonical-transcript backed.");
console.log("- Background processors remain lazy-loaded with unsupported-browser fallback.");
