import axios from "axios";

export const HUDDLE_STT_PROVIDERS = Object.freeze({
  DEEPGRAM: "deepgram",
  OPENAI: "openai",
  GROQ: "groq",
  ASSEMBLYAI: "assemblyai",
  LIVEKIT_NATIVE: "livekit_native",
  MOCK: "mock",
});

export const HUDDLE_STT_PROVIDER_FEATURES = Object.freeze({
  realtime: "realtime",
  partials: "partials",
  finals: "finals",
  retractions: "retractions",
  speakerAttribution: "speaker_attribution",
  browserToken: "browser_token",
});

const DEFAULT_DEEPGRAM_MODEL = "nova-3";
const DEFAULT_DEEPGRAM_LANGUAGE = "multi";
const DEFAULT_DEEPGRAM_TOKEN_TTL_SECONDS = 300;

function safeString(value, maxLength = null) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return maxLength ? normalized.slice(0, maxLength) : normalized;
}

function boolEnv(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function intEnv(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) ? number : fallback;
}

function selectedProvider(env = process.env) {
  const requested = safeString(env.HUDDLE_TRANSCRIPTION_PROVIDER || env.HUDDLE_STT_PROVIDER).toLowerCase();
  if (Object.values(HUDDLE_STT_PROVIDERS).includes(requested)) return requested;
  return HUDDLE_STT_PROVIDERS.DEEPGRAM;
}

export function getHuddleSttConfig(env = process.env) {
  const provider = selectedProvider(env);
  const enabled = boolEnv(env.HUDDLE_TRANSCRIPTION_ENABLED, false);
  const deepgramApiKey = safeString(env.DEEPGRAM_API_KEY);
  return {
    enabled,
    provider,
    model: safeString(env.HUDDLE_TRANSCRIPTION_MODEL, 80) || DEFAULT_DEEPGRAM_MODEL,
    language: safeString(env.HUDDLE_TRANSCRIPTION_LANGUAGE, 32) || DEFAULT_DEEPGRAM_LANGUAGE,
    tokenTtlSeconds: Math.min(
      Math.max(intEnv(env.HUDDLE_TRANSCRIPTION_TOKEN_TTL_SECONDS, DEFAULT_DEEPGRAM_TOKEN_TTL_SECONDS), 30),
      3600
    ),
    requireConsent: boolEnv(env.HUDDLE_TRANSCRIPTION_REQUIRE_CONSENT, false),
    captionsEnabled: boolEnv(env.HUDDLE_CAPTIONS_ENABLED, true),
    transcriptArtifactsEnabled: boolEnv(env.HUDDLE_TRANSCRIPT_ARTIFACTS_ENABLED, true),
    deepgram: {
      apiKeyConfigured: Boolean(deepgramApiKey),
      endpoint: safeString(env.DEEPGRAM_LISTEN_URL, 300) || "wss://api.deepgram.com/v1/listen",
      grantUrl: safeString(env.DEEPGRAM_GRANT_URL, 300) || "https://api.deepgram.com/v1/auth/grant",
    },
  };
}

export function getProviderCapabilities(provider = HUDDLE_STT_PROVIDERS.DEEPGRAM) {
  const normalized = safeString(provider).toLowerCase();
  const common = [
    HUDDLE_STT_PROVIDER_FEATURES.realtime,
    HUDDLE_STT_PROVIDER_FEATURES.partials,
    HUDDLE_STT_PROVIDER_FEATURES.finals,
  ];
  if (normalized === HUDDLE_STT_PROVIDERS.DEEPGRAM) {
    return [
      ...common,
      HUDDLE_STT_PROVIDER_FEATURES.retractions,
      HUDDLE_STT_PROVIDER_FEATURES.speakerAttribution,
      HUDDLE_STT_PROVIDER_FEATURES.browserToken,
    ];
  }
  if (normalized === HUDDLE_STT_PROVIDERS.LIVEKIT_NATIVE) {
    return [
      ...common,
      HUDDLE_STT_PROVIDER_FEATURES.speakerAttribution,
    ];
  }
  return common;
}

export function buildDeepgramListenUrl({
  model,
  language,
  endpoint = "wss://api.deepgram.com/v1/listen",
  metadata = {},
} = {}) {
  const url = new URL(endpoint);
  url.searchParams.set("model", safeString(model, 80) || DEFAULT_DEEPGRAM_MODEL);
  if (language) url.searchParams.set("language", safeString(language, 32));
  url.searchParams.set("interim_results", "true");
  url.searchParams.set("smart_format", "true");
  url.searchParams.set("punctuate", "true");
  url.searchParams.set("utterance_end_ms", "1000");
  if (safeString(language).toLowerCase() === "multi") {
    url.searchParams.set("endpointing", "100");
  }
  url.searchParams.set("vad_events", "true");
  url.searchParams.set("diarize", "false");
  url.searchParams.set("tag", "asystence_huddle");
  if (metadata.workspaceId) url.searchParams.set("workspace_id", safeString(metadata.workspaceId, 80));
  if (metadata.sessionId) url.searchParams.set("session_id", safeString(metadata.sessionId, 80));
  return url.toString();
}

async function createDeepgramTemporaryToken({
  apiKey,
  grantUrl,
  ttlSeconds,
} = {}) {
  if (!apiKey) {
    const err = new Error("deepgram_api_key_missing");
    err.statusCode = 503;
    err.reason = "deepgram_api_key_missing";
    throw err;
  }
  const response = await axios.post(
    grantUrl || "https://api.deepgram.com/v1/auth/grant",
    { ttl_seconds: ttlSeconds },
    {
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    }
  );
  return {
    accessToken: response.data?.access_token,
    expiresIn: Number(response.data?.expires_in) || ttlSeconds,
  };
}

export async function createSttProviderGrant({
  workspaceId,
  sessionId,
  participantId = null,
  provider = null,
  language = null,
  env = process.env,
} = {}) {
  const config = getHuddleSttConfig(env);
  const selected = provider || config.provider;
  if (!config.enabled) {
    const err = new Error("huddle_transcription_disabled");
    err.statusCode = 503;
    err.reason = "huddle_transcription_disabled";
    throw err;
  }
  if (selected !== HUDDLE_STT_PROVIDERS.DEEPGRAM) {
    const err = new Error("stt_provider_not_implemented");
    err.statusCode = 501;
    err.reason = "stt_provider_not_implemented";
    throw err;
  }

  const token = await createDeepgramTemporaryToken({
    apiKey: env.DEEPGRAM_API_KEY,
    grantUrl: config.deepgram.grantUrl,
    ttlSeconds: config.tokenTtlSeconds,
  });
  const resolvedLanguage = safeString(language, 32) || config.language;
  const listenUrl = buildDeepgramListenUrl({
    model: config.model,
    language: resolvedLanguage,
    endpoint: config.deepgram.endpoint,
    metadata: { workspaceId, sessionId, participantId },
  });

  return {
    provider: HUDDLE_STT_PROVIDERS.DEEPGRAM,
    model: config.model,
    language: resolvedLanguage,
    capabilities: getProviderCapabilities(HUDDLE_STT_PROVIDERS.DEEPGRAM),
    transport: "provider_token_websocket",
    accessToken: token.accessToken,
    expiresIn: token.expiresIn,
    expiresAt: new Date(Date.now() + token.expiresIn * 1000).toISOString(),
    listenUrl,
  };
}

export function getHuddleSttProviderDiagnostics(env = process.env) {
  const config = getHuddleSttConfig(env);
  const selected = config.provider;
  const providerReady =
    config.enabled &&
    selected === HUDDLE_STT_PROVIDERS.DEEPGRAM &&
    config.deepgram.apiKeyConfigured;
  return {
    ready: providerReady,
    enabled: config.enabled,
    provider: selected,
    productionProvider: HUDDLE_STT_PROVIDERS.DEEPGRAM,
    providerNeutral: true,
    model: config.model,
    language: config.language,
    tokenTtlSeconds: config.tokenTtlSeconds,
    requireConsent: config.requireConsent,
    captionsEnabled: config.captionsEnabled,
    transcriptArtifactsEnabled: config.transcriptArtifactsEnabled,
    capabilities: getProviderCapabilities(selected),
    blockers: [
      !config.enabled ? "huddle_transcription_disabled" : null,
      selected !== HUDDLE_STT_PROVIDERS.DEEPGRAM ? "selected_provider_not_implemented" : null,
      selected === HUDDLE_STT_PROVIDERS.DEEPGRAM && !config.deepgram.apiKeyConfigured
        ? "deepgram_api_key_missing"
        : null,
    ].filter(Boolean),
  };
}

export default {
  HUDDLE_STT_PROVIDERS,
  HUDDLE_STT_PROVIDER_FEATURES,
  getHuddleSttConfig,
  getProviderCapabilities,
  buildDeepgramListenUrl,
  createSttProviderGrant,
  getHuddleSttProviderDiagnostics,
};
