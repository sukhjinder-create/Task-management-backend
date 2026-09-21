import assert from "node:assert/strict";
import test from "node:test";

import { __testables, verifyAuditChain } from "../services/audit.service.js";

test("audit canonicalization is stable across object key order", () => {
  assert.equal(
    __testables.canonicalJson({ z: 1, a: { y: 2, x: 3 } }),
    __testables.canonicalJson({ a: { x: 3, y: 2 }, z: 1 })
  );
});

test("audit integrity verification detects altered chained evidence", async () => {
  const created = new Date("2026-09-21T10:00:00.000Z");
  const event = __testables.normalizedAudit({
    workspaceId: "workspace-1", userId: "user-1", action: "task.create",
    entityType: "task", entityId: "task-1", metadata: { source: "test" },
  }, created);
  const eventHash = __testables.auditHash({ sequence: 1, previous_hash: null, ...event });
  const row = {
    id: "audit-1", ...event, created_at: created, chain_sequence: 1,
    previous_hash: null, event_hash: eventHash,
  };
  const valid = await verifyAuditChain("workspace-1", { query: async () => ({ rows: [row] }) });
  assert.equal(valid.valid, true);
  const altered = await verifyAuditChain("workspace-1", { query: async () => ({ rows: [{ ...row, action: "task.delete" }] }) });
  assert.equal(altered.valid, false);
  assert.equal(altered.failed_at, "audit-1");
});
