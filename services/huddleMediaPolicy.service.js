// Server-authoritative LiveKit media policy.
//
// LiveKit's media-quality knobs (publish resolution, simulcast, dynacast,
// adaptiveStream, degradation preference, subscribe quality caps) live on the
// CLIENT's RoomOptions / publish options. Historically each client picked these
// blindly. This service makes the SERVER the single policy authority: it reads
// the session's own quality telemetry (the same samples the diagnostics
// endpoint already collects) plus the joining platform, and emits a concrete
// policy that the client applies verbatim at connect time. That is what turns
// telemetry from "reporting" into "actively improving quality" — a session that
// has been losing packets or bandwidth-limited will hand the next joiner a
// degraded, framerate-preserving policy instead of letting them blast HD into a
// congested path; a clean session hands out full HD.
//
// The policy is intentionally a plain data object (no SDK objects) so it
// serializes into the token response and is consumed identically by web,
// Android, and any future client.

export const MEDIA_POLICY_VERSION = 2;

const RESOLUTION_LADDER = ["h180", "h360", "h540", "h720"];

const RESOLUTION_DIMENSIONS = Object.freeze({
  h180: { width: 320, height: 180 },
  h360: { width: 640, height: 360 },
  h540: { width: 960, height: 540 },
  h720: { width: 1280, height: 720 },
});

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePlatform(platform) {
  const normalized = safeString(platform).toLowerCase();
  if (["android", "ios", "mobile", "flutter", "react-native"].includes(normalized)) {
    return "mobile";
  }
  if (["mobile-browser", "mobile_web", "mobileweb"].includes(normalized)) {
    return "mobile_browser";
  }
  if (["desktop", "electron"].includes(normalized)) return "desktop";
  return "web";
}

function clampResolution(label) {
  return RESOLUTION_LADDER.includes(label) ? label : "h360";
}

function stepDownResolution(label, steps = 1) {
  const index = RESOLUTION_LADDER.indexOf(clampResolution(label));
  return RESOLUTION_LADDER[Math.max(0, index - steps)];
}

// Platform ceilings: the best a given client should ever publish, before
// telemetry-driven degradation is applied. Mobile uplinks and battery budgets
// make HD publishing a poor default; the web/desktop default is HD.
function platformBaseline(platform) {
  switch (platform) {
    case "mobile":
      return {
        maxResolution: "h540",
        maxFramerate: 30,
        videoCodec: "vp8",
        degradationPreference: "maintain-framerate",
      };
    case "mobile_browser":
      return {
        maxResolution: "h540",
        maxFramerate: 30,
        videoCodec: "vp8",
        degradationPreference: "maintain-framerate",
      };
    case "desktop":
    case "web":
    default:
      return {
        maxResolution: "h720",
        maxFramerate: 30,
        videoCodec: "vp8",
        degradationPreference: "balanced",
      };
  }
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Derive a degradation severity (0 = clean, 3 = severe) from the telemetry
// summary. Each network/decode signal contributes; we take the strongest.
function deriveDegradation(summary) {
  if (!summary || !summary.ready) {
    return { level: 0, reasons: [], metricsSeen: false };
  }
  const metrics = summary.metrics || {};
  const reasons = [];
  let level = 0;
  const bump = (to, reason) => {
    if (to > level) level = to;
    reasons.push(reason);
  };

  const loss = numberOrNull(metrics.averagePacketLoss);
  if (loss !== null && loss > 0.08) bump(3, "packet_loss_above_8pct");
  else if (loss !== null && loss > 0.05) bump(2, "packet_loss_above_5pct");
  else if (loss !== null && loss > 0.02) bump(1, "packet_loss_above_2pct");

  const rtt = numberOrNull(metrics.averageRttMs);
  if (rtt !== null && rtt > 400) bump(3, "rtt_above_400ms");
  else if (rtt !== null && rtt > 300) bump(2, "rtt_above_300ms");
  else if (rtt !== null && rtt > 180) bump(1, "rtt_above_180ms");

  const bandwidthLimited = Number(metrics.qualityLimitationReasons?.bandwidth) || 0;
  if (bandwidthLimited > 0) bump(2, "bandwidth_limited_samples");

  const cpuLimited = Number(metrics.qualityLimitationReasons?.cpu) || 0;
  if (cpuLimited > 0) bump(1, "cpu_limited_samples");

  const recvFps = numberOrNull(metrics.averageReceiveFps);
  if (recvFps !== null && recvFps < 15) bump(2, "receive_fps_below_15");
  else if (recvFps !== null && recvFps < 22) bump(1, "receive_fps_below_22");

  if (summary.rating === "poor") bump(2, "session_rating_poor");
  else if (summary.rating === "degraded") bump(1, "session_rating_degraded");

  return { level, reasons, metricsSeen: true };
}

function subscribeQualityForLevel(level) {
  if (level >= 3) return "low";
  if (level >= 2) return "medium";
  return "high";
}

/**
 * Compute the media policy the client should apply for this join.
 *
 * @param {object}  args
 * @param {string}  args.platform           - client platform hint (web/android/...)
 * @param {object}  args.qualitySummary      - output of summarizeLiveKitQualitySamples, or null
 * @param {object}  args.clientCapabilities  - optional client-reported caps (codecs, screen)
 * @returns {object} serializable media policy
 */
export function computeHuddleMediaPolicy({
  platform = "web",
  qualitySummary = null,
  clientCapabilities = null,
} = {}) {
  const resolvedPlatform = normalizePlatform(platform);
  const baseline = platformBaseline(resolvedPlatform);
  const degradation = deriveDegradation(qualitySummary);

  // Step the publish resolution down by the degradation level (capped so we
  // never drop below the lowest layer). Severe loss also pins framerate
  // preservation over resolution and forces dynacast.
  let maxResolution = baseline.maxResolution;
  if (degradation.level >= 1) {
    maxResolution = stepDownResolution(baseline.maxResolution, degradation.level);
  }
  maxResolution = clampResolution(maxResolution);

  let degradationPreference = baseline.degradationPreference;
  if (degradation.level >= 2) degradationPreference = "maintain-framerate";

  let maxFramerate = baseline.maxFramerate;
  if (degradation.level >= 3) maxFramerate = 24;

  // Honour a client codec capability hint when present; otherwise keep VP8 for
  // the widest interop (Safari/older Android included).
  const supportedCodecs = Array.isArray(clientCapabilities?.videoCodecs)
    ? clientCapabilities.videoCodecs.map((codec) => safeString(codec).toLowerCase())
    : [];
  let videoCodec = baseline.videoCodec;
  if (supportedCodecs.includes("vp9") && resolvedPlatform !== "mobile") {
    // VP9 SVC gives better quality-per-bitrate on capable desktops/web.
    videoCodec = "vp9";
  }

  const dims = RESOLUTION_DIMENSIONS[maxResolution];

  // Simulcast layers: publish the chosen ceiling plus two lower fallbacks so the
  // SFU + dynacast can drop to a cheaper layer for constrained subscribers.
  const ceilingIndex = RESOLUTION_LADDER.indexOf(maxResolution);
  const simulcastLayers = RESOLUTION_LADDER.slice(
    Math.max(0, ceilingIndex - 2),
    ceilingIndex + 1
  );

  const subscribeQuality = subscribeQualityForLevel(degradation.level);

  return {
    version: MEDIA_POLICY_VERSION,
    source: degradation.metricsSeen ? "telemetry" : "platform_default",
    platform: resolvedPlatform,
    rating: qualitySummary?.rating || null,
    degradationLevel: degradation.level,
    reasons: degradation.reasons,
    publish: {
      maxResolution,
      maxWidth: dims.width,
      maxHeight: dims.height,
      maxFramerate,
      simulcast: true,
      simulcastLayers,
      dynacast: true,
      degradationPreference,
      videoCodec,
      // Below this many participants the SFU forwards everything anyway, so the
      // client can keep all layers warm; above it dynacast pausing matters more.
      stopPublishingHiddenLayers: degradation.level >= 1,
    },
    subscribe: {
      adaptiveStream: true,
      autoSubscribe: true,
      maxResolution: maxResolution,
      preferredVideoQuality: subscribeQuality,
    },
  };
}

export default computeHuddleMediaPolicy;
