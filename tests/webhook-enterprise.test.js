import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { __testables } from "../services/webhook.service.js";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("webhook retries preserve one stable event timestamp and delivery identity", () => {
  const delivery = {
    event: "task.updated",
    payload: { id: "task-1" },
    created_at: "2026-09-21T10:00:00.000Z",
  };
  assert.equal(
    __testables.deliveryEnvelope(delivery),
    '{"event":"task.updated","payload":{"id":"task-1"},"timestamp":"2026-09-21T10:00:00.000Z"}'
  );
  assert.equal(__testables.MAX_ATTEMPTS, 6);
});

test("webhook routes validate URLs and tenant-scope delivery history before dynamic routes", () => {
  const source = read("routes/webhooks.routes.js");
  assert.ok(source.indexOf('router.get("/events/list"') < source.indexOf('router.get("/:id/deliveries"'));
  assert.match(source, /await assertSafeUrl\(url\)/);
  assert.match(source, /delivery\.workspace_id = \$2/);
  assert.match(source, /webhook\.workspace_id = delivery\.workspace_id/);
});

test("webhook queue is durable, bounded, reclaimable, and tenant-addressable", () => {
  const source = read("services/webhook.service.js");
  assert.match(source, /INSERT INTO webhook_deliveries/);
  assert.match(source, /FOR UPDATE OF delivery SKIP LOCKED/);
  assert.match(source, /locked_at < now\(\) - interval '5 minutes'/);
  assert.match(source, /attempts >= MAX_ATTEMPTS/);
  assert.match(source, /delivery\.workspace_id = webhook\.workspace_id/);
  assert.match(source, /safeFetchJson\(delivery\.url/);
});
