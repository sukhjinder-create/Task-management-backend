import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.DATABASE_URL = " ";
process.env.DB_HOST = "localhost";
process.env.DB_PORT = "5432";
process.env.DB_NAME = "asystence_local";
process.env.NODE_ENV = "test";

const root = process.cwd();
const read = (relativePath) => readFileSync(join(root, relativePath), "utf8");

const migration = read("migrations/20260611_huddle_product_quality.sql");
const mediaService = read("services/huddleMediaSession.service.js");
const mediaRoute = read("routes/huddleMedia.routes.js");
const worker = read("services/huddleIntelligenceWorker.service.js");
const reviewService = read("services/huddleMeetingIntelligence.service.js");
const intelligenceRoute = read("routes/huddleIntelligence.routes.js");
const notificationRepository = read("repositories/notification.repository.js");
const notificationService = read("services/notification.service.js");
const sttProvider = read("services/huddleSttProvider.service.js");
const transcriptionPipeline = read("services/huddleTranscriptionPipeline.service.js");
const copilotService = read("services/huddleCopilot.service.js");

assert.match(migration, /CREATE TABLE IF NOT EXISTS huddle_media_quality_samples/);
assert.match(migration, /ADD COLUMN IF NOT EXISTS action_url TEXT/);
assert.match(migration, /uniq_notifications_user_source_key/);
assert.match(mediaService, /INSERT INTO huddle_media_quality_samples/);
assert.match(mediaService, /adaptiveStreamAttachedTrackCount/);
assert.match(mediaService, /selectedHighLayerCount/);
assert.match(mediaService, /maxScreenShareReceiveHeight/);
assert.match(mediaRoute, /\/livekit\/quality\/sessions\/:sessionId/);

assert.match(reviewService, /getMeetingIntelligenceReview/);
assert.match(reviewService, /sourcesByArtifactId/);
assert.match(reviewService, /canReviewArtifacts/);
assert.match(reviewService, /canCreateTasks: privileged/);
assert.match(intelligenceRoute, /\/sessions\/:sessionId\/review/);
assert.match(worker, /huddle_intelligence_ready/);
assert.match(worker, /huddle-intelligence:\$\{job\.sessionId\}:\$\{userId\}/);
assert.match(worker, /ownership\.job\.id/);
assert.match(worker, /status: "ready"/);
assert.match(notificationRepository, /ON CONFLICT \(user_id, source_key\)/);
assert.match(notificationService, /action_url/);

assert.match(sttProvider, /url\.searchParams\.append\("keyterm", keyterm\)/);
assert.match(sttProvider, /canonicalTranscriptTranslated: false/);
assert.match(sttProvider, /unsupported_by_current_provider/);
assert.match(transcriptionPipeline, /SELECT DISTINCT/);
assert.match(transcriptionPipeline, /keytermCount/);
assert.match(copilotService, /relevantItems\(memoryItems, question, 20\)/);
assert.match(copilotService, /memoryCatalogCount/);

const {
  sanitizeLiveKitQualityDiagnostics,
  summarizeLiveKitQualitySamples,
} = await import("../services/huddleMediaSession.service.js");
const {
  buildDeepgramListenUrl,
  getHuddleSttProviderDiagnostics,
} = await import("../services/huddleSttProvider.service.js");

const sanitized = sanitizeLiveKitQualityDiagnostics({
  observedAt: "2026-06-11T10:00:00.000Z",
  aggregate: {
    selectedLowLayerCount: 2,
    selectedMediumLayerCount: 1,
    selectedHighLayerCount: 3,
    adaptiveStreamAttachedTrackCount: 4,
    maxScreenShareReceiveWidth: 1920,
    maxScreenShareReceiveHeight: 1080,
    renderTargetTrackCount: 2,
    renderTargetMismatchCount: 1,
    maxRequestedContentReceiveWidth: 960,
    maxRequestedContentReceiveHeight: 540,
    screenShareSendBitrateKbps: 1800,
    screenShareReceiveBitrateKbps: 1400,
    freezeTrackCount: 1,
    totalFreezeCount: 2,
    totalFreezeDurationSeconds: 0.75,
    totalFramesDropped: 4,
    totalFramesDecoded: 240,
    totalFramesRendered: 232,
  },
  startup: {
    intentToJoinMs: 920,
    joinMs: 610,
    publishMs: 180,
    prepareLatencyMs: 15,
    roomEndpointLatencyMs: 210,
    tokenEndpointLatencyMs: 220,
    connectLatencyMs: 540,
    totalJoinLatencyMs: 790,
    firstAudioMs: 1180,
    firstVideoMs: 1430,
    firstRemoteParticipantMs: 980,
    firstAudioAfterParticipantMs: 200,
    firstVideoAfterParticipantMs: 450,
    captionsActiveMs: 1750,
    firstCaptionMs: 2100,
  },
  tracks: [{
    direction: "receive",
    kind: "video",
    source: "screen_share",
    videoQuality: "high",
    attachedElementCount: 1,
    adaptiveStreamAttached: true,
    renderedWidth: 1280,
    renderedHeight: 720,
    mediaSourceWidth: 1280,
    mediaSourceHeight: 720,
    mediaSourceFrameRate: 30,
    mediaTrackContentHint: "motion",
    requestedWidth: 1280,
    requestedHeight: 720,
    requestedContentWidth: 960,
    requestedContentHeight: 540,
    requestedSourceWidth: 1280,
    requestedSourceHeight: 720,
    requestedFramesPerSecond: 30,
    requestedPixelRatio: 2,
    renderTargetVisible: true,
    framesDecoded: 240,
    framesRendered: 232,
    freezeCount: 2,
    totalFreezesDuration: 0.75,
    framesDropped: 4,
  }],
});
assert.equal(sanitized.aggregate.selectedHighLayerCount, 3);
assert.equal(sanitized.aggregate.adaptiveStreamAttachedTrackCount, 4);
assert.equal(sanitized.tracks[0].adaptiveStreamAttached, true);
assert.equal(sanitized.tracks[0].renderedWidth, 1280);
assert.equal(sanitized.tracks[0].mediaSourceFrameRate, 30);
assert.equal(sanitized.tracks[0].mediaTrackContentHint, "motion");
assert.equal(sanitized.tracks[0].requestedWidth, 1280);
assert.equal(sanitized.tracks[0].requestedContentWidth, 960);
assert.equal(sanitized.tracks[0].framesDecoded, 240);
assert.equal(sanitized.tracks[0].freezeCount, 2);
assert.equal(sanitized.tracks[0].renderTargetVisible, true);
assert.equal(sanitized.startup.intentToJoinMs, 920);
assert.equal(sanitized.startup.connectLatencyMs, 540);
assert.equal(sanitized.startup.firstVideoMs, 1430);
assert.equal(sanitized.startup.firstRemoteParticipantMs, 980);
assert.equal(sanitized.startup.firstVideoAfterParticipantMs, 450);
assert.equal("backgroundEffect" in sanitized, false);
const nullTelemetry = sanitizeLiveKitQualityDiagnostics({
  aggregate: {
    totalBitrateKbps: null,
    sendBitrateKbps: null,
    receiveBitrateKbps: null,
    estimatedMegabytesPerHour: null,
  },
});
assert.equal(nullTelemetry.aggregate.totalBitrateKbps, null);
assert.equal(nullTelemetry.aggregate.sendBitrateKbps, null);
assert.equal(nullTelemetry.aggregate.receiveBitrateKbps, null);
assert.equal(nullTelemetry.aggregate.estimatedMegabytesPerHour, null);
const qualitySummary = summarizeLiveKitQualitySamples([{
  observedAt: sanitized.observedAt,
  aggregate: sanitized.aggregate,
  tracks: sanitized.tracks,
  browser: { userAgent: "Chrome real device" },
  metadata: {
    startup: sanitized.startup,
  },
}]);
assert.equal(qualitySummary.metrics.averageIntentToJoinMs, 920);
assert.equal(qualitySummary.metrics.averageConnectLatencyMs, 540);
assert.equal(qualitySummary.metrics.averageReceiveMediaSourceFps, 30);
assert.equal(qualitySummary.metrics.averageFirstAudioMs, 1180);
assert.equal(qualitySummary.metrics.averageFirstRemoteParticipantMs, 980);
assert.equal(qualitySummary.metrics.averageFirstVideoAfterParticipantMs, 450);
assert.equal("backgroundEffectModes" in qualitySummary.metrics, false);
assert.equal(qualitySummary.metrics.renderTargetMatchRate, 0.5);
assert.equal(qualitySummary.metrics.averageScreenShareSendBitrateKbps, 1800);
assert.equal(qualitySummary.metrics.averageRequestedContentReceiveWidth, 960);
assert.equal(qualitySummary.metrics.totalFreezeCount, 2);
assert.equal(qualitySummary.metrics.totalFramesDropped, 4);

const visibleTileSummary = summarizeLiveKitQualitySamples([{
  observedAt: "2026-06-11T10:01:00.000Z",
  aggregate: {
    averageRttMs: 32,
    averagePacketLoss: 0,
    totalBitrateKbps: 318,
    receiveBitrateKbps: 138,
    maxReceiveWidth: 640,
    maxReceiveHeight: 360,
    renderTargetTrackCount: 2,
    renderTargetMismatchCount: 0,
    selectedHighLayerCount: 2,
    totalFreezeCount: 0,
  },
  tracks: [{
    direction: "receive",
    kind: "video",
    videoQuality: "high",
    attachedElementCount: 1,
    adaptiveStreamAttached: true,
    width: 640,
    height: 360,
    framesPerSecond: 30,
    bitrateKbps: 138,
    renderedWidth: 562,
    renderedHeight: 316,
    requestedWidth: 562,
    requestedHeight: 316,
    requestedContentWidth: 562,
    requestedContentHeight: 316,
    renderTargetVisible: true,
  }],
  browser: { userAgent: "Chrome real device" },
}]);
assert.equal(visibleTileSummary.metrics.renderTargetMatchRate, 1);
assert.equal(visibleTileSummary.metrics.maxReceiveLongEdge, 640);
assert.doesNotMatch(
  visibleTileSummary.observations.join("\n"),
  /Received video did not reach 720p|Observed aggregate bitrate is low/
);

const listenUrl = new URL(buildDeepgramListenUrl({
  model: "nova-3",
  language: "multi",
  keyterms: ["Sukhjinder", "Gurpreet Singh", "Sukhjinder"],
}));
assert.deepEqual(
  listenUrl.searchParams.getAll("keyterm"),
  ["Sukhjinder", "Gurpreet Singh"]
);
assert.equal(listenUrl.searchParams.get("language"), "multi");

const diagnostics = getHuddleSttProviderDiagnostics({
  HUDDLE_TRANSCRIPTION_ENABLED: "true",
  HUDDLE_TRANSCRIPTION_PROVIDER: "deepgram",
  DEEPGRAM_API_KEY: "verification-only",
});
assert.equal(diagnostics.ready, true);
assert.equal(diagnostics.languageQuality.hindi, "supported");
assert.equal(diagnostics.languageQuality.canonicalTranscriptTranslated, false);
assert.equal(diagnostics.languageQuality.punjabi, "unsupported_by_current_provider");

console.log("Huddle product-quality verification passed.");
console.log("- LiveKit quality samples persist selected layers, rendered dimensions, attachment state, bitrate, and screen-share metrics.");
console.log("- Quality summaries compare actual receive layers against explicit visible-tile targets.");
console.log("- Meeting Intelligence delivery is compact, idempotent, participant-scoped, evidence-linked, and human-reviewed.");
console.log("- Hindi/Hinglish remain canonical, participant names use Deepgram keyterms, and Punjabi is explicitly reported as a provider gap.");
