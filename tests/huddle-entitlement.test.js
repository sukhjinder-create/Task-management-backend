import assert from "node:assert/strict";
import test from "node:test";
import { hasVideoHuddleEntitlement, isLiveKitCanaryWorkspaceAllowed } from "../routes/huddleMedia.routes.js";

test("LiveKit accepts both call plan features and rejects chat-only plans", () => {
  for (const feature of ["video_huddle", "huddle"]) {
    assert.equal(hasVideoHuddleEntitlement({ workspace: { planFeatures: [feature] } }), true);
  }
  assert.equal(hasVideoHuddleEntitlement({ workspace: { planFeatures: ["team_chat"] } }), false);
  assert.equal(hasVideoHuddleEntitlement({ workspace: { billing_plan: "pro", planFeatures: [] } }), true);
  assert.equal(hasVideoHuddleEntitlement({ workspace: { billing_plan: "starter", planFeatures: [] } }), false);
  assert.equal(hasVideoHuddleEntitlement({ workspace: { onTrial: true, planFeatures: [] } }), true);
});

test("a global LiveKit rollout does not grant call entitlement", () => {
  assert.equal(isLiveKitCanaryWorkspaceAllowed("workspace", {
    HUDDLE_LIVEKIT_CANARY_ENABLED: "true",
    HUDDLE_LIVEKIT_CANARY_WORKSPACES: "*",
  }), false);
  assert.equal(isLiveKitCanaryWorkspaceAllowed("workspace", {
    HUDDLE_LIVEKIT_CANARY_ENABLED: "true",
    HUDDLE_LIVEKIT_CANARY_WORKSPACES: "workspace",
  }), true);
});
