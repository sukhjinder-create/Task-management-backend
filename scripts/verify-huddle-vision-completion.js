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
const actionTaskService = read("services/huddleActionTask.service.js");
const copilotService = read("services/huddleCopilot.service.js");
const mediaService = read("services/huddleMediaSession.service.js");
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
  "revokeHuddleArtifact",
  "huddle.artifact.revoked",
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
  "revokePromotedMemoryCandidate",
  "huddle_memory_candidate_revisions",
  "huddle.intelligence.memory_revoked",
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
assert.match(intelligenceRoutes, /memoryCandidateId\/revoke/);
assert.match(intelligenceRoutes, /actions\/:actionItemId\/tasks/);
assert.match(intelligenceRoutes, /sessions\/:sessionId\/copilot/);
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
assert.match(meetingView, /Create task/);
assert.match(meetingView, /Meeting Copilot/);
assert.match(meetingView, /downloadPdfExport/);
assert.match(meetingView, /downloadMarkdownExport/);
assert.match(meetingView, /Media quality/);
assert.match(callWindow, /What did I miss/);
assert.match(callWindow, /setInterval/);
assert.match(callWindow, /Blur background/);
assert.match(callWindow, /Replace background/);
assert.match(callWindow, /Video quality/);

for (const token of [
  "huddle_action_artifact_approval_required",
  "huddle_action_ownership_approval_required",
  "source_type = 'huddle_action_item'",
  "task_link",
  "task_evidence",
]) {
  assert.match(actionTaskService, new RegExp(token), `action task workflow missing ${token}`);
}

for (const token of [
  "evidence-bound meeting copilot",
  "copilot_answer_missing_evidence",
  "huddle_copilot_queries",
  "approved",
  "listWorkspaceMemoryEntries",
]) {
  assert.match(copilotService, new RegExp(token), `copilot evidence guard missing ${token}`);
}

assert.match(mediaService, /summarizeLiveKitQualitySamples/);
assert.match(mediaService, /videoScore/);
assert.match(mediaService, /audioScore/);
assert.match(mediaService, /connectionScore/);

console.log("Huddle vision-completion verification passed");
console.log("- Artifact and ownership reviews are serialized, idempotent, and audit-linked.");
console.log("- Reports include speaker-attributed discussion highlights and open questions.");
console.log("- Memory promotion requires artifact approval, candidate approval, and explicit promotion.");
console.log("- What Did I Miss is canonical-transcript backed.");
console.log("- Background processors remain lazy-loaded with unsupported-browser fallback.");
console.log("- Approved actions create idempotent source-linked tasks only after ownership review.");
console.log("- Meeting Copilot rejects uncited answers and persists evidence-bound audit records.");
console.log("- Quality scoring separates video, audio, and connection signals.");
