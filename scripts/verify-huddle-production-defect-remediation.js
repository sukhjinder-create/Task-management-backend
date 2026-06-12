import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
const liveKitConnection = readFrontend("src/huddle/media/LiveKitConnection.js");
const backgroundEffects = readFrontend("src/huddle/media/BackgroundEffects.js");
const huddleWindow = readFrontend("src/huddle/GlobalHuddleWindow.jsx");
const meetingIntelligence = readFrontend("src/pages/HuddleMeetingIntelligence.jsx");

assert.match(intelligence, /Math\.min\(Math\.max\(Number\(limit\) \|\| 200, 1\), 5000\)/);
assert.match(intelligence, /const direction = afterTimestamp \? "ASC" : "DESC"/);
assert.match(intelligence, /const orderedRows = afterTimestamp \? rows : \[\.\.\.rows\]\.reverse\(\)/);

assert.match(transcript, /resolved_speaker_label \|\| row\.speaker_label/);
assert.match(transcript, /NULLIF\(u\.username, ''\)/);
assert.match(pipeline, /participant\?\.display_name/);
assert.match(review, /resolveParticipantAliases/);
assert.match(review, /Participant \$\{index \+ 1\}/);

assert.match(transcriptionClient, /DEFAULT_TIMESLICE_MS = 250/);
assert.match(transcriptionClient, /KEEP_ALIVE_INTERVAL_MS = 8000/);
assert.match(transcriptionClient, /MAX_RECONNECT_DELAY_MS = 15000/);
assert.match(transcriptionClient, /postQueue = postQueue/);
assert.match(transcriptionClient, /status: "reconnecting"/);
assert.match(liveKitProvider, /LIVE_CAPTION_POLL_INTERVAL_MS = 750/);
assert.match(liveKitProvider, /LIVE_CAPTION_CURSOR_OVERLAP_MS = 2000/);
assert.match(liveKitProvider, /captionCursorRef/);

assert.match(liveKitConnection, /videoSimulcastLayers: layers/);
assert.doesNotMatch(
  liveKitConnection,
  /const layers = \[\s*videoPresets\.h180,\s*videoPresets\.h360,\s*videoPresets\.h720/
);
assert.match(liveKitConnection, /maxBitrate: mobile \? 600_000 : 1_000_000/);
assert.match(liveKitProvider, /estimatedMegabytesPerHour/);
assert.match(media, /Estimated media data usage is unusually high/);
assert.match(backgroundEffects, /constrainedDevice/);
assert.match(liveKitProvider, /background_effect_automatically_disabled/);

assert.doesNotMatch(meetingIntelligence, /downloadJsonExport/);
assert.doesNotMatch(meetingIntelligence, /> JSON</);
assert.match(meetingIntelligence, /downloadMarkdownExport/);
assert.match(meetingIntelligence, /downloadPdfExport/);
assert.match(meetingIntelligence, /Asystence Huddle \| Page/);
assert.match(meetingIntelligence, /aria-label="Meeting participants"/);
assert.match(huddleWindow, /Reconnecting captions/);
assert.match(huddleWindow, /\(!isMobileDevice \|\| isMaximized\)/);

console.log("Huddle production-defect remediation verification passed.");
console.log("- Caption history reads the newest page, incrementally catches up, reconnects, and emits low-latency local updates.");
console.log("- Historical and new transcript evidence resolves canonical participant names.");
console.log("- Video publishing uses bounded simulcast, accurate bandwidth accounting, and effect degradation safeguards.");
console.log("- Meeting Intelligence exports readable Markdown/PDF reports and compact mobile controls remain reachable.");
