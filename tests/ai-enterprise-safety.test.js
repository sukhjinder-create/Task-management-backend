import assert from "node:assert/strict";
import test from "node:test";

import { redactPii } from "../ai-platform/safety/pii.js";
import { runOutputSafety, validateOutputSchema } from "../ai-platform/safety/pipeline.js";
import { invoke } from "../ai-platform/gateway.js";
import { createAIRequest, textPart, toLegacyText } from "../ai-platform/contract/index.js";

test("PII redaction is deterministic and never preserves the sensitive value", () => {
  const result = redactPii("Email jane@example.com or call 415-555-1212");
  assert.equal(result.text.includes("jane@example.com"), false);
  assert.match(result.text, /\[REDACTED_EMAIL\]/);
  assert.match(result.text, /\[REDACTED_PHONE\]/);
});

test("minimal JSON schema validation covers required, types, arrays, and closed objects", () => {
  const schema = {
    type: "object",
    required: ["summary", "risks"],
    additionalProperties: false,
    properties: { summary: { type: "string" }, risks: { type: "array", items: { type: "string" } } },
  };
  assert.deepEqual(validateOutputSchema({ summary: "ok", risks: ["late"] }, schema), []);
  assert.ok(validateOutputSchema({ summary: 4, extra: true }, schema).length >= 3);
  assert.equal(runOutputSafety({ text: "not-json", outputSchemaRef: schema }).schemaChecked, true);
});

test("gateway redacts before provider and on returned output when workspace policy enables both", async () => {
  let providerPrompt;
  const req = createAIRequest({ capability: "workspace_assistant", input: [textPart({ text: "jane@example.com" })] });
  const response = await invoke(req, {
    resolve: async () => ({ capabilityKey: "workspace_assistant", providerKey: "mock", adapterType: "mock", providerConfig: {}, model: "m", profileKey: "balanced", promptKey: null }),
    checkPolicies: async () => ({ allowed: true, piiRedaction: "both" }),
    resolvePromptTemplate: async () => null,
    getAdapterFor: () => ({ async generate({ prompt }) { providerPrompt = prompt; return { text: "reply to admin@example.com", usage: {} }; } }),
    resolveCompatibility: () => ({ ok: true }),
    logAiRequest: async () => {},
  });
  assert.equal(providerPrompt, "[REDACTED_EMAIL]");
  assert.equal(toLegacyText(response), "reply to [REDACTED_EMAIL]");
  assert.equal(response.safety.redactions.length, 2);
});
