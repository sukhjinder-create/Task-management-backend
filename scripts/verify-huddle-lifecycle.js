import assert from "node:assert/strict";

import pool from "../db.js";

function clone(value) {
  return structuredClone(value);
}

function now() {
  return new Date().toISOString();
}

function parseJson(value) {
  return typeof value === "string" ? JSON.parse(value) : value || {};
}

class MemoryHuddleStore {
  constructor() {
    this.reset();
  }

  reset() {
    this.state = {
      legacy: [],
      sessions: [],
      mediaSessions: [],
      participants: [],
      devices: [],
      events: [],
    };
    this.counters = {
      legacy: 0,
      session: 0,
      mediaSession: 0,
      participant: 0,
      device: 0,
      event: 0,
    };
    this.sessionUnavailable = false;
    this.failParticipantWrites = false;
    this.failEventTypes = new Set();
  }

  id(type) {
    this.counters[type] += 1;
    return `${type}-${this.counters[type]}`;
  }

  failIfUnavailable(sql) {
    if (this.sessionUnavailable && /huddle_(sessions|session_|participant_|guests|artifacts)/i.test(sql)) {
      const error = new Error("relation huddle_sessions does not exist");
      error.code = "42P01";
      throw error;
    }
  }

  async query(rawSql, params = []) {
    const sql = String(rawSql).replace(/\s+/g, " ").trim();
    this.failIfUnavailable(sql);

    if (/^INSERT INTO chat_huddles /i.test(sql)) {
      const row = {
        id: this.id("legacy"),
        workspace_id: params[0],
        channel_key: params[1],
        huddle_id: params[2],
        started_by: params[3],
        started_at: now(),
        ended_at: null,
        starter_username: `user-${params[3]}`,
      };
      this.state.legacy.push(row);
      return { rows: [clone(row)] };
    }

    if (/^UPDATE chat_huddles /i.test(sql)) {
      const row = this.state.legacy.find(
        (item) =>
          item.workspace_id === params[0] &&
          item.channel_key === params[1] &&
          item.huddle_id === params[2] &&
          !item.ended_at
      );
      if (row) row.ended_at = now();
      return { rows: row ? [clone(row)] : [] };
    }

    if (/FROM chat_huddles h/i.test(sql)) {
      let rows = this.state.legacy.filter((item) => item.workspace_id === params[0]);
      if (/h\.channel_key = \$2/i.test(sql)) {
        rows = rows.filter((item) => item.channel_key === params[1]);
        if (/h\.huddle_id = \$3/i.test(sql)) {
          rows = rows.filter((item) => item.huddle_id === params[2]);
        }
      } else if (params[1]) {
        rows = rows.filter((item) => item.started_by !== params[1]);
      }
      if (/h\.ended_at IS NULL/i.test(sql)) rows = rows.filter((item) => !item.ended_at);
      rows.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
      return { rows: clone(rows.slice(0, /LIMIT 1/i.test(sql) ? 1 : params[3] || rows.length)) };
    }

    if (/^SELECT \* FROM huddle_sessions /i.test(sql)) {
      let rows = this.state.sessions.filter((item) => item.workspace_id === params[0]);
      if (/legacy_huddle_id = \$2/i.test(sql)) {
        rows = rows.filter((item) => item.legacy_huddle_id === params[1]);
        if (/legacy_channel_key = \$3/i.test(sql)) {
          rows = rows.filter((item) => item.legacy_channel_key === params[2]);
        }
      } else if (/legacy_channel_key = \$2/i.test(sql)) {
        rows = rows.filter((item) => item.legacy_channel_key === params[1]);
      } else if (/scope_type = \$2/i.test(sql)) {
        rows = rows.filter(
          (item) =>
            item.scope_type === params[1] &&
            item.scope_key === params[2] &&
            !item.ended_at
        );
      }
      rows.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
      return { rows: clone(rows.slice(0, 1)) };
    }

    if (/^SELECT pg_advisory_xact_lock/i.test(sql)) {
      return { rows: [{ pg_advisory_xact_lock: "" }] };
    }

    if (/^SELECT \* FROM huddle_media_sessions /i.test(sql)) {
      let rows = this.state.mediaSessions.filter(
        (item) => item.workspace_id === params[0] && item.session_id === params[1]
      );
      rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      return { rows: clone(rows.slice(0, 1)) };
    }

    if (/^INSERT INTO huddle_media_sessions /i.test(sql)) {
      let row = this.state.mediaSessions.find(
        (item) => item.session_id === params[1] && item.provider_type === params[2]
      );
      if (row) {
        row.provider_room_id = params[3];
        row.provider_metadata = { ...parseJson(row.provider_metadata), ...parseJson(params[6]) };
        row.diagnostics = { ...parseJson(row.diagnostics), ...parseJson(params[7]) };
        row.updated_at = now();
      } else {
        row = {
          id: this.id("mediaSession"),
          workspace_id: params[0],
          session_id: params[1],
          provider_type: params[2],
          provider_room_id: params[3],
          provider_room_sid: null,
          state: params[4],
          selected_by: params[5],
          provider_metadata: parseJson(params[6]),
          diagnostics: parseJson(params[7]),
          provisioned_at: null,
          ended_at: null,
          created_at: now(),
          updated_at: now(),
        };
        this.state.mediaSessions.push(row);
      }
      return { rows: [clone(row)] };
    }

    if (/^UPDATE huddle_sessions /i.test(sql) && /scope_type = \$2/i.test(sql)) {
      const rows = this.state.sessions.filter(
        (item) =>
          item.workspace_id === params[0] &&
          item.scope_type === params[1] &&
          item.scope_key === params[2] &&
          !item.ended_at &&
          (!params[5] || item.legacy_huddle_id !== params[5])
      );
      for (const row of rows) {
        row.state = "ended";
        row.ended_at = row.ended_at || now();
        row.ended_by = params[3] || row.ended_by || null;
        row.end_reason = row.end_reason || params[4];
      }
      return { rows: clone(rows) };
    }

    if (/^INSERT INTO huddle_sessions /i.test(sql)) {
      const row = {
        id: this.id("session"),
        workspace_id: params[0],
        legacy_huddle_id: params[1],
        legacy_channel_key: params[2],
        scope_type: params[3],
        scope_key: params[4],
        channel_id: params[5],
        thread_message_id: params[6],
        started_by: params[7],
        host_user_id: params[8],
        state: "live",
        visibility: params[9],
        started_at: params[10] || now(),
        ended_at: null,
        metadata: parseJson(params[11]),
      };
      this.state.sessions.push(row);
      return { rows: [clone(row)] };
    }

    if (/^UPDATE huddle_sessions /i.test(sql) && /WHERE id = \$1/i.test(sql)) {
      const row = this.state.sessions.find(
        (item) => item.id === params[0] && item.workspace_id === params[1]
      );
      if (row) {
        row.state = "ended";
        row.ended_at = row.ended_at || now();
        row.ended_by = params[2] || row.ended_by || null;
        row.end_reason = row.end_reason || params[3];
      }
      return { rows: row ? [clone(row)] : [] };
    }

    if (/^SELECT \* FROM huddle_session_participants /i.test(sql)) {
      const byUser = /user_id = \$2/i.test(sql);
      const row = this.state.participants.find(
        (item) =>
          item.session_id === params[0] &&
          (byUser ? item.user_id === params[1] : item.guest_id === params[1])
      );
      return { rows: row ? [clone(row)] : [] };
    }

    if (/^INSERT INTO huddle_session_participants /i.test(sql)) {
      if (this.failParticipantWrites) throw new Error("participant write failed");
      const row = {
        id: this.id("participant"),
        session_id: params[0],
        workspace_id: params[1],
        participant_kind: params[2],
        user_id: params[3],
        guest_id: params[4],
        role: params[5],
        invite_state: params[6],
        join_state: params[7],
        invited_by: params[8],
        joined_at: params[9],
        left_at: params[10],
        last_seen_at: params[11] || now(),
        metadata: parseJson(params[12]),
      };
      this.state.participants.push(row);
      return { rows: [clone(row)] };
    }

    if (/^UPDATE huddle_session_participants /i.test(sql) && /role = COALESCE/i.test(sql)) {
      if (this.failParticipantWrites) throw new Error("participant write failed");
      const row = this.state.participants.find(
        (item) => item.id === params[0] && item.workspace_id === params[1]
      );
      if (row) {
        row.role = params[2] || row.role;
        row.invite_state = params[3] || row.invite_state;
        row.join_state = params[4] || row.join_state;
        row.invited_by = params[5] || row.invited_by;
        row.joined_at = params[6] || row.joined_at;
        row.left_at = params[7];
        row.last_seen_at = params[8] || now();
        row.metadata = { ...row.metadata, ...parseJson(params[9]) };
      }
      return { rows: row ? [clone(row)] : [] };
    }

    if (/^UPDATE huddle_session_participants /i.test(sql) && /WHERE id = \$1/i.test(sql)) {
      const row = this.state.participants.find(
        (item) => item.id === params[0] && item.workspace_id === params[1]
      );
      if (row) {
        row.join_state = /join_state = 'joined'/i.test(sql) ? "joined" : "left";
        row.left_at = row.join_state === "joined" ? null : row.left_at || now();
      }
      return { rows: row ? [clone(row)] : [] };
    }

    if (/^UPDATE huddle_session_participants /i.test(sql) && /WHERE session_id = \$1/i.test(sql)) {
      const rows = this.state.participants.filter(
        (item) => item.session_id === params[0] && item.workspace_id === params[1]
      );
      for (const row of rows) {
        if (row.join_state !== "declined" && row.join_state !== "removed") {
          row.join_state = "left";
          row.left_at = row.left_at || now();
        }
      }
      return { rows: clone(rows) };
    }

    if (/^SELECT \* FROM huddle_participant_devices /i.test(sql)) {
      const byLogicalDevice = /logical_device_id = \$3/i.test(sql);
      const row = this.state.devices.find(
        (item) =>
          item.session_id === params[0] &&
          item.participant_id === params[1] &&
          (byLogicalDevice ? item.logical_device_id === params[2] : item.socket_id === params[2]) &&
          !item.left_at
      );
      return { rows: row ? [clone(row)] : [] };
    }

    if (/^INSERT INTO huddle_participant_devices /i.test(sql)) {
      const row = {
        id: this.id("device"),
        session_id: params[0],
        participant_id: params[1],
        workspace_id: params[2],
        user_id: params[3],
        guest_id: params[4],
        socket_id: params[5],
        device_id: params[6],
        logical_device_id: /logical_device_id/i.test(sql) ? params[7] : null,
        platform: /logical_device_id/i.test(sql) ? params[8] : params[7],
        device_label: /logical_device_id/i.test(sql) ? params[9] : params[8],
        join_state: /logical_device_id/i.test(sql) ? params[10] : params[9],
        recovery_generation: /logical_device_id/i.test(sql) ? params[11] : 0,
        recovery_session_version: /logical_device_id/i.test(sql) ? params[12] : 0,
        restore_idempotency_key: /logical_device_id/i.test(sql) ? params[13] : null,
        media_state: parseJson(/logical_device_id/i.test(sql) ? params[14] : params[10]),
        metadata: parseJson(/logical_device_id/i.test(sql) ? params[15] : params[11]),
        left_at: null,
      };
      this.state.devices.push(row);
      return { rows: [clone(row)] };
    }

    if (/^UPDATE huddle_participant_devices /i.test(sql) && /WHERE id = \$1/i.test(sql)) {
      const row = this.state.devices.find((item) => item.id === params[0]);
      if (row) {
        row.join_state = params[1];
        if (/socket_id = COALESCE/i.test(sql)) {
          row.socket_id = params[4] || row.socket_id;
          row.device_id = params[5] || row.device_id;
          row.logical_device_id = params[6] || row.logical_device_id;
          row.platform = params[7] || row.platform;
          row.recovery_generation = Math.max(row.recovery_generation || 0, params[8] || 0);
          row.recovery_session_version = Math.max(row.recovery_session_version || 0, params[9] || 0);
          row.restore_idempotency_key = params[10] || row.restore_idempotency_key || null;
        }
      }
      return { rows: row ? [clone(row)] : [] };
    }

    if (/^UPDATE huddle_participant_devices /i.test(sql)) {
      let rows = this.state.devices.filter((item) => item.session_id === params[0] && !item.left_at);
      if (/participant_id = \$2/i.test(sql)) rows = rows.filter((item) => item.participant_id === params[1]);
      if (/socket_id = \$3/i.test(sql)) rows = rows.filter((item) => item.socket_id === params[2]);
      if (/workspace_id = \$2/i.test(sql)) rows = rows.filter((item) => item.workspace_id === params[1]);
      for (const row of rows) {
        row.join_state = "left";
        row.left_at = row.left_at || now();
      }
      return { rows: clone(rows) };
    }

    if (/^SELECT COUNT\(\*\)::int AS active_count FROM huddle_participant_devices /i.test(sql)) {
      const activeCount = this.state.devices.filter(
        (item) =>
          item.session_id === params[0] &&
          item.participant_id === params[1] &&
          !item.left_at
      ).length;
      return { rows: [{ active_count: activeCount }] };
    }

    if (/^INSERT INTO huddle_session_events /i.test(sql)) {
      const eventType = params[4];
      if (this.failEventTypes.has(eventType)) throw new Error(`event write failed: ${eventType}`);
      const row = {
        id: this.id("event"),
        session_id: params[0],
        workspace_id: params[1],
        actor_user_id: params[2],
        actor_guest_id: params[3],
        event_type: eventType,
        event_payload: parseJson(params[5]),
        created_at: now(),
      };
      this.state.events.push(row);
      return { rows: [clone(row)] };
    }

    if (/^SELECT user_id FROM huddle_session_participants /i.test(sql)) {
      const rows = this.state.participants
        .filter(
          (item) =>
            item.session_id === params[0] &&
            item.user_id &&
            ["joined", "reconnecting"].includes(item.join_state)
        )
        .map((item) => ({ user_id: item.user_id }));
      return { rows };
    }

    if (/^SELECT DISTINCT event_type FROM huddle_session_events /i.test(sql)) {
      const types = new Set(
        this.state.events
          .filter((item) => item.session_id === params[0])
          .map((item) => item.event_type)
      );
      return { rows: Array.from(types, (event_type) => ({ event_type })) };
    }

    throw new Error(`Unhandled test query: ${sql}`);
  }

  connect() {
    const store = this;
    let transactionSnapshot = null;
    const savepoints = new Map();
    return {
      async query(sql, params = []) {
        const command = String(sql).trim();
        if (command === "BEGIN") {
          transactionSnapshot = clone(store.state);
          return { rows: [] };
        }
        if (command === "COMMIT") {
          transactionSnapshot = null;
          savepoints.clear();
          return { rows: [] };
        }
        if (command === "ROLLBACK") {
          if (transactionSnapshot) store.state = transactionSnapshot;
          transactionSnapshot = null;
          savepoints.clear();
          return { rows: [] };
        }
        if (command.startsWith("SAVEPOINT ")) {
          savepoints.set(command.slice("SAVEPOINT ".length), clone(store.state));
          return { rows: [] };
        }
        if (command.startsWith("ROLLBACK TO SAVEPOINT ")) {
          const name = command.slice("ROLLBACK TO SAVEPOINT ".length);
          if (savepoints.has(name)) store.state = clone(savepoints.get(name));
          return { rows: [] };
        }
        if (command.startsWith("RELEASE SAVEPOINT ")) {
          savepoints.delete(command.slice("RELEASE SAVEPOINT ".length));
          return { rows: [] };
        }
        return store.query(sql, params);
      },
      release() {},
    };
  }
}

const store = new MemoryHuddleStore();
const originalQuery = pool.query;
const originalConnect = pool.connect;
pool.query = store.query.bind(store);
pool.connect = async () => store.connect();

const adapter = await import("../services/huddleCompatibilityAdapter.service.js");
const { normalizeLegacyHuddleScope } = await import(
  "../services/huddleSession.service.js"
);

const normalizedDmScope = normalizeLegacyHuddleScope({
  workspaceId: "3ff9264b-1a19-483a-b9e3-2a0b1840a1c2",
  legacyChannelKey:
    "dm:d0d9307e-1286-4a02-b1a5-80a9039ac9e2:f3d29844-e74e-418a-a28a-94c3c30bd9e7",
});
assert.equal(normalizedDmScope.scopeType, "dm");
assert.equal(
  normalizedDmScope.threadMessageId,
  null,
  "DM participant UUIDs must never be persisted as thread message IDs"
);

const scope = (workspaceId, channelId) => ({
  type: "channel",
  channelId,
  workspaceId,
  channel: { id: `channel-${workspaceId}` },
  isPrivate: false,
});

const socket = (id, platform = "web") => ({
  id,
  handshake: { auth: { platform, deviceId: `device-${id}` }, headers: {} },
});

async function verifyDualWriteLifecycle() {
  store.reset();
  const workspaceId = "workspace-a";
  const channelId = "team-general";
  const huddleId = "huddle-a";

  const started = await adapter.startLegacyHuddle({
    workspaceId,
    channelId,
    huddleId,
    userId: "user-1",
    username: "One",
    scope: scope(workspaceId, channelId),
  });
  assert.equal(started.ok, true);
  assert.equal(started.dualWriteOk, true);
  assert.equal(store.state.legacy.length, 1);
  assert.equal(store.state.sessions.length, 1);
  assert.equal(store.state.participants.length, 1);
  assert.equal(store.state.events.some((event) => event.event_type === "session.started"), true);

  const hostJoined = await adapter.recordLegacyHuddleJoin({
    workspaceId,
    channelId,
    huddleId,
    userId: "user-1",
    username: "One",
    scope: scope(workspaceId, channelId),
    socket: socket("socket-1", "web"),
  });
  assert.equal(hostJoined.ok, true);

  const joined = await adapter.recordLegacyHuddleJoin({
    workspaceId,
    channelId,
    huddleId,
    userId: "user-2",
    username: "Two",
    scope: scope(workspaceId, channelId),
    socket: socket("socket-2", "android"),
  });
  assert.equal(joined.ok, true);
  assert.equal(store.state.devices.length, 2);

  const reconnected = await adapter.recordLegacyHuddleJoin({
    workspaceId,
    channelId,
    huddleId,
    userId: "user-2",
    username: "Two",
    scope: scope(workspaceId, channelId),
    socket: socket("socket-2b", "android"),
  });
  assert.equal(reconnected.ok, true);
  assert.equal(store.state.devices.length, 3);

  const left = await adapter.recordLegacyHuddleLeave({
    workspaceId,
    channelId,
    huddleId,
    userId: "user-2",
    username: "Two",
    scope: scope(workspaceId, channelId),
    socket: socket("socket-2", "android"),
  });
  assert.equal(left.ok, true);
  assert.equal(
    store.state.participants.find((item) => item.user_id === "user-2").join_state,
    "joined"
  );

  const reconnectedLeft = await adapter.recordLegacyHuddleLeave({
    workspaceId,
    channelId,
    huddleId,
    userId: "user-2",
    username: "Two",
    scope: scope(workspaceId, channelId),
    socket: socket("socket-2b", "android"),
  });
  assert.equal(reconnectedLeft.ok, true);
  assert.equal(
    store.state.participants.find((item) => item.user_id === "user-2").join_state,
    "left"
  );

  const declined = await adapter.recordLegacyHuddleDecline({
    workspaceId,
    channelId,
    huddleId,
    userId: "user-3",
    username: "Three",
    scope: scope(workspaceId, channelId),
  });
  assert.equal(declined.ok, true);

  const ended = await adapter.endLegacyHuddle({
    workspaceId,
    channelId,
    huddleId,
    userId: "user-1",
    username: "One",
    scope: scope(workspaceId, channelId),
  });
  assert.equal(ended.ok, true);
  assert.equal(ended.legacyEndOk, true);
  assert.equal(store.state.legacy[0].ended_at !== null, true);
  assert.equal(store.state.sessions[0].state, "ended");
}

async function verifyWorkspaceIsolation() {
  store.reset();
  for (const workspaceId of ["workspace-a", "workspace-b"]) {
    const started = await adapter.startLegacyHuddle({
      workspaceId,
      channelId: "team-general",
      huddleId: "shared-huddle-id",
      userId: `user-${workspaceId}`,
      scope: scope(workspaceId, "team-general"),
    });
    assert.equal(started.ok, true);
  }

  const ended = await adapter.endLegacyHuddle({
    workspaceId: "workspace-a",
    channelId: "team-general",
    huddleId: "shared-huddle-id",
    userId: "user-workspace-a",
    scope: scope("workspace-a", "team-general"),
  });
  assert.equal(ended.ok, true);

  const activeB = await adapter.getActiveLegacyHuddle({
    workspaceId: "workspace-b",
    channelId: "team-general",
    huddleId: "shared-huddle-id",
    scope: scope("workspace-b", "team-general"),
  });
  assert.equal(activeB.ok, true);
  assert.equal(activeB.active.workspace_id, "workspace-b");

  const sessionB = store.state.sessions.find((item) => item.workspace_id === "workspace-b");
  const crossWorkspaceRepair = await adapter.recordLegacyHuddleEnd({
    workspaceId: "workspace-a",
    channelId: "team-general",
    huddleId: "shared-huddle-id",
    userId: "user-workspace-a",
    sessionHint: sessionB,
  });
  assert.equal(crossWorkspaceRepair.ok, false);
  assert.equal(sessionB.state, "live");
}

async function verifyLegacyOnlyMode() {
  store.reset();
  store.sessionUnavailable = true;
  const workspaceId = "workspace-a";
  const channelId = "team-general";
  const huddleId = "legacy-only";

  const started = await adapter.startLegacyHuddle({
    workspaceId,
    channelId,
    huddleId,
    userId: "user-1",
    scope: scope(workspaceId, channelId),
  });
  assert.equal(started.ok, true);
  assert.equal(started.dualWriteOk, false);
  assert.equal(store.state.legacy.length, 1);

  const active = await adapter.getActiveLegacyHuddle({
    workspaceId,
    channelId,
    huddleId,
    scope: scope(workspaceId, channelId),
  });
  assert.equal(active.ok, true);
  assert.equal(active.active.huddle_id, huddleId);
  assert.equal(active.sessionUnavailable, true);

  const ended = await adapter.endLegacyHuddle({
    workspaceId,
    channelId,
    huddleId,
    userId: "user-1",
    scope: scope(workspaceId, channelId),
  });
  assert.equal(ended.ok, true);
  assert.equal(ended.legacyEndOk, true);
  assert.equal(ended.dualWriteOk, false);
  assert.equal(store.state.legacy[0].ended_at !== null, true);
}

async function verifyRepairMode() {
  store.reset();
  await store.query(
    "INSERT INTO chat_huddles (workspace_id, channel_key, huddle_id, started_by) VALUES ($1, $2, $3, $4)",
    ["workspace-a", "team-general", "repair-me", "user-1"]
  );

  const active = await adapter.getActiveLegacyHuddle({
    workspaceId: "workspace-a",
    channelId: "team-general",
    huddleId: "repair-me",
    actorUserId: "user-1",
    scope: scope("workspace-a", "team-general"),
    source: "test:repair",
  });
  assert.equal(active.ok, true);
  assert.equal(active.repaired, true);
  assert.equal(store.state.sessions.length, 1);
  assert.equal(store.state.events.some((event) => event.event_type === "session.repaired"), true);
}

async function verifyPartialFailures() {
  store.reset();
  store.failParticipantWrites = true;
  const startWithParticipantFailure = await adapter.startLegacyHuddle({
    workspaceId: "workspace-a",
    channelId: "team-general",
    huddleId: "participant-failure",
    userId: "user-1",
    scope: scope("workspace-a", "team-general"),
  });
  assert.equal(startWithParticipantFailure.ok, true);
  assert.equal(startWithParticipantFailure.dualWriteOk, false);
  assert.equal(store.state.legacy.length, 1);
  assert.equal(store.state.sessions.length, 0);

  store.reset();
  const started = await adapter.startLegacyHuddle({
    workspaceId: "workspace-a",
    channelId: "team-general",
    huddleId: "end-event-failure",
    userId: "user-1",
    scope: scope("workspace-a", "team-general"),
  });
  assert.equal(started.ok, true);
  store.failEventTypes.add("session.ended");

  const ended = await adapter.endLegacyHuddle({
    workspaceId: "workspace-a",
    channelId: "team-general",
    huddleId: "end-event-failure",
    userId: "user-1",
    scope: scope("workspace-a", "team-general"),
  });
  assert.equal(ended.ok, true);
  assert.equal(ended.dualWriteOk, false);
  assert.equal(store.state.legacy[0].ended_at !== null, true);
  assert.equal(store.state.sessions[0].state, "ended");
}

try {
  await verifyDualWriteLifecycle();
  await verifyWorkspaceIsolation();
  await verifyLegacyOnlyMode();
  await verifyRepairMode();
  await verifyPartialFailures();
  console.log("Huddle lifecycle verification passed.");
  console.log("- Start, join, reconnect, leave, decline, and end remain consistent in dual-write mode.");
  console.log("- Legacy-only mode continues when session tables are unavailable.");
  console.log("- Missing sessions are repaired from workspace-scoped legacy rows.");
  console.log("- Cross-workspace lookup, end, and repair operations remain isolated.");
  console.log("- Participant and end-event failures do not leave active legacy Huddles.");
} finally {
  pool.query = originalQuery;
  pool.connect = originalConnect;
  await pool.end();
}
