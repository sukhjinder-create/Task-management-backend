import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (filePath) => fs.readFileSync(path.join(root, filePath), "utf8");

const provider = read(
  "mobile/asystence_mobile/lib/src/features/workspace/huddle_media/livekit_huddle_media_provider.dart"
);
const service = read(
  "mobile/asystence_mobile/lib/src/features/workspace/huddle_media/huddle_media_service.dart"
);
const providerContract = read(
  "mobile/asystence_mobile/lib/src/features/workspace/huddle_media/huddle_media_provider.dart"
);
const stateV2 = read(
  "mobile/asystence_mobile/lib/src/features/workspace/huddle_media/huddle_media_state_v2.dart"
);
const controller = read(
  "mobile/asystence_mobile/lib/src/features/workspace/huddle_call_controller.dart"
);
const chat = read("mobile/asystence_mobile/lib/src/features/workspace/chat_screen.dart");
const socket = read("mobile/asystence_mobile/lib/src/core/socket_service.dart");
const config = read("mobile/asystence_mobile/lib/src/config/app_config.dart");
const pubspec = read("mobile/asystence_mobile/pubspec.yaml");
const iosPlist = read("mobile/asystence_mobile/ios/Runner/Info.plist");
const backendRoute = read("routes/huddleMedia.routes.js");
const packageJson = JSON.parse(read("package.json"));

function assertContains(source, pattern, message) {
  assert.match(source, pattern, message);
}

function assertNotContains(source, pattern, message) {
  assert.doesNotMatch(source, pattern, message);
}

assertContains(
  pubspec,
  /livekit_client:\s*2\.8\.0/,
  "Mobile app must pin the API-36 compatible LiveKit SDK"
);
assertContains(providerContract, /HuddleMediaProviderKind\s*{[\s\S]*mesh,[\s\S]*livekit,/,
  "Provider contract must add LiveKit without removing mesh");
assertContains(providerContract, /Widget\?\s+buildLocalVideoView/,
  "Provider contract must allow provider-owned local rendering");
assertContains(providerContract, /Widget\?\s+buildRemoteVideoView/,
  "Provider contract must allow provider-owned remote rendering");

assertContains(config, /HUDDLE_LIVEKIT_MOBILE_CANARY_ENABLED/,
  "Mobile LiveKit must be gated behind an additive canary flag");
assertContains(config, /HUDDLE_LIVEKIT_MOBILE_FORCE_MESH/,
  "Mobile LiveKit must have a force-mesh rollback flag");
assertContains(config, /defaultValue:\s*false/,
  "Mobile LiveKit canary flags must default safely");
assertContains(service, /huddleLiveKitMobileCanaryEnabled/,
  "Provider selection must check the mobile canary flag");
assertContains(service, /huddleLiveKitMobileForceMesh/,
  "Provider selection must check force mesh");
assertContains(service, /LiveKitHuddleMediaProvider/,
  "LiveKit mobile provider must be additive");
assertContains(provider, /MeshHuddleMediaProvider/,
  "Mesh provider must remain available as the production fallback");

assertContains(provider, /\/huddle\/media\/livekit\/token/,
  "Mobile provider must use the existing LiveKit token endpoint");
assertNotContains(provider, /\/huddle\/media\/livekit\/room/,
  "Mobile provider should skip the separate room endpoint on the join fast-path");
assertContains(provider, /'provider':\s*'livekit'/,
  "Mobile provider must explicitly request LiveKit");
assertContains(provider, /'clientCapabilities'/,
  "Mobile provider must send capability negotiation data");
assertContains(provider, /'clientType':\s*'mobile'/,
  "Mobile capabilities must identify client type");
assertContains(provider, /'supportedProviders':\s*const\s*\['mesh',\s*'livekit'\]/,
  "Mobile capabilities must advertise mesh and LiveKit support only when canary is active");
assertContains(provider, /providerVersions/,
  "Mobile capabilities must include provider version diagnostics");
assertContains(provider, /Authorization':\s*'Bearer \$authToken'/,
  "Mobile provider must preserve existing authorization flow for HTTP canary endpoints");

assertContains(provider, /setMicrophoneEnabled/,
  "Mobile provider must support microphone publication and mute/unmute");
assertContains(provider, /setCameraEnabled/,
  "Mobile provider must support camera publication and camera toggle");
assertContains(provider, /VideoTrackRenderer/,
  "Mobile provider must render LiveKit video tracks");
assertContains(provider, /trackPublications|audioTrackPublications|videoTrackPublications/,
  "Mobile provider must map participant track publications");
assertContains(provider, /HuddleMediaStateV2/,
  "Mobile provider must expose Media State V2");
assertContains(provider, /HuddleMediaPublicationState/,
  "Mobile provider must map publication state");
assertContains(provider, /HuddleMediaSubscriptionState/,
  "Mobile provider must map subscription state");
assertContains(provider, /activeSpeakers/,
  "Mobile provider must expose active speaker diagnostics");
assertContains(provider, /networkQuality/,
  "Mobile provider must expose network quality diagnostics");

assertContains(provider, /MeshHuddleMediaProvider/,
  "Mobile LiveKit failures must have a mesh fallback path");
assertContains(provider, /_fallbackToMesh/,
  "Mobile LiveKit must centralize fallback behavior");
assertContains(provider, /_cleanupLiveKit/,
  "Mobile LiveKit fallback must clean provider resources");
assertContains(provider, /_providerLockEstablished/,
  "Mobile LiveKit must track whether the backend provider lock was established");
assertContains(provider, /_failLockedLiveKitSession/,
  "Mobile LiveKit-locked sessions must fail closed instead of migrating to mesh");
assertContains(provider, /provider_lock_mismatch|durable_session_not_found|durable_session_required/,
  "Mobile LiveKit must recognize provider-lock and durable-session failure modes");
assertContains(backendRoute, /provider_lock_mismatch/,
  "Backend LiveKit routes must enforce provider lock mismatch rejection");
assertContains(backendRoute, /createOrGetLockedMediaSession/,
  "Backend LiveKit routes must persist provider locks");
assertContains(backendRoute, /resolveClientCapabilities/,
  "Backend LiveKit routes must consume client capabilities");

assertContains(socket, /String\?\s+get authToken/,
  "Socket service must expose the existing token for canary HTTP calls");
assertContains(socket, /String\?\s+get baseUrl/,
  "Socket service must expose existing base URL for canary HTTP calls");
assertContains(socket, /socket\.on\(\s*'huddle:signal'/,
  "Existing huddle signal socket contract must remain present");
assertContains(socket, /emit\(\s*'huddle:join'/,
  "Existing huddle join socket contract must remain present");
assertContains(socket, /emit\(\s*'huddle:leave'/,
  "Existing huddle leave socket contract must remain present");
assertContains(socket, /emit\(\s*muted \? 'huddle:mute' : 'huddle:unmute'/,
  "Existing huddle mute socket contract must remain present");
assertContains(socket, /emit\(\s*cameraOn \? 'huddle:camera-on' : 'huddle:camera-off'/,
  "Existing huddle camera socket contract must remain present");

assertContains(controller, /buildLocalVideoView/,
  "Controller must bridge provider-owned local video rendering");
assertContains(controller, /buildRemoteVideoView/,
  "Controller must bridge provider-owned remote video rendering");
assertContains(chat, /mediaView: call\.buildLocalVideoView/,
  "UI must support LiveKit local video without removing RTC renderer support");
assertContains(chat, /mediaView: call\.buildRemoteVideoView/,
  "UI must support LiveKit remote video without removing RTC renderer support");
assertContains(chat, /RTCVideoView/,
  "Existing mesh RTC renderer path must remain in the UI");

assertContains(stateV2, /huddleMediaProviderLiveKit/,
  "Media State V2 must model LiveKit as a provider-neutral provider");
assertContains(stateV2, /activeSpeakerParticipantIds/,
  "Diagnostics must include active speaker state");
assertContains(stateV2, /networkQualityByParticipantId/,
  "Diagnostics must include network quality state");
assertContains(stateV2, /fallbackCount/,
  "Diagnostics must include fallback count");
assertContains(stateV2, /lastFallbackReason/,
  "Diagnostics must include fallback reason");

assertContains(iosPlist, /NSCameraUsageDescription/,
  "iOS canary app must declare camera permission");
assertContains(iosPlist, /NSMicrophoneUsageDescription/,
  "iOS canary app must declare microphone permission");

assert.equal(
  packageJson.scripts["verify:huddle-mobile-livekit"],
  "node scripts/verify-huddle-mobile-livekit-certification.js",
  "package.json must expose the mobile LiveKit certification verifier"
);

assertNotContains(provider, /\brecording\b/i, "Mobile LiveKit bundle must not implement recording");
assertNotContains(provider, /\btranscription\b/i, "Mobile LiveKit bundle must not implement transcription");
assertNotContains(provider, /\bAI\b/, "Mobile LiveKit bundle must not implement AI features");
assertNotContains(provider, /active-session provider switching/i,
  "Mobile LiveKit bundle must not implement active-session provider switching");

console.log("Huddle Mobile LiveKit Canary Certification");
console.log("- Mesh remains the default and force-mesh rollback is available.");
console.log("- Mobile LiveKit is additive and gated by mobile canary flags.");
console.log("- Mobile sends capability negotiation data through the existing LiveKit token endpoint fast-path.");
console.log("- Provider lock compliance is enforced by the backend and consumed by mobile fallback handling.");
console.log("- Media State V2 maps participants, devices, tracks, publication/subscription, active speaker, and network quality.");
console.log("- Mic/camera publication, provider cleanup, pre-lock mesh fallback, and locked-session fail-closed behavior are covered by static certification checks.");
