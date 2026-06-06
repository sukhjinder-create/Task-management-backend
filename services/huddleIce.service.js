const DEFAULT_TURN_URL = "global.relay.metered.ca";

function buildBaseIceServers() {
  return [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun.relay.metered.ca:80" },
    {
      urls: [
        "turn:openrelay.metered.ca:80",
        "turn:openrelay.metered.ca:443",
        "turn:openrelay.metered.ca:443?transport=tcp",
        "turn:openrelay.metered.ca:80?transport=tcp",
      ],
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ];
}

export function getIceServers(env = process.env) {
  const iceServers = buildBaseIceServers();
  const turnUser = env.TURN_USERNAME;
  const turnCred = env.TURN_CREDENTIAL;
  const turnUrl = env.TURN_URL || DEFAULT_TURN_URL;

  if (turnUser && turnCred) {
    iceServers.push(
      { urls: `turn:${turnUrl}:80`, username: turnUser, credential: turnCred },
      { urls: `turn:${turnUrl}:80?transport=tcp`, username: turnUser, credential: turnCred },
      { urls: `turn:${turnUrl}:443`, username: turnUser, credential: turnCred },
      { urls: `turns:${turnUrl}:443?transport=tcp`, username: turnUser, credential: turnCred }
    );
  }

  return iceServers;
}

export function getIceServersPayload(env = process.env) {
  return {
    iceServers: getIceServers(env),
  };
}

export default {
  getIceServers,
  getIceServersPayload,
};
