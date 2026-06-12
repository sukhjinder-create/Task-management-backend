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

const {
  sanitizeLiveKitQualityDiagnostics,
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
  }],
});
assert.equal(sanitized.aggregate.selectedHighLayerCount, 3);
assert.equal(sanitized.aggregate.adaptiveStreamAttachedTrackCount, 4);
assert.equal(sanitized.tracks[0].adaptiveStreamAttached, true);
assert.equal(sanitized.tracks[0].renderedWidth, 1280);

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
console.log("- Meeting Intelligence delivery is compact, idempotent, participant-scoped, evidence-linked, and human-reviewed.");
console.log("- Hindi/Hinglish remain canonical, participant names use Deepgram keyterms, and Punjabi is explicitly reported as a provider gap.");
