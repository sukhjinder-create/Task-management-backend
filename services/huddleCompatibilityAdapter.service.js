import pool from "../db.js";
import {
  createLegacyChatHuddle,
  createOrGetLegacyHuddleSession,
  endLegacyChatHuddle,
  endLegacyHuddleSession,
  findActiveLegacyChatHuddle,
  findHuddleSessionByLegacy,
  findLegacyChatHuddle,
  listRecentActiveLegacyChatHuddles as listRecentLegacyRows,
} from "./huddleSession.service.js";
import {
  markParticipantDeclined,
  markParticipantLeft,
  markSessionParticipantsLeft,
  upsertHuddleParticipant,
  upsertHuddleParticipantDevice,
} from "./huddleParticipant.service.js";
import {
  createHuddleSessionEvent,
  logHuddleReconciliation,
} from "./huddleEvent.service.js";
import {
  HUDDLE_MEDIA_PROVIDERS,
  buildProviderRoomIdentity,
  createOrGetLockedMediaSession,
} from "./huddleMediaSession.service.js";
import { selectHuddleMediaProvider } from "./huddleMediaProviderSelector.service.js";

export const HUDDLE_MISMATCH_TYPES = Object.freeze({
  MISSING_SESSION: "missing_session",
  MISSING_LEGACY_ROW: "missing_legacy_row",
  PARTICIPANT_MISMATCH: "participant_mismatch",
  STATE_MISMATCH: "state_mismatch",
  EVENT_MISMATCH: "event_mismatch",
});

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function platformFromSocket(socket) {
  return (
    socket?.handshake?.auth?.platform ||
    socket?.handshake?.headers?.["x-client-platform"] ||
    socket?.handshake?.headers?.["user-agent"] ||
    null
  );
}

function decorateLegacyHuddle(legacy, session = null) {
  if (!legacy) return null;
  return {
    ...legacy,
    session_id: session?.id || null,
    sessionId: session?.id || null,
  };
}

function assertLegacyWorkspace(legacy, workspaceId, source) {
  if (!legacy) return;
  if (!legacy.workspace_id || String(legacy.workspace_id) !== String(workspaceId)) {
    throw new Error(`legacy_workspace_mismatch:${source || "unknown"}`);
  }
}

function assertSessionScope(session, { workspaceId, channelId, huddleId, source }) {
  if (!session) return;
  if (!session.workspace_id || String(session.workspace_id) !== String(workspaceId)) {
    throw new Error(`session_workspace_mismatch:${source || "unknown"}`);
  }
  if (
    channelId &&
    session.legacy_channel_key &&
    String(session.legacy_channel_key) !== String(channelId)
  ) {
    throw new Error(`session_channel_mismatch:${source || "unknown"}`);
  }
  if (
    huddleId &&
    session.legacy_huddle_id &&
    String(session.legacy_huddle_id) !== String(huddleId)
  ) {
    throw new Error(`session_huddle_mismatch:${source || "unknown"}`);
  }
}

function success(result = {}) {
  return {
    ok: true,
    sessionId: result?.session?.id || result?.sessionId || null,
    ...result,
  };
}

async function reportSessionFailure(reason, details = {}) {
  console.warn("[huddle:session:degraded]", reason, details);
  await classifyMismatch({
    type: details.mismatchType || reason,
    sessionId: details.sessionId || null,
    workspaceId: details.workspaceId,
    actorUserId: details.actorUserId || null,
    source: details.source || "compatibility_adapter",
    details,
  }).catch(() => null);
}

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function withSavepoint(client, name, fn) {
  if (!client) return fn();
  await client.query(`SAVEPOINT ${name}`);
  try {
    const result = await fn();
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (err) {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => {});
    await client.query(`RELEASE SAVEPOINT ${name}`).catch(() => {});
    console.warn("[huddle:session:event_degraded]", {
      savepoint: name,
      error: err.message,
    });
    return null;
  }
}

async function classifyMismatch({
  type,
  workspaceId,
  sessionId = null,
  actorUserId = null,
  source,
  details = {},
  client = null,
}) {
  const reason = type || "unknown_mismatch";
  console.warn("[huddle:compat:mismatch]", {
    type: reason,
    workspaceId,
    sessionId,
    actorUserId,
    source,
    ...details,
  });

  // Reconciliation logging must never poison a lifecycle transaction when the
  // event table is unavailable or degraded.
  if (client) return null;

  return logHuddleReconciliation({
    sessionId,
    workspaceId,
    actorUserId,
    reason,
    details: {
      mismatchType: reason,
      source,
      ...details,
    },
    client,
  });
}

async function fail(reason, details = {}) {
  console.warn("[huddle:session:compat]", reason, details);
  await classifyMismatch({
    type: details.mismatchType || reason,
    sessionId: details.sessionId || null,
    workspaceId: details.workspaceId,
    actorUserId: details.actorUserId || null,
    source: details.source || "compatibility_adapter",
    details,
  }).catch(() => null);
  return {
    ok: false,
    reason,
    sessionId: details.sessionId || null,
  };
}

function providerLockStartError(message, details = {}) {
  const err = new Error(message || "provider_lock_start_failed");
  err.reason = "provider_lock_start_failed";
  err.details = details;
  return err;
}

async function createStartMeshProviderLock({
  workspaceId,
  channelId,
  huddleId,
  session,
  client,
}) {
  const providerSelection = selectHuddleMediaProvider({
    requestedProvider: HUDDLE_MEDIA_PROVIDERS.MESH,
    workspaceId,
    session,
    clientCapabilities: null,
    entitlement: false,
  });
  const lockResult = await createOrGetLockedMediaSession({
    session,
    workspaceId,
    providerSelection,
    providerType: HUDDLE_MEDIA_PROVIDERS.MESH,
    providerRoomId: buildProviderRoomIdentity({
      providerType: HUDDLE_MEDIA_PROVIDERS.MESH,
      workspaceId,
      sessionId: session.id,
      legacyHuddleId: huddleId,
      legacyChannelKey: channelId,
    }),
    providerMetadata: {
      transport: "mesh",
      signaling: "socket.io",
      roomMode: "legacy_mesh",
      compatibilitySource: "huddle:start",
    },
    diagnostics: {
      providerLockEvaluated: true,
      providerLockMatched: true,
      providerLockRejected: false,
      requestedProvider: HUDDLE_MEDIA_PROVIDERS.MESH,
      selectedProvider: HUDDLE_MEDIA_PROVIDERS.MESH,
      fallbackReason: providerSelection.fallbackReason || null,
      selectionReason: providerSelection.selectionReason,
      socketAction: "huddle:start",
    },
    selectedBy: "huddle_start_provider_lock",
    client,
  });

  if (lockResult.mismatch || lockResult.providerType !== HUDDLE_MEDIA_PROVIDERS.MESH) {
    throw providerLockStartError("provider_lock_mismatch", {
      lockedProvider: lockResult.providerType,
      requestedProvider: HUDDLE_MEDIA_PROVIDERS.MESH,
    });
  }

  return lockResult;
}

async function getSessionParticipantIds({ sessionId, client = null }) {
  if (!sessionId) return [];
  const { rows } = await (client || pool).query(
    `
    SELECT user_id
    FROM huddle_session_participants
    WHERE session_id = $1
      AND user_id IS NOT NULL
      AND join_state IN ('joined', 'reconnecting')
    `,
    [sessionId]
  );
  return rows.map((row) => String(row.user_id));
}

async function getSessionEventTypes({ sessionId, client = null }) {
  if (!sessionId) return [];
  const { rows } = await (client || pool).query(
    `
    SELECT DISTINCT event_type
    FROM huddle_session_events
    WHERE session_id = $1
    `,
    [sessionId]
  );
  return rows.map((row) => String(row.event_type));
}

async function classifySessionMismatches({
  workspaceId,
  legacy = null,
  session = null,
  actorUserId = null,
  source,
  expectedParticipantIds = null,
  requiredEventTypes = [],
  client = null,
}) {
  const mismatches = [];

  if (legacy && !session) {
    mismatches.push(HUDDLE_MISMATCH_TYPES.MISSING_SESSION);
    await classifyMismatch({
      type: HUDDLE_MISMATCH_TYPES.MISSING_SESSION,
      workspaceId,
      actorUserId,
      source,
      details: {
        channelId: legacy.channel_key,
        huddleId: legacy.huddle_id,
      },
      client,
    });
  }

  if (!legacy && session && !session.ended_at) {
    mismatches.push(HUDDLE_MISMATCH_TYPES.MISSING_LEGACY_ROW);
    await classifyMismatch({
      type: HUDDLE_MISMATCH_TYPES.MISSING_LEGACY_ROW,
      workspaceId,
      sessionId: session.id,
      actorUserId,
      source,
      details: {
        channelId: session.legacy_channel_key,
        huddleId: session.legacy_huddle_id,
        sessionState: session.state,
      },
      client,
    });
  }

  if (legacy && session) {
    const legacyLive = !legacy.ended_at;
    const sessionLive = !session.ended_at && session.state !== "ended";
    if (legacyLive !== sessionLive) {
      mismatches.push(HUDDLE_MISMATCH_TYPES.STATE_MISMATCH);
      await classifyMismatch({
        type: HUDDLE_MISMATCH_TYPES.STATE_MISMATCH,
        workspaceId,
        sessionId: session.id,
        actorUserId,
        source,
        details: {
          channelId: legacy.channel_key,
          huddleId: legacy.huddle_id,
          legacyEndedAt: legacy.ended_at || null,
          sessionEndedAt: session.ended_at || null,
          sessionState: session.state,
        },
        client,
      });
    }
  }

  if (session && Array.isArray(expectedParticipantIds)) {
    const expected = new Set(expectedParticipantIds.map(String));
    const actual = new Set(await getSessionParticipantIds({ sessionId: session.id, client }));
    const missing = Array.from(expected).filter((uid) => !actual.has(uid));
    const extra = Array.from(actual).filter((uid) => !expected.has(uid));
    if (missing.length > 0 || extra.length > 0) {
      mismatches.push(HUDDLE_MISMATCH_TYPES.PARTICIPANT_MISMATCH);
      await classifyMismatch({
        type: HUDDLE_MISMATCH_TYPES.PARTICIPANT_MISMATCH,
        workspaceId,
        sessionId: session.id,
        actorUserId,
        source,
        details: {
          channelId: legacy?.channel_key || session.legacy_channel_key,
          huddleId: legacy?.huddle_id || session.legacy_huddle_id,
          missing,
          extra,
        },
        client,
      });
    }
  }

  if (session && requiredEventTypes.length > 0) {
    const existingTypes = new Set(await getSessionEventTypes({ sessionId: session.id, client }));
    const missingEvents = requiredEventTypes.filter((eventType) => !existingTypes.has(eventType));
    if (missingEvents.length > 0) {
      mismatches.push(HUDDLE_MISMATCH_TYPES.EVENT_MISMATCH);
      await classifyMismatch({
        type: HUDDLE_MISMATCH_TYPES.EVENT_MISMATCH,
        workspaceId,
        sessionId: session.id,
        actorUserId,
        source,
        details: {
          channelId: legacy?.channel_key || session.legacy_channel_key,
          huddleId: legacy?.huddle_id || session.legacy_huddle_id,
          missingEvents,
        },
        client,
      });
    }
  }

  return mismatches;
}

async function ensureSessionFromLegacy({
  workspaceId,
  channelId,
  huddleId,
  actorUserId = null,
  scope = {},
  legacyRow = null,
  startedBy = null,
  startedAt = null,
  source = "compatibility_adapter",
  repair = true,
  client,
}) {
  const existing = await findHuddleSessionByLegacy({
    workspaceId,
    legacyChannelKey: channelId,
    legacyHuddleId: huddleId,
    client,
  });
  if (existing) return { session: existing, repaired: false };

  const legacy =
    legacyRow ||
    (await findActiveLegacyChatHuddle({
      workspaceId,
      legacyChannelKey: channelId,
      legacyHuddleId: huddleId,
      client,
    }));

  assertLegacyWorkspace(legacy, workspaceId, source);

  if (!legacy && !startedBy) return { session: null, repaired: false };
  if (!repair && legacy) {
    await classifySessionMismatches({
      workspaceId,
      legacy,
      session: null,
      actorUserId,
      source,
      client,
    });
    return { session: null, repaired: false };
  }

  const expectedStartCreate = source === "huddle:start" && Boolean(startedBy);
  if (!expectedStartCreate) {
    await classifyMismatch({
      type: HUDDLE_MISMATCH_TYPES.MISSING_SESSION,
      workspaceId,
      actorUserId,
      source,
      details: {
        channelId,
        huddleId,
        repaired: true,
      },
      client,
    });
  }

  const session = await createOrGetLegacyHuddleSession({
    workspaceId,
    legacyChannelKey: channelId,
    legacyHuddleId: huddleId,
    startedBy: startedBy || legacy.started_by,
    hostUserId: startedBy || legacy.started_by,
    scope,
    startedAt: startedAt || legacy?.started_at || null,
    metadata: {
      compatibilitySource: "legacy_session_repair",
      legacyStarterUsername: legacy?.starter_username || null,
      repairSource: source,
    },
    client,
  });

  await upsertHuddleParticipant({
    sessionId: session.id,
    workspaceId,
    userId: startedBy || legacy?.started_by,
    role: "host",
    inviteState: "accepted",
    joinState: "joined",
    joinedAt: startedAt || legacy?.started_at || new Date(),
    metadata: {
      compatibilitySource: "legacy_session_repair",
      repairSource: source,
    },
    client,
  });

  if (!expectedStartCreate) {
    await withSavepoint(client, "huddle_repair_events", async () => {
      await createHuddleSessionEvent({
        sessionId: session.id,
        workspaceId,
        actorUserId: actorUserId || startedBy || legacy?.started_by || null,
        eventType: "session.started",
        eventPayload: {
          channelId,
          huddleId,
          repaired: true,
          compatibilitySource: "legacy_session_repair",
          source,
        },
        client,
      });

      await createHuddleSessionEvent({
        sessionId: session.id,
        workspaceId,
        actorUserId: actorUserId || startedBy || legacy?.started_by || null,
        eventType: "session.repaired",
        eventPayload: {
          channelId,
          huddleId,
          mismatchType: HUDDLE_MISMATCH_TYPES.MISSING_SESSION,
          compatibilitySource: "legacy_session_repair",
          source,
        },
        client,
      });
    });
  }

  return { session, repaired: !expectedStartCreate };
}

export async function startLegacyHuddle({
  workspaceId,
  channelId,
  huddleId,
  userId,
  username = null,
  scope = {},
}) {
  let legacy = null;
  try {
    legacy = await createLegacyChatHuddle({
      workspaceId,
      legacyChannelKey: channelId,
      legacyHuddleId: huddleId,
      startedBy: userId,
    });
  } catch (err) {
    return fail("legacy_start_write_failed", {
      mismatchType: HUDDLE_MISMATCH_TYPES.MISSING_LEGACY_ROW,
      workspaceId,
      channelId,
      huddleId,
      actorUserId: userId,
      source: "huddle:start",
      error: err.message,
    });
  }

  const sessionResult = await recordLegacyHuddleStart({
    workspaceId,
    channelId,
    huddleId,
    userId,
    username,
    scope,
    startedAt: legacy?.started_at || null,
  });
  if (sessionResult?.reason === "provider_lock_start_failed") {
    await endLegacyChatHuddle({
      workspaceId,
      legacyChannelKey: channelId,
      legacyHuddleId: huddleId,
    }).catch(() => null);
    return sessionResult;
  }

  return success({
    legacy,
    active: decorateLegacyHuddle(legacy, sessionResult?.session || null),
    session: sessionResult?.session || null,
    sessionId: sessionResult?.sessionId || null,
    mediaSession: sessionResult?.mediaSession || null,
    providerLock: sessionResult?.providerLock || null,
    providerLockDiagnostics: sessionResult?.providerLockDiagnostics || null,
    dualWriteOk: sessionResult?.ok === true,
  });
}

async function reconcileMissingLegacySession({
  workspaceId,
  channelId,
  huddleId,
  actorUserId = null,
  session,
  source,
}) {
  if (!session || session.ended_at || session.state === "ended") {
    return { session, repaired: false, dualWriteOk: true };
  }

  await classifySessionMismatches({
    workspaceId,
    legacy: null,
    session,
    actorUserId,
    source,
  });

  const endResult = await recordLegacyHuddleEnd({
    workspaceId,
    channelId: channelId || session.legacy_channel_key,
    huddleId: huddleId || session.legacy_huddle_id,
    userId: actorUserId,
    reason: "legacy_row_missing",
    sessionHint: session,
  });

  return {
    session: endResult?.session || session,
    repaired: endResult?.ok === true,
    dualWriteOk: endResult?.ok === true && endResult?.eventWriteOk !== false,
  };
}

export async function getActiveLegacyHuddle({
  workspaceId,
  channelId,
  huddleId = null,
  actorUserId = null,
  scope = {},
  source = "legacy_active_lookup",
  repair = true,
}) {
  let legacy = null;
  try {
    legacy = await findActiveLegacyChatHuddle({
      workspaceId,
      legacyChannelKey: channelId,
      legacyHuddleId: huddleId,
    });
    assertLegacyWorkspace(legacy, workspaceId, source);
  } catch (err) {
    return fail("legacy_active_lookup_failed", {
      workspaceId,
      channelId,
      huddleId,
      actorUserId,
      source,
      error: err.message,
    });
  }

  try {
    if (!legacy) {
      const session = await findHuddleSessionByLegacy({
        workspaceId,
        legacyChannelKey: channelId,
        legacyHuddleId: huddleId,
      });
      const reconciliation = await reconcileMissingLegacySession({
        workspaceId,
        channelId,
        huddleId,
        actorUserId,
        session,
        source,
      });
      return success({
        active: null,
        legacy: null,
        session: reconciliation.session || session,
        repaired: reconciliation.repaired,
        dualWriteOk: reconciliation.dualWriteOk,
        reason: "huddle_not_found",
      });
    }

    const result = await withTransaction(async (client) => {
      const { session, repaired } = await ensureSessionFromLegacy({
        workspaceId,
        channelId: legacy.channel_key,
        huddleId: legacy.huddle_id,
        actorUserId,
        scope,
        legacyRow: legacy,
        source,
        repair,
        client,
      });

      await classifySessionMismatches({
        workspaceId,
        legacy,
        session,
        actorUserId,
        source,
        requiredEventTypes: ["session.started"],
        client,
      });

      return { session, repaired };
    });

    return success({
      active: decorateLegacyHuddle(legacy, result.session),
      legacy,
      session: result.session,
      repaired: result.repaired,
      dualWriteOk: true,
    });
  } catch (err) {
    await reportSessionFailure("legacy_active_session_shadow_failed", {
      mismatchType: HUDDLE_MISMATCH_TYPES.MISSING_SESSION,
      workspaceId,
      channelId,
      huddleId: huddleId || legacy?.huddle_id || null,
      actorUserId,
      source,
      error: err.message,
    });
    if (!legacy) {
      return success({
        active: null,
        legacy: null,
        session: null,
        reason: "huddle_not_found",
        dualWriteOk: false,
        sessionUnavailable: true,
      });
    }
    return success({
      active: decorateLegacyHuddle(legacy),
      legacy,
      session: null,
      repaired: false,
      dualWriteOk: false,
      sessionUnavailable: true,
    });
  }
}

export async function listRecentActiveLegacyHuddles({
  workspaceId,
  excludeStartedBy = null,
  withinMinutes = 5,
  limit = 20,
  source = "legacy_recent_list",
}) {
  try {
    const rows = await listRecentLegacyRows({
      workspaceId,
      excludeStartedBy,
      withinMinutes,
      limit,
    });
    return success({
      huddles: rows.map((row) => decorateLegacyHuddle(row)),
      source,
    });
  } catch (err) {
    return fail("legacy_recent_list_failed", {
      workspaceId,
      actorUserId: excludeStartedBy,
      source,
      error: err.message,
    });
  }
}

export async function endLegacyHuddle({
  workspaceId,
  channelId,
  huddleId,
  userId,
  username = null,
  scope = {},
  reason = "legacy_huddle_ended",
}) {
  let activeBeforeEnd = null;
  let legacy = null;
  let legacyRecord = null;
  try {
    activeBeforeEnd = await findActiveLegacyChatHuddle({
      workspaceId,
      legacyChannelKey: channelId,
      legacyHuddleId: huddleId,
    });
    assertLegacyWorkspace(activeBeforeEnd, workspaceId, "huddle:end");

    legacy = await endLegacyChatHuddle({
      workspaceId,
      legacyChannelKey: channelId,
      legacyHuddleId: huddleId,
    });
    legacyRecord =
      legacy ||
      activeBeforeEnd ||
      (await findLegacyChatHuddle({
        workspaceId,
        legacyChannelKey: channelId,
        legacyHuddleId: huddleId,
      }));
    assertLegacyWorkspace(legacyRecord, workspaceId, "huddle:end");
  } catch (err) {
    return fail("legacy_end_failed", {
      workspaceId,
      channelId,
      huddleId,
      actorUserId: userId,
      source: "huddle:end",
      error: err.message,
    });
  }

  const sessionResult = await recordLegacyHuddleEnd({
    workspaceId,
    channelId,
    huddleId,
    userId,
    username,
    scope,
    reason,
    legacyHint: legacyRecord,
  });

  if (!legacyRecord) {
    await reportSessionFailure(HUDDLE_MISMATCH_TYPES.MISSING_LEGACY_ROW, {
      mismatchType: HUDDLE_MISMATCH_TYPES.MISSING_LEGACY_ROW,
      workspaceId,
      channelId,
      huddleId,
      actorUserId: userId,
      source: "huddle:end",
    });
  }

  if (!sessionResult?.ok) {
    await reportSessionFailure("legacy_end_session_reconciliation_pending", {
      mismatchType: HUDDLE_MISMATCH_TYPES.STATE_MISMATCH,
      workspaceId,
      channelId,
      huddleId,
      actorUserId: userId,
      source: "huddle:end",
      error: sessionResult?.reason || "session_end_failed",
    });
  }

  return success({
    legacy: legacyRecord,
    session: sessionResult?.session || null,
    sessionId: sessionResult?.sessionId || null,
    legacyEndOk: true,
    dualWriteOk:
      sessionResult?.ok === true && sessionResult?.eventWriteOk !== false,
  });
}

export async function recordLegacyHuddleStart({
  workspaceId,
  channelId,
  huddleId,
  userId,
  username = null,
  scope = {},
  startedAt = null,
}) {
  try {
    return success(
      await withTransaction(async (client) => {
        const { session } = await ensureSessionFromLegacy({
          workspaceId,
          channelId,
          huddleId,
          actorUserId: userId,
          scope,
          startedBy: userId,
          startedAt,
          source: "huddle:start",
          repair: true,
          client,
        });

        const providerLockResult = await createStartMeshProviderLock({
          workspaceId,
          channelId,
          huddleId,
          session,
          client,
        });

        const participant = await upsertHuddleParticipant({
          sessionId: session.id,
          workspaceId,
          userId,
          role: "host",
          inviteState: "accepted",
          joinState: "joined",
          joinedAt: new Date(),
          metadata: { username, compatibilitySource: "legacy_start" },
          client,
        });

        await createHuddleSessionEvent({
          sessionId: session.id,
          workspaceId,
          actorUserId: userId,
          eventType: "session.started",
          eventPayload: {
            channelId,
            huddleId,
            username,
            compatibilitySource: "legacy_socket",
          },
          client,
        });

        return {
          session,
          participant,
          mediaSession: providerLockResult.mediaSession || null,
          providerLock: providerLockResult.providerLock || null,
          providerLockDiagnostics: {
            action: "huddle:start",
            requestedProvider: HUDDLE_MEDIA_PROVIDERS.MESH,
            effectiveProvider: providerLockResult.providerType,
            providerLockEvaluated: true,
            providerLockMatched: true,
            providerLockRejected: false,
            providerLockCreated: !providerLockResult.inherited,
            providerLockInherited: Boolean(providerLockResult.inherited),
            providerLock: providerLockResult.providerLock || null,
            selectionReason: providerLockResult.inherited
              ? "provider_lock_matched"
              : "provider_lock_created",
            rejectionReason: null,
          },
        };
      })
    );
  } catch (err) {
    const providerLockFailure = err?.reason === "provider_lock_start_failed";
    return fail(providerLockFailure ? "provider_lock_start_failed" : "legacy_start_dual_write_failed", {
      mismatchType: HUDDLE_MISMATCH_TYPES.MISSING_SESSION,
      workspaceId,
      channelId,
      huddleId,
      actorUserId: userId,
      source: "huddle:start",
      error: err.message,
      ...(providerLockFailure ? { providerLock: err.details || null } : {}),
    });
  }
}

export async function recordLegacyHuddleJoin({
  workspaceId,
  channelId,
  huddleId,
  userId,
  username = null,
  scope = {},
  socket = null,
}) {
  try {
    return success(
      await withTransaction(async (client) => {
        const { session } = await ensureSessionFromLegacy({
          workspaceId,
          channelId,
          huddleId,
          actorUserId: userId,
          scope,
          source: "huddle:join",
          repair: true,
          client,
        });
        if (!session) {
          throw new Error("session_missing_for_legacy_join");
        }

        const participant = await upsertHuddleParticipant({
          sessionId: session.id,
          workspaceId,
          userId,
          role: String(session.host_user_id) === String(userId) ? "host" : "participant",
          inviteState: "accepted",
          joinState: "joined",
          joinedAt: new Date(),
          leftAt: null,
          metadata: { username, compatibilitySource: "legacy_join" },
          client,
        });

        const device = await upsertHuddleParticipantDevice({
          sessionId: session.id,
          participantId: participant.id,
          workspaceId,
          userId,
          socketId: socket?.id || null,
          deviceId: safeString(socket?.handshake?.auth?.deviceId) || null,
          platform: platformFromSocket(socket),
          joinState: "joined",
          metadata: { compatibilitySource: "legacy_join" },
          client,
        });

        await createHuddleSessionEvent({
          sessionId: session.id,
          workspaceId,
          actorUserId: userId,
          eventType: "participant.joined",
          eventPayload: {
            channelId,
            huddleId,
            username,
            socketId: socket?.id || null,
            participantId: participant.id,
            deviceId: device?.id || null,
            compatibilitySource: "legacy_socket",
          },
          client,
        });

        return { session, participant, device };
      })
    );
  } catch (err) {
    return fail("legacy_join_dual_write_failed", {
      mismatchType: HUDDLE_MISMATCH_TYPES.MISSING_SESSION,
      workspaceId,
      channelId,
      huddleId,
      actorUserId: userId,
      source: "huddle:join",
      error: err.message,
    });
  }
}

export async function recordLegacyHuddleLeave({
  workspaceId,
  channelId,
  huddleId,
  userId,
  username = null,
  scope = {},
  socket = null,
}) {
  try {
    return success(
      await withTransaction(async (client) => {
        const { session } = await ensureSessionFromLegacy({
          workspaceId,
          channelId,
          huddleId,
          actorUserId: userId,
          scope,
          source: "huddle:leave",
          repair: true,
          client,
        });
        if (!session) throw new Error("session_missing_for_legacy_leave");

        const participant = await markParticipantLeft({
          sessionId: session.id,
          workspaceId,
          userId,
          socketId: socket?.id || null,
          client,
        });

        await createHuddleSessionEvent({
          sessionId: session.id,
          workspaceId,
          actorUserId: userId,
          eventType: "participant.left",
          eventPayload: {
            channelId,
            huddleId,
            username,
            socketId: socket?.id || null,
            compatibilitySource: "legacy_socket",
          },
          client,
        });

        return { session, participant };
      })
    );
  } catch (err) {
    return fail("legacy_leave_dual_write_failed", {
      mismatchType: HUDDLE_MISMATCH_TYPES.MISSING_SESSION,
      workspaceId,
      channelId,
      huddleId,
      actorUserId: userId,
      source: "huddle:leave",
      error: err.message,
    });
  }
}

export async function recordLegacyHuddleDecline({
  workspaceId,
  channelId,
  huddleId,
  userId,
  username = null,
  scope = {},
}) {
  try {
    return success(
      await withTransaction(async (client) => {
        const { session } = await ensureSessionFromLegacy({
          workspaceId,
          channelId,
          huddleId,
          actorUserId: userId,
          scope,
          source: "huddle:decline",
          repair: true,
          client,
        });
        if (!session) throw new Error("session_missing_for_legacy_decline");

        const participant = await markParticipantDeclined({
          sessionId: session.id,
          workspaceId,
          userId,
          client,
        });

        await createHuddleSessionEvent({
          sessionId: session.id,
          workspaceId,
          actorUserId: userId,
          eventType: "participant.declined",
          eventPayload: {
            channelId,
            huddleId,
            username,
            compatibilitySource: "legacy_socket",
          },
          client,
        });

        return { session, participant };
      })
    );
  } catch (err) {
    return fail("legacy_decline_dual_write_failed", {
      mismatchType: HUDDLE_MISMATCH_TYPES.MISSING_SESSION,
      workspaceId,
      channelId,
      huddleId,
      actorUserId: userId,
      source: "huddle:decline",
      error: err.message,
    });
  }
}

export async function recordLegacyHuddleEnd({
  workspaceId,
  channelId,
  huddleId,
  userId,
  username = null,
  scope = {},
  reason = "legacy_huddle_ended",
  sessionHint = null,
  legacyHint = null,
}) {
  let stateResult = null;
  try {
    assertLegacyWorkspace(legacyHint, workspaceId, "huddle:end");
    assertSessionScope(sessionHint, {
      workspaceId,
      channelId,
      huddleId,
      source: "huddle:end",
    });
    stateResult = await withTransaction(async (client) => {
      let session = sessionHint;
      if (!session) {
        const ensured = await ensureSessionFromLegacy({
          workspaceId,
          channelId,
          huddleId,
          actorUserId: userId,
          scope,
          legacyRow: legacyHint,
          source: "huddle:end",
          repair: Boolean(legacyHint),
          client,
        });
        session = ensured.session;
      }
      if (!session) {
        session = await findHuddleSessionByLegacy({
          workspaceId,
          legacyChannelKey: channelId,
          legacyHuddleId: huddleId,
          client,
        });
      }
      if (!session) throw new Error("session_missing_for_legacy_end");
      assertSessionScope(session, {
        workspaceId,
        channelId,
        huddleId,
        source: "huddle:end",
      });

      const endedSession = await endLegacyHuddleSession({
        workspaceId,
        legacyChannelKey: channelId,
        legacyHuddleId: huddleId,
        endedBy: userId,
        reason,
        client,
      });

      await markSessionParticipantsLeft({
        sessionId: session.id,
        workspaceId,
        client,
      });

      return { session: endedSession || session };
    });
  } catch (err) {
    return fail("legacy_end_dual_write_failed", {
      mismatchType: HUDDLE_MISMATCH_TYPES.MISSING_SESSION,
      workspaceId,
      channelId,
      huddleId,
      actorUserId: userId,
      source: "huddle:end",
      error: err.message,
    });
  }

  try {
    await createHuddleSessionEvent({
      sessionId: stateResult.session.id,
      workspaceId,
      actorUserId: userId || null,
      eventType: "session.ended",
      eventPayload: {
        channelId,
        huddleId,
        username,
        reason,
        compatibilitySource: "legacy_socket",
      },
    });
    return success({ ...stateResult, eventWriteOk: true });
  } catch (err) {
    await reportSessionFailure("legacy_end_event_write_failed", {
      mismatchType: HUDDLE_MISMATCH_TYPES.EVENT_MISMATCH,
      sessionId: stateResult.session.id,
      workspaceId,
      channelId,
      huddleId,
      actorUserId: userId,
      source: "huddle:end",
      missingEvents: ["session.ended"],
      error: err.message,
    });
    return success({ ...stateResult, eventWriteOk: false });
  }
}

export async function shadowReadLegacyHuddle({
  workspaceId,
  channelId,
  huddleId = null,
  actorUserId = null,
  scope = {},
  source = "unknown",
}) {
  return getActiveLegacyHuddle({
    workspaceId,
    channelId,
    huddleId,
    actorUserId,
    scope,
    source,
    repair: true,
  });
}

export async function verifyParticipantSnapshot({
  workspaceId,
  channelId,
  huddleId,
  expectedParticipantIds = [],
  actorUserId = null,
  source = "participant_snapshot",
}) {
  try {
    const legacy = await findActiveLegacyChatHuddle({
      workspaceId,
      legacyChannelKey: channelId,
      legacyHuddleId: huddleId,
    });
    const session = await findHuddleSessionByLegacy({
      workspaceId,
      legacyChannelKey: channelId,
      legacyHuddleId: huddleId,
    });
    const mismatches = await classifySessionMismatches({
      workspaceId,
      legacy,
      session,
      actorUserId,
      source,
      expectedParticipantIds,
    });
    return success({ legacy, session, mismatches });
  } catch (err) {
    return fail("participant_snapshot_verification_failed", {
      mismatchType: HUDDLE_MISMATCH_TYPES.PARTICIPANT_MISMATCH,
      workspaceId,
      channelId,
      huddleId,
      actorUserId,
      source,
      error: err.message,
    });
  }
}

export async function validateMigrationReadiness() {
  const requiredTables = [
    "huddle_sessions",
    "huddle_session_participants",
    "huddle_session_events",
    "huddle_participant_devices",
    "huddle_guests",
    "huddle_artifacts",
    "huddle_recovery_fences",
    "huddle_restore_attempts",
  ];
  const requiredConstraints = [
    "chat_huddles_workspace_id_fkey",
    "chat_huddles_active_workspace_check",
    "huddle_sessions_channel_workspace_fk",
    "huddle_sessions_thread_workspace_fk",
    "huddle_participants_session_workspace_fk",
    "huddle_participants_guest_workspace_fk",
    "huddle_devices_session_workspace_fk",
    "huddle_devices_participant_session_workspace_fk",
    "huddle_devices_guest_workspace_fk",
    "huddle_events_session_workspace_fk",
    "huddle_events_actor_guest_workspace_fk",
    "huddle_events_actor_identity_check",
    "huddle_artifacts_session_workspace_fk",
    "huddle_artifacts_source_event_session_workspace_fk",
  ];
  try {
    const [tableResult, columnResult, constraintResult] = await Promise.all([
      pool.query(
        `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])
        `,
        [requiredTables]
      ),
      pool.query(
        `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'chat_huddles'
          AND column_name = 'workspace_id'
        `
      ),
      pool.query(
        `
        SELECT conname, convalidated
        FROM pg_constraint
        WHERE conname = ANY($1::text[])
        `,
        [requiredConstraints]
      ),
    ]);
    const present = new Set(tableResult.rows.map((row) => row.table_name));
    const missing = requiredTables.filter((table) => !present.has(table));
    const constraintMap = new Map(
      constraintResult.rows.map((row) => [row.conname, row.convalidated])
    );
    const missingConstraints = requiredConstraints.filter(
      (constraint) => !constraintMap.has(constraint)
    );
    const unvalidatedConstraints = requiredConstraints.filter(
      (constraint) => constraintMap.get(constraint) === false
    );
    const legacyWorkspaceScoped = columnResult.rows.length > 0;
    return {
      ok:
        missing.length === 0 &&
        legacyWorkspaceScoped &&
        missingConstraints.length === 0 &&
        unvalidatedConstraints.length === 0,
      requiredTables,
      missing,
      legacyWorkspaceScoped,
      requiredConstraints,
      missingConstraints,
      unvalidatedConstraints,
    };
  } catch (err) {
    return {
      ok: false,
      requiredTables,
      missing: requiredTables,
      legacyWorkspaceScoped: false,
      requiredConstraints,
      missingConstraints: requiredConstraints,
      unvalidatedConstraints: [],
      error: err.message,
    };
  }
}

export default {
  HUDDLE_MISMATCH_TYPES,
  startLegacyHuddle,
  getActiveLegacyHuddle,
  listRecentActiveLegacyHuddles,
  endLegacyHuddle,
  recordLegacyHuddleStart,
  recordLegacyHuddleJoin,
  recordLegacyHuddleLeave,
  recordLegacyHuddleDecline,
  recordLegacyHuddleEnd,
  shadowReadLegacyHuddle,
  verifyParticipantSnapshot,
  validateMigrationReadiness,
};
