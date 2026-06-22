import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (filePath) => fs.readFileSync(path.join(root, filePath), "utf8");
const readExternal = (filePath) => fs.readFileSync(filePath, "utf8");

const migration = read("migrations/20260622_huddle_call_delivery_trace.sql");
const service = read("services/huddleCallDeliveryTrace.service.js");
const route = read("routes/huddleCallTrace.routes.js");
const index = read("index.js");
const socket = read("realtime/socket.js");
const mediaRoute = read("routes/huddleMedia.routes.js");
const mobileApi = read("mobile/asystence_mobile/lib/src/core/api_service.dart");
const mobileShell = read("mobile/asystence_mobile/lib/src/features/shell/home_shell.dart");
const mobileChat = read("mobile/asystence_mobile/lib/src/features/workspace/chat_screen.dart");
const mobileLiveKit = read(
  "mobile/asystence_mobile/lib/src/features/workspace/huddle_media/livekit_huddle_media_provider.dart"
);

const frontendRoot = path.resolve(root, "..", "Task-management");
const webTrace = readExternal(path.join(frontendRoot, "src/huddle/callTrace.js"));
const webContext = readExternal(path.join(frontendRoot, "src/context/HuddleContext.jsx"));
const webConnection = readExternal(path.join(frontendRoot, "src/huddle/media/LiveKitConnection.js"));
const webProvider = readExternal(path.join(frontendRoot, "src/huddle/media/LiveKitMediaProvider.js"));
const serviceWorker = readExternal(path.join(frontendRoot, "public/sw.js"));

function assertContains(source, pattern, message) {
  assert.match(source, pattern, message);
}

[
  "call_started",
  "incoming_call_delivered",
  "incoming_call_displayed",
  "answer_pressed",
  "decline_pressed",
  "join_request_sent",
  "join_request_received",
  "provider_lock_resolved",
  "session_resolved",
  "token_requested",
  "token_issued",
  "room_connect_started",
  "room_connect_success",
  "room_connect_failed",
  "audio_connected",
  "video_connected",
].forEach((step) => {
  assertContains(migration, new RegExp(`'${step}'`), `Migration must allow ${step}`);
  assertContains(service, new RegExp(step.toUpperCase().replaceAll("-", "_").replaceAll(":", "_") + `|${step}`), `Service must expose ${step}`);
});

assertContains(migration, /CREATE TABLE IF NOT EXISTS huddle_call_delivery_events/,
  "Trace migration must create durable event table");
assertContains(service, /recordHuddleCallStep/, "Trace service must record events");
assertContains(route, /router\.post\("\/events"/, "Trace route must accept client events");
assertContains(index, /\/huddle\/call-trace/, "Trace route must be mounted behind auth/workspace middleware");

assertContains(socket, /CALL_STARTED/, "Socket start must trace call_started");
assertContains(socket, /INCOMING_CALL_DELIVERED/, "Socket start must trace invite delivery");
assertContains(socket, /JOIN_REQUEST_RECEIVED/, "Socket join must trace received joins");
assertContains(socket, /PROVIDER_LOCK_RESOLVED/, "Socket paths must trace provider lock resolution");
assertContains(socket, /SESSION_RESOLVED/, "Socket paths must trace session resolution");
assertContains(socket, /DECLINE_PRESSED/, "Socket decline must trace decline");

assertContains(mediaRoute, /TOKEN_REQUESTED/, "LiveKit token route must trace token_requested");
assertContains(mediaRoute, /TOKEN_ISSUED/, "LiveKit token route must trace token_issued");
assertContains(mediaRoute, /ROOM_CONNECT_STARTED/, "LiveKit room route must trace room readiness attempts");

assertContains(mobileApi, /recordHuddleCallTrace/, "Android app must expose trace client");
assertContains(mobileShell, /incoming_call_displayed/, "Android incoming dialog and push intent must trace display");
assertContains(mobileShell, /answer_pressed/, "Android incoming dialog must trace answer");
assertContains(mobileChat, /join_request_sent/, "Android join button must trace join_request_sent");
assertContains(mobileLiveKit, /room_connect_started/, "Android LiveKit provider must trace room connect start");
assertContains(mobileLiveKit, /room_connect_success/, "Android LiveKit provider must trace room connect success");
assertContains(mobileLiveKit, /audio_connected/, "Android LiveKit provider must trace audio publication");
assertContains(mobileLiveKit, /video_connected/, "Android LiveKit provider must trace video publication");

assertContains(webTrace, /recordHuddleCallTrace/, "Web must expose trace client");
assertContains(webTrace, /readPendingHuddleInviteFromUrl/, "Web must recover Huddle invite from notification URL");
assertContains(serviceWorker, /huddleAwareUrl/, "Service worker must preserve Huddle metadata in notification URL");
assertContains(serviceWorker, /huddle:notification-click/, "Service worker must post Huddle click messages to open tabs");
assertContains(webContext, /incoming_call_displayed/, "Web Huddle context must trace incoming UI display");
assertContains(webContext, /answer_pressed/, "Web Huddle context must trace answer");
assertContains(webContext, /join_request_sent/, "Web Huddle context must trace join request");
assertContains(webConnection, /room_connect_started/, "Web LiveKit connection must trace connect start");
assertContains(webConnection, /room_connect_success/, "Web LiveKit connection must trace connect success");
assertContains(webConnection, /room_connect_failed/, "Web LiveKit connection must trace connect failure");
assertContains(webProvider, /audio_connected/, "Web LiveKit provider must trace audio publication");
assertContains(webProvider, /video_connected/, "Web LiveKit provider must trace video publication");

console.log("Huddle call-delivery trace verification passed");
