import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const socketSource = fs.readFileSync(path.join(root, "realtime", "socket.js"), "utf8");
const transcriptionRoutes = fs.readFileSync(
  path.join(root, "routes", "huddleTranscription.routes.js"),
  "utf8"
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const cleanupIndex = socketSource.indexOf("function scheduleHuddleDisconnectCleanup");
const endHelperIndex = socketSource.indexOf("async function endHuddleAndNotify");
const socketInitIndex = socketSource.indexOf("export function initSocket");

assert(endHelperIndex >= 0, "endHuddleAndNotify must exist");
assert(cleanupIndex >= 0, "disconnect cleanup must exist");
assert(socketInitIndex >= 0, "socket initializer must exist");
assert(
  endHelperIndex < cleanupIndex && endHelperIndex < socketInitIndex,
  "endHuddleAndNotify must be module-scoped for deferred disconnect cleanup"
);
assert(
  socketSource.match(/async function endHuddleAndNotify/g)?.length === 1,
  "endHuddleAndNotify must have exactly one authoritative implementation"
);

assert(
  transcriptionRoutes.includes('router.param("sessionId"'),
  "transcription routes must normalize session identifiers"
);
assert(
  transcriptionRoutes.includes("findHuddleSessionByLegacy"),
  "legacy Huddle identifiers must resolve through durable session persistence"
);
assert(
  transcriptionRoutes.includes("req.params.sessionId = session.id"),
  "resolved transcription requests must use the durable UUID"
);
assert(
  transcriptionRoutes.includes('"huddle_session_not_found"'),
  "unknown legacy Huddle identifiers must fail closed"
);

console.log("Huddle production runtime remediation verification passed.");
