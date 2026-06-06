function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePrefix(value, prefix) {
  const raw = safeString(value);
  if (!raw) return "";
  return raw.startsWith(`${prefix}:`) ? raw : `${prefix}:${raw}`;
}

export function normalizeHuddleDeviceIdentity({
  deviceId = null,
  socketId = null,
  userId = null,
  guestId = null,
  platform = null,
} = {}) {
  const explicitDeviceId = safeString(deviceId);
  const explicitSocketId = safeString(socketId);
  const participantId = safeString(userId) || safeString(guestId);

  if (explicitDeviceId) {
    return {
      logicalDeviceId: normalizePrefix(explicitDeviceId, "device"),
      deviceId: explicitDeviceId,
      socketId: explicitSocketId || null,
      platform: safeString(platform) || null,
      source: "device_id",
    };
  }

  if (explicitSocketId) {
    return {
      logicalDeviceId: normalizePrefix(explicitSocketId, "socket"),
      deviceId: null,
      socketId: explicitSocketId,
      platform: safeString(platform) || null,
      source: "socket_id",
    };
  }

  return {
    logicalDeviceId: normalizePrefix(participantId || "unknown", "legacy"),
    deviceId: null,
    socketId: null,
    platform: safeString(platform) || null,
    source: "legacy_participant",
  };
}

export default {
  normalizeHuddleDeviceIdentity,
};
