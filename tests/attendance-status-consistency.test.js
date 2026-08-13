import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("current attendance status is resolved from a workspace-scoped open session", () => {
  const service = read("services/attendance.service.js");
  const routes = read("routes/attendance.routes.js");

  assert.match(service, /export async function getCurrentAttendanceStatus/);
  assert.match(service, /s\.user_id = \$1[\s\S]*s\.workspace_id = \$2[\s\S]*s\.sign_off_at IS NULL/);
  assert.match(service, /const status = session \? mapLiveStatus\(session\.latest_event_type\) : "offline"/);
  assert.match(routes, /router\.get\("\/status"/);
  assert.match(routes, /workspaceId: req\.workspaceId[\s\S]*userId: req\.user\.id/);
});

test("a persisted browser attendance flag is not part of the backend contract", () => {
  const service = read("services/attendance.service.js");

  assert.doesNotMatch(service, /localStorage|attendanceStatus/);
});
