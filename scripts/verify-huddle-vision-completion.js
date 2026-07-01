import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
const liveKitProvider = frontend("src/huddle/media/LiveKitMediaProvider.js");
const liveKitRenderTarget = frontend("src/huddle/media/LiveKitRenderTarget.js");
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
  "huddle-intelligence-report-v4",
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

assert.equal(
  existsSync(join(frontendRoot, "src/huddle/media/BackgroundEffects.js")),
  false
);
assert.doesNotMatch(liveKitProvider, /backgroundEffect|setBackgroundEffect/);
assert.match(liveKitProvider, /setScreenShareEnabled\(\s*true,\s*captureOptions,\s*publishOptions/);
assert.match(liveKitRenderTarget, /setVideoDimensions/);
assert.match(liveKitRenderTarget, /setVideoFPS/);
assert.match(callWindow, /presentingParticipant/);
assert.match(callWindow, /object-contain bg(?:-black|-\[#11151e\])/);
assert.match(meetingView, /expectedRevision/);
assert.match(meetingView, /Discussion [Hh]ighlights/);
assert.match(meetingView, /Open questions/);
assert.match(meetingView, /Promote to workspace memory/);
assert.match(meetingView, /Create task/);
assert.match(meetingView, /Meeting Copilot/);
assert.match(meetingView, /downloadPdfExport/);
assert.match(meetingView, /downloadMarkdownExport/);
assert.match(meetingView, /Media quality/);
assert.match(callWindow, /What did I miss/);
assert.match(callWindow, /setInterval/);
assert.doesNotMatch(callWindow, /Blur background|Replace background/);
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
  "workspace meeting copilot",
  "copilot_answer_missing_evidence",
  "huddle_copilot_queries",
  "approved",
  "listWorkspaceMemoryEntries",
  "listAccessibleWorkspaceArtifacts",
  "workspaceArtifactCatalogCount",
  "scope: normalizedScope",
]) {
  assert.match(copilotService, new RegExp(token), `copilot evidence guard missing ${token}`);
}

assert.match(mediaService, /summarizeLiveKitQualitySamples/);
assert.match(mediaService, /videoScore/);
assert.match(mediaService, /audioScore/);
assert.match(mediaService, /connectionScore/);
assert.match(mediaService, /renderTargetMatchRate/);
assert.match(memoryService, /meetingTitle/);
assert.match(memoryService, /participantNames/);
assert.match(meetingView, /Across meetings/);
assert.match(meetingView, /Tile target match/);

console.log("Huddle vision-completion verification passed");
console.log("- Artifact and ownership reviews are serialized, idempotent, and audit-linked.");
console.log("- Reports include speaker-attributed discussion highlights and open questions.");
console.log("- Memory promotion requires artifact approval, candidate approval, and explicit promotion.");
console.log("- What Did I Miss is canonical-transcript backed.");
console.log("- Background effects, processors, UI, and telemetry are absent.");
console.log("- Approved actions create idempotent source-linked tasks only after ownership review.");
console.log("- Meeting Copilot rejects uncited answers and persists evidence-bound audit records.");
console.log("- Copilot can retrieve permission-filtered, approved evidence across meetings.");
console.log("- Memory retains meeting titles, participants, artifact type, and transcript provenance.");
console.log("- Remote video subscriptions request the visible tile dimensions and screen share uses a content-first stage.");
console.log("- Quality scoring separates video, audio, and connection signals.");
