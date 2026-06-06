import LocalRealtimeProvider from "../realtime/huddle/localRealtimeProvider.js";
import RedisRealtimeProvider from "../realtime/huddle/redisRealtimeProvider.js";

function isEnabled(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

function createDefaultProvider() {
  const localProvider = new LocalRealtimeProvider();
  if (isEnabled(process.env.HUDDLE_REDIS_ENABLED)) {
    return new RedisRealtimeProvider({
      localProvider,
      redisEnabled: true,
      redisRequired: isEnabled(process.env.HUDDLE_REDIS_REQUIRED),
      shadowWriteEnabled: isEnabled(process.env.HUDDLE_REALTIME_SHADOW_WRITE),
      heartbeatsEnabled: isEnabled(process.env.HUDDLE_HEARTBEATS_ENABLED),
    });
  }
  return localProvider;
}

export class HuddleRealtimeService {
  constructor(provider = createDefaultProvider()) {
    this.provider = provider;
  }

  configure(options = {}) {
    return this.provider.configure(options);
  }

  getProviderType() {
    return this.provider?.getDiagnostics?.()?.provider || "unknown";
  }

  checkHealth(params) {
    if (typeof this.provider.checkHealth === "function") {
      return this.provider.checkHealth(params);
    }
    return Promise.resolve({
      ok: true,
      status: "healthy",
      provider: this.getProviderType(),
      redis: null,
    });
  }

  getRoom(params) {
    return this.provider.getRoom(params);
  }

  createRoom(params) {
    return this.provider.createRoom(params);
  }

  deleteRoom(params) {
    return this.provider.deleteRoom(params);
  }

  ensureRoomFromActive(params) {
    return this.provider.ensureRoomFromActive(params);
  }

  updateRoomContext(params) {
    return this.provider.updateRoomContext(params);
  }

  findRoomByChannel(params) {
    return this.provider.findRoomByChannel(params);
  }

  getPresence(params) {
    return this.provider.getPresence(params);
  }

  hasParticipant(params) {
    return this.provider.hasParticipant(params);
  }

  joinDevice(params) {
    return this.provider.joinDevice(params);
  }

  leaveDevice(params) {
    return this.provider.leaveDevice(params);
  }

  getRecoverySnapshots(params) {
    return this.provider.getRecoverySnapshots(params);
  }

  leaveUserFromAllRooms(params) {
    return this.provider.leaveUserFromAllRooms(params);
  }

  leaveDeviceFromAllRooms(params) {
    if (typeof this.provider.leaveDeviceFromAllRooms === "function") {
      return this.provider.leaveDeviceFromAllRooms(params);
    }
    return this.provider.leaveUserFromAllRooms(params);
  }

  joinRealtimeRooms(params) {
    return this.provider.joinRealtimeRooms(params);
  }

  broadcastInvite(params) {
    return this.provider.broadcastInvite(params);
  }

  broadcastLive(params) {
    return this.provider.broadcastLive(params);
  }

  sendToUser(params) {
    return this.provider.sendToUser(params);
  }

  sendToDevice(params) {
    return this.provider.sendToDevice(params);
  }

  recordHeartbeat(params) {
    return this.provider.recordHeartbeat(params);
  }

  getDiagnostics(params) {
    return this.provider.getDiagnostics(params);
  }

  flushShadowWrites(params) {
    if (typeof this.provider.flushShadowWrites === "function") {
      return this.provider.flushShadowWrites(params);
    }
    return Promise.resolve();
  }
}

const huddleRealtimeService = new HuddleRealtimeService();

export { LocalRealtimeProvider, RedisRealtimeProvider };
export default huddleRealtimeService;
