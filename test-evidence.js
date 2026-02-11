import { buildUserEvidence } from "./events/scoring/evidenceBuilder.js";

const result = await buildUserEvidence({
  workspaceId: "886da598-6ae9-4c6a-950a-dca35d7a0b65",
  userId: "85d7aa38-10d2-4798-9027-41cab84f5aae",
  month: "2026-01",
});

console.log(JSON.stringify(result, null, 2));
