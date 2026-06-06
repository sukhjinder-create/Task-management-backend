import { normalizeHuddleDeviceIdentity } from "../../services/huddleDeviceIdentity.service.js";

function defaultWorkspaceRoomName(channelKey, workspaceId = "GLOBAL") {
  const ws = workspaceId || "GLOBAL";
  return `workspace:${ws}:channel:${channelKey}`;
}

function normalizeUserId(userId) {
  return String(userId || "");
}

function deviceRecord({ userId, username = "", socketId = null, deviceId = null, platform = null } = {}) {
  const identity = normalizeHuddleDeviceIdentity({ userId, socketId, deviceId, platform });
  return {
    userId: normalizeUserId(userId),
    username,
    socketId: socketId || null,
    deviceId: deviceId || null,
    logicalDeviceId: identity.logicalDeviceId,
    platform: platform || null,
    source: identity.source,
    joinedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  };
}

function deviceMatches(device, { socketId = null, logicalDeviceId = null, userId = null } = {}) {
  if (!device) return false;
  if (socketId && device.socketId === socketId) return true;
  if (logicalDeviceId && device.logicalDeviceId === logicalDeviceId) return true;
  if (!socketId && !logicalDeviceId && userId) return device.userId === normalizeUserId(userId);
  return false;
}

export class LocalRealtimeProvider {
  constructor({ io = null, workspaceRoomName = defaultWorkspaceRoomName } = {}) {
    this.io = io;
    this.workspaceRoomName = workspaceRoomName;
    this.rooms = new Map();
  }

  configure({ io = this.io, workspaceRoomName = this.workspaceRoomName } = {}) {
    this.io = io;
    this.workspaceRoomName = workspaceRoomName || defaultWorkspaceRoomName;
  }

  roomKey(workspaceId, huddleId) {
    return `${String(workspaceId)}:${String(huddleId)}`;
  }

  getRawRoom({ workspaceId, huddleId }) {
    return this.rooms.get(this.roomKey(workspaceId, huddleId)) || null;
  }

  ensureDeviceState(room) {
    if (!room.devices) room.devices = new Map();
    if (!room.participants) room.participants = new Set();
    if (!room.participantNames) room.participantNames = new Map();
    for (const uid of room.participants) {
      const userId = normalizeUserId(uid);
      const hasDevice = Array.from(room.devices.values()).some((device) => device.userId === userId);
      if (!hasDevice) {
        const record = deviceRecord({
          userId,
          username: room.participantNames.get(userId) || "",
        });
        room.devices.set(record.logicalDeviceId, record);
      }
    }
  }

  refreshParticipants(room) {
    this.ensureDeviceState(room);
    const activeUserIds = new Set(Array.from(room.devices.values()).map((device) => device.userId));
    room.participants = activeUserIds;
    for (const uid of Array.from(room.participantNames.keys())) {
      if (!activeUserIds.has(uid)) room.participantNames.delete(uid);
    }
  }

  snapshot(room) {
    if (!room) return null;
    this.refreshParticipants(room);
    const participantIds = Array.from(room.participants || []).map(String);
    const devices = Array.from(room.devices?.values() || []).map((device) => ({
      userId: device.userId,
      socketId: device.socketId,
      deviceId: device.deviceId,
      logicalDeviceId: device.logicalDeviceId,
      platform: device.platform,
      lastSeenAt: device.lastSeenAt,
    }));
    return {
      huddleId: room.huddleId,
      channelId: room.channelId,
      workspaceId: room.workspaceId,
      participantIds,
      participantCount: participantIds.length,
      deviceCount: devices.length,
      participants: participantIds.map((uid) => ({
        userId: uid,
        username: room.participantNames?.get(uid) || "",
      })),
      devices,
      startedBy: room.startedBy || null,
      startedAt: room.startedAt || null,
      scope: room.scope || null,
      sessionId: room.sessionId || null,
    };
  }

  getRoom({ workspaceId, huddleId }) {
    return this.snapshot(this.getRawRoom({ workspaceId, huddleId }));
  }

  createRoom({
    workspaceId,
    huddleId,
    channelId,
    participants = [],
    participantNames = {},
    startedBy = null,
    startedAt = null,
    scope = null,
    sessionId = null,
  }) {
    const names =
      participantNames instanceof Map
        ? participantNames
        : new Map(Object.entries(participantNames || {}).map(([id, name]) => [String(id), name]));
    const devices = new Map();
    for (const participant of participants || []) {
      const userId = normalizeUserId(typeof participant === "object" ? participant.userId : participant);
      if (!userId) continue;
      const username = typeof participant === "object" ? participant.username || "" : "";
      if (username) names.set(userId, username);
      const record = deviceRecord({
        userId,
        username,
        socketId: typeof participant === "object" ? participant.socketId || null : null,
        deviceId: typeof participant === "object" ? participant.deviceId || null : null,
        platform: typeof participant === "object" ? participant.platform || null : null,
      });
      devices.set(record.logicalDeviceId, record);
    }

    const room = {
      huddleId,
      channelId,
      workspaceId,
      participants: new Set(Array.from(devices.values()).map((device) => device.userId)),
      participantNames: names,
      devices,
      startedBy,
      startedAt,
      scope,
      sessionId,
    };
    this.rooms.set(this.roomKey(workspaceId, huddleId), room);
    return this.snapshot(room);
  }

  deleteRoom({ workspaceId, huddleId }) {
    return this.rooms.delete(this.roomKey(workspaceId, huddleId));
  }

  roomMatches(room, { channelId, huddleId, workspaceId }) {
    return (
      room &&
      String(room.channelId) === String(channelId) &&
      String(room.workspaceId) === String(workspaceId) &&
      (!huddleId || this.getRawRoom({ workspaceId, huddleId }) === room)
    );
  }

  ensureRoomFromActive({ scope, huddleId, active }) {
    const existing = this.getRawRoom({ workspaceId: scope.workspaceId, huddleId });
    if (existing) return this.snapshot(existing);

    return this.createRoom({
      huddleId,
      channelId: scope.channelId,
      workspaceId: scope.workspaceId,
      participants: [],
      startedBy: {
        userId: String(active.started_by),
        username: active.starter_username || "Someone",
      },
      startedAt: active.started_at,
      scope,
      sessionId: active.session_id || null,
    });
  }

  updateRoomContext({ workspaceId, huddleId, scope = null, sessionId = null }) {
    const room = this.getRawRoom({ workspaceId, huddleId });
    if (!room) return null;
    if (scope && !room.scope) room.scope = scope;
    if (sessionId) room.sessionId = sessionId;
    return this.snapshot(room);
  }

  findRoomByChannel({ channelId, workspaceId, userId = null }) {
    for (const room of this.rooms.values()) {
      if (room.channelId !== channelId) continue;
      if (room.workspaceId !== workspaceId) continue;
      this.refreshParticipants(room);
      if (userId && !room.participants?.has(String(userId))) continue;
      return { huddleId: room.huddleId, room: this.snapshot(room) };
    }
    return null;
  }

  getPresence({ workspaceId, huddleId }) {
    return this.getRoom({ workspaceId, huddleId });
  }

  hasParticipant({ workspaceId, huddleId, userId }) {
    const room = this.getRawRoom({ workspaceId, huddleId });
    if (!room) return false;
    this.refreshParticipants(room);
    return Boolean(room.participants?.has(String(userId)));
  }

  joinDevice({
    workspaceId,
    huddleId,
    channelId,
    userId,
    username,
    socketId = null,
    deviceId = null,
    platform = null,
    scope = null,
    sessionId = null,
  }) {
    const room = this.getRawRoom({ workspaceId, huddleId });
    if (!room) return { ok: false, reason: "huddle_room_required", room: null };

    this.ensureDeviceState(room);
    if (scope && !room.scope) room.scope = scope;
    if (sessionId) room.sessionId = sessionId;
    room.channelId = channelId || room.channelId;

    const user = normalizeUserId(userId);
    const identity = normalizeHuddleDeviceIdentity({ userId: user, socketId, deviceId, platform });
    const duplicateDevice = room.devices.has(identity.logicalDeviceId);
    const existingParticipants = Array.from(room.participants || [])
      .filter((uid) => uid !== user)
      .map((uid) => ({ userId: uid, username: room.participantNames.get(uid) || "" }));

    const existingDevice = room.devices.get(identity.logicalDeviceId);
    room.devices.set(identity.logicalDeviceId, {
      ...(existingDevice || {}),
      userId: user,
      username,
      socketId: socketId || existingDevice?.socketId || null,
      deviceId: deviceId || existingDevice?.deviceId || null,
      logicalDeviceId: identity.logicalDeviceId,
      platform: platform || existingDevice?.platform || null,
      source: identity.source,
      joinedAt: existingDevice?.joinedAt || new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    });
    room.participants.add(user);
    room.participantNames.set(user, username);

    const snapshot = this.snapshot(room);
    return {
      ok: true,
      room: snapshot,
      existingParticipants,
      participants: snapshot.participants,
      participantCount: snapshot.participantCount,
      deviceCount: snapshot.deviceCount,
      duplicateDevice,
      logicalDeviceId: identity.logicalDeviceId,
      sessionId: snapshot.sessionId,
    };
  }

  leaveDevice({ workspaceId, huddleId, userId, socketId = null, deviceId = null, logicalDeviceId = null }) {
    const room = this.getRawRoom({ workspaceId, huddleId });
    if (!room) return { ok: false, reason: "huddle_room_required", room: null };
    this.ensureDeviceState(room);

    const user = normalizeUserId(userId);
    const identity = normalizeHuddleDeviceIdentity({ userId: user, socketId, deviceId });
    const targetLogicalDeviceId = logicalDeviceId || (!socketId && deviceId ? identity.logicalDeviceId : null);
    const beforeParticipantPresent = room.participants?.has(user);
    const removedDevices = [];

    for (const [key, device] of Array.from(room.devices.entries())) {
      if (device.userId !== user) continue;
      if (!socketId && !targetLogicalDeviceId) {
        room.devices.delete(key);
        removedDevices.push(device);
        continue;
      }
      if (deviceMatches(device, { socketId, logicalDeviceId: targetLogicalDeviceId, userId: user })) {
        room.devices.delete(key);
        removedDevices.push(device);
      }
    }

    if (!beforeParticipantPresent && removedDevices.length === 0) {
      return { ok: false, reason: "participant_required", room: this.snapshot(room) };
    }

    const stillPresent = Array.from(room.devices.values()).some((device) => device.userId === user);
    if (!stillPresent) {
      room.participants.delete(user);
      room.participantNames?.delete(user);
    }
    const snapshot = this.snapshot(room);
    return {
      ok: true,
      room: snapshot,
      participantCount: snapshot.participantCount,
      deviceCount: snapshot.deviceCount,
      participantStillPresent: stillPresent,
      removedUserIds: stillPresent ? [] : [user],
      removedDevices,
      sessionId: snapshot.sessionId,
    };
  }

  getRecoverySnapshots({ workspaceId, userId }) {
    const snapshots = [];
    for (const room of this.rooms.values()) {
      if (room.workspaceId !== workspaceId) continue;
      this.refreshParticipants(room);
      if (room.participants?.has(String(userId))) continue;
      if (String(room.startedBy?.userId || "") === String(userId)) continue;
      snapshots.push(this.snapshot(room));
    }
    return snapshots;
  }

  leaveUserFromAllRooms({ userId }) {
    const changes = [];
    for (const room of this.rooms.values()) {
      if (!room.participants?.has(String(userId))) continue;
      const result = this.leaveDevice({
        workspaceId: room.workspaceId,
        huddleId: room.huddleId,
        userId,
      });
      if (!result.ok) continue;
      changes.push({
        huddleId: room.huddleId,
        channelId: room.channelId,
        workspaceId: room.workspaceId,
        scope: room.scope || null,
        room: result.room,
        participantCount: result.participantCount,
        deviceCount: result.deviceCount,
        shouldEnd: result.participantCount === 0,
        removedUserIds: result.removedUserIds || [String(userId)],
        sessionId: result.sessionId,
      });
    }
    return changes;
  }

  leaveDeviceFromAllRooms({ userId, socketId = null, deviceId = null, logicalDeviceId = null }) {
    const changes = [];
    for (const room of this.rooms.values()) {
      this.refreshParticipants(room);
      if (!room.participants?.has(String(userId))) continue;
      const result = this.leaveDevice({
        workspaceId: room.workspaceId,
        huddleId: room.huddleId,
        userId,
        socketId,
        deviceId,
        logicalDeviceId,
      });
      if (!result.ok || result.removedDevices.length === 0) continue;
      changes.push({
        huddleId: room.huddleId,
        channelId: room.channelId,
        workspaceId: room.workspaceId,
        scope: room.scope || null,
        room: result.room,
        participantCount: result.participantCount,
        deviceCount: result.deviceCount,
        shouldEnd: result.participantCount === 0,
        participantStillPresent: result.participantStillPresent,
        removedUserIds: result.removedUserIds || [],
        removedDevices: result.removedDevices || [],
        sessionId: result.sessionId,
      });
    }
    return changes;
  }

  joinRealtimeRooms({ socket, scope, channelId, workspaceId }) {
    if (!socket || !scope) return;
    if (scope.type !== "dm" && !scope.isPrivate) {
      socket.join(this.workspaceRoomName(channelId, workspaceId));
    }
  }

  emitToUsers(userIds, event, payload, { exceptUserId = null } = {}) {
    if (!this.io) return;
    for (const uid of new Set((userIds || []).map(String))) {
      if (exceptUserId && uid === String(exceptUserId)) continue;
      this.io.to(uid).emit(event, payload);
    }
  }

  async broadcastInvite({
    scope,
    event,
    payload,
    recipientIds = [],
    exceptUserId = null,
    includeWorkspaceRoom = false,
  }) {
    if (!this.io || !scope) return;
    if (scope.type === "dm" || scope.isPrivate) {
      this.emitToUsers(recipientIds, event, payload, { exceptUserId });
      return;
    }

    this.io.to(this.workspaceRoomName(scope.channelId, scope.workspaceId)).emit(event, payload);
    if (includeWorkspaceRoom) {
      this.io.to(`workspace:${scope.workspaceId}`).emit(event, payload);
    }
  }

  async broadcastLive({ scope, huddleId, event, payload, exceptUserId = null }) {
    if (!this.io || !scope) return;
    if (scope.type === "dm" || scope.isPrivate) {
      const room = this.getRawRoom({ workspaceId: scope.workspaceId, huddleId });
      this.emitToUsers(Array.from(room?.participants || []), event, payload, { exceptUserId });
      return;
    }

    const roomName = this.workspaceRoomName(scope.channelId, scope.workspaceId);
    if (exceptUserId) {
      this.io.to(roomName).except(String(exceptUserId)).emit(event, payload);
      return;
    }
    this.io.to(roomName).emit(event, payload);
  }

  sendToUser({ userId, event, payload }) {
    if (!this.io || !userId || !event) return;
    this.io.to(String(userId)).emit(event, payload);
  }

  sendToDevice({ userId, event, payload }) {
    this.sendToUser({ userId, event, payload });
  }

  recordHeartbeat() {
    return { ok: true, provider: "local", supported: false };
  }

  getDiagnostics() {
    const sessions = Array.from(this.rooms.values()).map((room) => this.snapshot(room));
    return {
      provider: "local",
      sessionCount: sessions.length,
      participantCount: sessions.reduce((sum, session) => sum + session.participantCount, 0),
      deviceCount: sessions.reduce((sum, session) => sum + (session.deviceCount || 0), 0),
      sessions,
    };
  }
}

export default LocalRealtimeProvider;
