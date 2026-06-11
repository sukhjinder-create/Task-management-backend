import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.DATABASE_URL = " ";
process.env.DB_HOST = "localhost";
process.env.DB_PORT = "5432";
process.env.DB_NAME = "asystence_local";
process.env.NODE_ENV = "test";
process.env.LLM_PROVIDER = "groq";
process.env.GROQ_API_KEY = "verification-only";
process.env.GROQ_MODEL = "llama-3.3-70b-versatile";
process.env.HUDDLE_INTELLIGENCE_GENERATION_ENABLED = "true";
process.env.HUDDLE_INTELLIGENCE_GENERATION_WORKSPACES =
  "91fd34ae-09a9-4739-a932-9df49f75ddd7";

const root = process.cwd();
const read = (relativePath) => readFileSync(join(root, relativePath), "utf8");
const generatorSource = read("services/huddleIntelligenceGeneration.service.js");
const workerSource = read("services/huddleIntelligenceWorker.service.js");
const artifactSource = read("services/huddleArtifact.service.js");
const routeSource = read("routes/huddleIntelligence.routes.js");
const workflowSource = read(".github/workflows/deploy.yml");
const llmSource = read("services/llm.js");
const packageJson = JSON.parse(read("package.json"));

const {
  evaluateHuddleGenerationAccess,
  getHuddleIntelligenceGenerationDiagnostics,
  normalizeGenerationOutput,
} = await import("../services/huddleIntelligenceGeneration.service.js");

const segmentA = "21f99e46-3235-458a-8481-93d670ae4877";
const segmentB = "5d3e526a-a976-42a0-b173-f25b501d32df";
const participantId = "5ebf6357-ebf2-4c72-a36b-2c7c5eb7bc30";
const userId = "b7011fbe-4e69-4a59-976e-afd4af9c6360";
const participants = [{
  participantId,
  userId,
  displayName: "Asha",
  role: "participant",
}];

const summary = normalizeGenerationOutput({
  artifactType: "summary",
  segmentIds: [segmentA, segmentB],
  participants,
  raw: {
    title: "Launch review",
    overview: "The team confirmed the launch sequence.",
    overviewEvidenceSegmentIds: [segmentA, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    keyPoints: [{
      text: "Deployment follows database verification.",
      evidenceSegmentIds: [segmentB],
    }],
    confidence: 0.94,
  },
});
assert.deepEqual(summary.overviewEvidenceSegmentIds, [segmentA]);
assert.deepEqual(summary.keyPoints[0].evidenceSegmentIds, [segmentB]);

const decisions = normalizeGenerationOutput({
  artifactType: "decision",
  segmentIds: [segmentA],
  participants,
  raw: {
    decisions: [
      {
        title: "Ship",
        decision: "Proceed with the internal release.",
        evidenceSegmentIds: [segmentA],
        confidence: 1.7,
      },
      {
        title: "Unsupported",
        decision: "This must be removed.",
        evidenceSegmentIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
      },
    ],
  },
});
assert.equal(decisions.count, 1);
assert.equal(decisions.decisions[0].confidence, 1);
assert.equal(decisions.decisions[0].approvalStatus, "pending");

const actions = normalizeGenerationOutput({
  artifactType: "action_item",
  segmentIds: [segmentA],
  participants,
  raw: {
    actionItems: [{
      title: "Prepare release notes",
      evidenceSegmentIds: [segmentA],
      dueDate: "2026-06-15",
      confidence: 0.88,
      suggestedOwner: {
        participantId,
        userId,
        label: "Asha",
        confidence: 0.81,
      },
    }],
  },
});
assert.equal(actions.count, 1);
assert.equal(actions.actionItems[0].suggestedOwner.userId, userId);
assert.equal(actions.actionItems[0].taskCreated, false);
assert.equal(actions.actionItems[0].approvalStatus, "pending");

const access = evaluateHuddleGenerationAccess({
  workspaceId: "91fd34ae-09a9-4739-a932-9df49f75ddd7",
  artifactType: "summary",
});
assert.equal(access.ready, true);
assert.equal(
  evaluateHuddleGenerationAccess({
    workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    artifactType: "summary",
  }).ready,
  false
);

const diagnostics = getHuddleIntelligenceGenerationDiagnostics();
assert.equal(diagnostics.ready, true);
assert.equal(diagnostics.generationEnabled, true);
assert.equal(diagnostics.approvalRequired, true);
assert.equal(diagnostics.taskCreationEnabled, false);

for (const token of [
  "evidenceSegmentIds",
  "transcriptHash",
  "promptHash",
  "approvalStatus: \"pending\"",
  "orchestrationOnly: false",
  "generationImplemented: true",
  "taskCreationEnabled: false",
  "ai_processing_consent_denied",
  "workspace_not_allowlisted",
]) {
  assert.match(generatorSource, new RegExp(token), `generation safety missing ${token}`);
}
assert.match(generatorSource, /createOwnershipResolution/, "ownership suggestions must use the existing review model");
assert.match(workerSource, /generateHuddleArtifact/, "worker must execute artifact generation");
assert.match(workerSource, /createOwnershipSuggestions/, "worker must execute ownership suggestions");
assert.match(artifactSource, /HUDDLE_INTELLIGENCE_GENERATION_ENABLED/, "artifact diagnostics must reflect generation");
assert.match(routeSource, /generation\/diagnostics/, "generation diagnostics API required");
assert.match(llmSource, /response_format/, "LLM client must support JSON responses");
assert.match(workflowSource, /HUDDLE_INTELLIGENCE_GENERATION_ENABLED=true/, "production generation flag required");
assert.match(workflowSource, /HUDDLE_INTELLIGENCE_GENERATION_WORKSPACES=3ff9264b-1a19-483a-b9e3-2a0b1840a1c2/, "production generation must remain explicitly allowlisted");
assert.equal(
  packageJson.scripts["verify:huddle-intelligence-generation"],
  "node scripts/verify-huddle-intelligence-generation.js"
);

console.log("Huddle Intelligence generation verification passed");
