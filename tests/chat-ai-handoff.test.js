import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import { emitToAI } from "../services/chat.service.js";
import { getEffectiveTranscriptionPolicy } from "../services/huddleTranscriptionPipeline.service.js";

test("AI handoff reports a failed delivery instead of silently succeeding", async () => {
  const originalPost = axios.post;
  const originalUrl = process.env.AI_SERVICE_URL;
  const originalSecret = process.env.AI_SERVICE_SECRET;
  try {
    process.env.AI_SERVICE_URL = "http://localhost/internal/chat-event";
    process.env.AI_SERVICE_SECRET = "test-secret";
    axios.post = async () => { throw new Error("AI service unavailable"); };
    await assert.rejects(emitToAI({ type: "chat:new-message" }), /AI service unavailable/);
  } finally {
    axios.post = originalPost;
    if (originalUrl === undefined) delete process.env.AI_SERVICE_URL;
    else process.env.AI_SERVICE_URL = originalUrl;
    if (originalSecret === undefined) delete process.env.AI_SERVICE_SECRET;
    else process.env.AI_SERVICE_SECRET = originalSecret;
  }
});

test("global transcription disable also disables stored session policy", async () => {
  const original = process.env.HUDDLE_TRANSCRIPTION_ENABLED;
  const client = { query: async () => ({ rows: [{ enabled: true }] }) };
  try {
    process.env.HUDDLE_TRANSCRIPTION_ENABLED = "false";
    const disabled = await getEffectiveTranscriptionPolicy({ workspaceId: "workspace", sessionId: "session", client });
    assert.equal(disabled.enabled, false);
    process.env.HUDDLE_TRANSCRIPTION_ENABLED = "true";
    const enabled = await getEffectiveTranscriptionPolicy({ workspaceId: "workspace", sessionId: "session", client });
    assert.equal(enabled.enabled, true);
  } finally {
    if (original === undefined) delete process.env.HUDDLE_TRANSCRIPTION_ENABLED;
    else process.env.HUDDLE_TRANSCRIPTION_ENABLED = original;
  }
});
