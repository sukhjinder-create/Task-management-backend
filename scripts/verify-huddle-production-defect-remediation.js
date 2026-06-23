import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const backendRoot = process.cwd();
const frontendRoot = resolve(backendRoot, "..", "Task-management");
const readBackend = (path) => readFileSync(join(backendRoot, path), "utf8");
const readFrontend = (path) => readFileSync(join(frontendRoot, path), "utf8");

const intelligence = readBackend("services/huddleIntelligence.service.js");
const transcript = readBackend("services/huddleTranscript.service.js");
const pipeline = readBackend("services/huddleTranscriptionPipeline.service.js");
const review = readBackend("services/huddleMeetingIntelligence.service.js");
const media = readBackend("services/huddleMediaSession.service.js");
const transcriptionClient = readFrontend("src/huddle/media/LiveTranscriptionClient.js");
const liveKitProvider = readFrontend("src/huddle/media/LiveKitMediaProvider.js");
const liveKitRenderTarget = readFrontend("src/huddle/media/LiveKitRenderTarget.js");
const liveKitConnection = readFrontend("src/huddle/media/LiveKitConnection.js");
const huddleContext = readFrontend("src/context/HuddleContext.jsx");
const huddleWindow = readFrontend("src/huddle/GlobalHuddleWindow.jsx");
const frontendPackage = readFrontend("package.json");
const meetingIntelligence = readFrontend("src/pages/HuddleMeetingIntelligence.jsx");
const artifact = readBackend("services/huddleArtifact.service.js");
const generation = readBackend("services/huddleIntelligenceGeneration.service.js");
const llm = readBackend("services/llm.js");
const transcriptText = readBackend("utils/huddleTranscriptText.js");
const mobileChat = readBackend(
  "mobile/asystence_mobile/lib/src/features/workspace/chat_screen.dart"
);
const mobileLiveKit = readBackend(
  "mobile/asystence_mobile/lib/src/features/workspace/huddle_media/livekit_huddle_media_provider.dart"
);
const { normalizeHuddleTranscriptText } = await import(
  "../utils/huddleTranscriptText.js"
);

assert.match(intelligence, /Math\.min\(Math\.max\(Number\(limit\) \|\| 200, 1\), 5000\)/);
assert.match(intelligence, /const direction = afterTimestamp \? "ASC" : "DESC"/);
assert.match(intelligence, /const orderedRows = afterTimestamp \? rows : \[\.\.\.rows\]\.reverse\(\)/);

assert.match(transcript, /resolved_speaker_label \|\| row\.speaker_label/);
assert.match(transcript, /NULLIF\(u\.username, ''\)/);
assert.match(pipeline, /participant\?\.display_name/);
assert.match(review, /resolveParticipantAliases/);
assert.match(review, /Participant \$\{index \+ 1\}/);
assert.match(transcriptText, /unicodeNormalization: "NFC"/);
assert.match(transcriptText, /utf8MojibakeRepaired/);
assert.match(generation, /Never emit Participant 1, Participant 2/);
assert.match(generation, /huddle-intelligence-report-v4/);
assert.match(llm, /LLM_TRANSIENT_RETRY_ATTEMPTS/);
assert.match(llm, /\[408, 425, 429\]/);
assert.match(llm, /retry-after/);

assert.match(transcriptionClient, /DEFAULT_TIMESLICE_MS = 100/);
assert.match(transcriptionClient, /preconnectDeepgram/);
assert.match(transcriptionClient, /grantCacheHit/);
assert.match(transcriptionClient, /KEEP_ALIVE_INTERVAL_MS = 8000/);
assert.match(transcriptionClient, /MAX_RECONNECT_DELAY_MS = 15000/);
assert.match(transcriptionClient, /pendingPartialEvent/);
assert.match(transcriptionClient, /pendingFinalEvents/);
assert.match(transcriptionClient, /coalescedPartialEvents/);
assert.match(transcriptionClient, /enqueueProviderEvent/);
assert.match(transcriptionClient, /status: "reconnecting"/);
assert.match(liveKitProvider, /LIVE_CAPTION_POLL_INTERVAL_MS = 2000/);
assert.match(liveKitProvider, /LIVE_CAPTION_CURSOR_OVERLAP_MS = 2000/);
assert.match(liveKitProvider, /captionCursorRef/);
assert.match(liveKitProvider, /captionGrantCacheHit/);

assert.match(liveKitConnection, /videoSimulcastLayers: layers/);
assert.match(
  liveKitConnection,
  /videoPresets\.h180,\s*videoPresets\.h360,\s*videoPresets\.h540/
);
assert.doesNotMatch(liveKitConnection, /videoPresets\.h720/);
assert.match(liveKitConnection, /maxBitrate: mobile \? 750_000 : 900_000/);
assert.match(liveKitConnection, /dynacast: true/);
assert.match(liveKitConnection, /async function timedLiveKitRequest/);
assert.match(
  liveKitConnection,
  /const tokenRequest = await timedLiveKitRequest\(async \(\) => \([\s\S]*consumePrefetchedLiveKitToken\(params\)[\s\S]*fetchLiveKitToken\(params\)[\s\S]*\)\)/
);
assert.match(liveKitConnection, /roomEndpointLatencyMs = null/);
assert.match(liveKitConnection, /tokenEndpointLatencyMs = tokenRequest\.latencyMs/);
assert.match(liveKitConnection, /source: "token_endpoint"/);
assert.match(liveKitProvider, /enableCameraAndMicrophone/);
assert.match(liveKitProvider, /liveKitCameraSimulcastLayers/);
assert.match(liveKitProvider, /videoSimulcastLayers: layers/);
assert.match(liveKitProvider, /prewarmInitialLiveKitTracks/);
assert.match(liveKitProvider, /publishPrewarmedLiveKitMedia/);
assert.match(liveKitProvider, /cameraPublishOptions\(mode, sdk\)/);
assert.match(liveKitProvider, /mediaPrewarmLatencyMs/);
assert.match(liveKitProvider, /maxFramerate: 30/);
assert.match(huddleContext, /requestIdleCallback\(preload, \{ timeout: 1500 \}\)/);
assert.match(liveKitProvider, /aspectRatio:\s*3\s*\/\s*4/);
assert.match(liveKitConnection, /aspectRatio:\s*3\s*\/\s*4/);
assert.match(liveKitProvider, /normalizeKbps\(track\.currentBitrateKbps\)/);
assert.match(liveKitProvider, /estimatedMegabytesPerHour/);
assert.match(media, /Estimated media data usage is unusually high/);
assert.equal(
  existsSync(join(frontendRoot, "src/huddle/media/BackgroundEffects.js")),
  false
);
assert.doesNotMatch(frontendPackage, /@livekit\/track-processors/);
assert.doesNotMatch(frontendPackage, /@mediapipe\/selfie_segmentation/);
assert.doesNotMatch(liveKitProvider, /backgroundEffect/);
assert.doesNotMatch(huddleWindow, /Background effects|CURATED_HUDDLE_BACKGROUNDS/);
assert.match(liveKitProvider, /intentToJoinLatencyMs/);
assert.match(liveKitProvider, /renderTargetMismatchCount/);
assert.match(liveKitProvider, /freezeTrackCount/);
assert.match(liveKitProvider, /markExistingSubscribedTracks/);
assert.match(liveKitProvider, /screenShareSendBitrateKbps/);
assert.match(liveKitRenderTarget, /setVideoDimensions/);
assert.match(liveKitRenderTarget, /screenShare \? 15 : 30/);
assert.match(liveKitRenderTarget, /contentCssWidth/);
assert.match(liveKitRenderTarget, /sourcePortrait/);
assert.match(liveKitRenderTarget, /minimumCameraWidth/);
assert.match(huddleWindow, /presentingParticipant/);
assert.match(huddleWindow, /composedRemoteCamera/);
assert.match(huddleWindow, /objectFit: "contain"/);

assert.doesNotMatch(meetingIntelligence, /downloadJsonExport/);
assert.doesNotMatch(meetingIntelligence, /> JSON</);
assert.match(meetingIntelligence, /downloadMarkdownExport/);
assert.match(meetingIntelligence, /downloadPdfExport/);
assert.match(meetingIntelligence, /shareMeetingIntelligence/);
assert.match(meetingIntelligence, /navigator\.share/);
assert.match(meetingIntelligence, /Asystence Huddle \| Page/);
assert.match(meetingIntelligence, /\\uFEFF/);
assert.match(meetingIntelligence, /NotoSansDevanagari/);
assert.match(meetingIntelligence, /Discussion Summary/);
assert.match(meetingIntelligence, /Ownership Suggestions/);
assert.match(meetingIntelligence, /aria-label="Meeting participants"/);
assert.match(huddleWindow, /aria-label="Live captions"/);
assert.match(huddleWindow, /pointer-events-none absolute inset-x-3/);
assert.match(huddleWindow, /visibleCaptionItems/);
assert.match(huddleWindow, /slice\(-2\)/);
assert.match(huddleWindow, /captionStatusLabel/);
assert.doesNotMatch(huddleWindow, /followLatestCaption/);
assert.match(huddleWindow, /mobileControlsVisible/);
assert.match(huddleWindow, /translate-y-full opacity-0 pointer-events-none/);
assert.match(huddleWindow, /visualViewport\?\.offsetTop/);
assert.match(huddleWindow, /requestAnimationFrame\(sync\)/);
assert.match(huddleWindow, /const CallTimer = memo/);
assert.match(huddleWindow, /const MemoizedVideoTile = memo/);
assert.match(huddleWindow, /body\.style\.overflow = "hidden"/);
assert.match(huddleWindow, /touchAction: "pan-y"/);
assert.match(huddleWindow, /!isMaximized && !isMobileDevice/);
assert.match(mobileChat, /_mobileHuddleControlsVisible/);
assert.match(mobileChat, /Widget _fullscreenHuddle/);
assert.match(mobileChat, /AnimatedPositioned/);
assert.match(mobileChat, /RTCVideoViewObjectFitCover/);
assert.match(mobileLiveKit, /adaptiveStream: true/);
assert.match(mobileLiveKit, /dynacast: true/);
assert.match(mobileLiveKit, /VideoParametersPresets\.h720_43/);
assert.match(mobileLiveKit, /VideoParametersPresets\.h180_43/);
assert.match(mobileLiveKit, /VideoParametersPresets\.h360_43/);
assert.match(mobileLiveKit, /maxBitrate: 1100000/);
assert.match(mobileLiveKit, /VideoViewFit\.cover/);
assert.match(
  mobileLiveKit,
  /await room\.connect\(liveKitUrl, token\);[\s\S]*joined = true;[\s\S]*notifyListeners\(\);[\s\S]*_setMicrophoneEnabled\(true\)/
);
assert.match(mobileLiveKit, /'appVersion': AppConfig\.version/);
assert.match(mobileLiveKit, /if \(_sessionId != null\) 'sessionId': _sessionId/);
assert.doesNotMatch(mobileLiveKit, /\/huddle\/media\/livekit\/room/);
assert.match(mobileLiveKit, /Duration\(milliseconds: 200\)/);
assert.match(media, /averageSendFps/);
assert.match(media, /averageReceiveFps/);
assert.match(media, /averageConnectLatencyMs/);
assert.match(media, /averageSendMediaSourceFps/);
assert.match(media, /qualityLimitationReasons/);
assert.match(media, /renderTargetMatchRate/);
assert.doesNotMatch(media, /backgroundEffect/);

const hindiSample =
  "\u092e\u0941\u091d\u0947 \u0939\u093f\u0902\u0926\u0940 \u0914\u0930 Hinglish \u0920\u0940\u0915 \u091a\u093e\u0939\u093f\u090f";
const corruptedHindi = Buffer.from(hindiSample, "utf8").toString("latin1");
const repairedHindi = normalizeHuddleTranscriptText(corruptedHindi, {
  maxLength: null,
});
assert.equal(repairedHindi.text, hindiSample);
assert.equal(repairedHindi.diagnostics.utf8MojibakeRepaired, true);

const approvalIdempotency = artifact.indexOf(
  "existing.approval_status === HUDDLE_ARTIFACT_APPROVAL_STATUSES.APPROVED"
);
const approvalRevisionGuard = artifact.indexOf(
  "assertReviewableArtifact(existing, expectedRevision)",
  approvalIdempotency
);
assert.ok(
  approvalIdempotency > 0 && approvalRevisionGuard > approvalIdempotency,
  "artifact retries must return the existing approval before revision conflict enforcement"
);

console.log("Huddle production-defect remediation verification passed.");
console.log("- Caption history catches up, reconnects, coalesces stale partials, and renders local speech immediately.");
console.log("- Transcript evidence is Unicode-normalized and generation requires canonical participant names.");
console.log("- Video diagnostics expose FPS, codec, selected layers, bandwidth, and quality limitations.");
console.log("- Meeting Intelligence exports multilingual Markdown/PDF and review retries are idempotent.");
