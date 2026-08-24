import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  getUserEvidenceStatus,
  getWorkspaceEvidenceStatus,
} from "../intelligence/analytics/evidenceStatus.js";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("empty intelligence profiles are explicitly marked as insufficient evidence", () => {
  const user = {
    score: 62,
    analytics: { assignedWork: 0, completedWork: 0 },
    attendance: { metrics: { presentDays: 0 } },
  };
  const snapshot = {
    workspace: {
      score: 62,
      analytics: {
        execution: { totalWork: 0, internalTotal: 0, externalTotal: 0 },
      },
    },
    users: [user],
  };

  assert.equal(getUserEvidenceStatus(user).hasEvidence, false);
  assert.equal(getWorkspaceEvidenceStatus(snapshot).hasEvidence, false);
});

test("real task or attendance activity makes intelligence eligible for display", () => {
  assert.equal(getUserEvidenceStatus({ analytics: { assignedWork: 1 } }).hasEvidence, true);
  assert.equal(
    getUserEvidenceStatus({ attendance: { metrics: { presentDays: 1 } } }).hasEvidence,
    true
  );
  assert.equal(
    getWorkspaceEvidenceStatus({
      workspace: { analytics: { execution: { externalTotal: 2 } } },
      users: [],
    }).hasEvidence,
    true
  );
});

test("unread count SQL scopes messages, channels, and read markers to workspace", () => {
  const source = read("services/chat.service.js");

  assert.match(source, /m\.workspace_id = \$4/);
  assert.match(source, /rs\.workspace_id = \$4/);
  assert.match(source, /c\.workspace_id = \$4/g);
  assert.match(source, /\[userId, `dm:\$\{userId\}:%`, `dm:%:\$\{userId\}`, workspaceId\]/);
  assert.match(source, /export async function markChannelRead\(userId, channelKey, workspaceId\)/);
});

test("chat mutation and socket paths preserve tenant and actor boundaries", () => {
  const chat = read("services/chat.service.js");
  const socket = read("realtime/socket.js");
  const routes = read("routes/chatChannels.routes.js");

  assert.match(chat, /AND workspace_id = \$5\s+AND user_id = \$6/);
  assert.match(chat, /export async function softDeleteChatMessage\(\{ messageId, userId, workspaceId \}\)/);
  assert.match(socket, /validateDmChannelAccess\(\{/);
  assert.match(socket, /WHERE id = \$1 AND workspace_id = \$2 AND channel_key = \$3/);
  assert.match(routes, /getWorkspaceChannel\(channelId, req\.workspaceId\)/);
  assert.match(routes, /isActiveWorkspaceUser\(req\.workspaceId, memberId\)/);
  assert.doesNotMatch(routes, /io\.emit\("chat:channel_created"/);
});

test("chat read-state migration is additive, scoped, and idempotent", () => {
  const migration = read("migrations/20260813_chat_tenant_isolation.sql");

  assert.match(migration, /ADD COLUMN IF NOT EXISTS workspace_id UUID/i);
  assert.match(migration, /SET workspace_id = u\.workspace_id/i);
  assert.match(migration, /rs\.user_id::text = u\.id::text/i);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS idx_ccrs_workspace_user/i);
});

test("superadmin project drill-down supports the legacy text creator column", () => {
  const repository = read("repositories/superadminWorkspaces.repository.js");

  assert.match(repository, /ON creator\.id::text = p\.added_by/);
  assert.match(repository, /AND creator\.workspace_id = p\.workspace_id/);
});
