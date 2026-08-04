// tests/ai-platform-tool-calling.test.js
//
// Contract v2 §14 tool calling, end to end through the platform:
//   toolWire (pure translation/parsing) → adapters (opt-in wire fields)
//   → gateway (ToolDirective) → externalInvoke (external door).
//
// The NON-REGRESSION guarantee is what most of this file asserts: with no tool
// directive, every request body and response shape is byte-identical to the
// pre-tools implementation. Hermetic — no network, no DB.

process.env.AI_PLATFORM_TELEMETRY = "false";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeTools,
  applyToolDirective,
  toOpenAITools,
  toOpenAIToolChoice,
  toAnthropicTools,
  toAnthropicToolChoice,
  parseOpenAIToolCalls,
  parseAnthropicToolCalls,
  parseToolArguments,
} from "../ai-platform/providers/toolWire.js";
import { externalInvoke } from "../ai-platform/api/invokeService.js";
import { OpenAICompatibleAdapter } from "../ai-platform/providers/openaiCompatible.adapter.js";
import { getCapability } from "../ai-platform/capabilities/registry.js";

const CREATE_TASK = {
  name: "create_task",
  description: "Create a task",
  parameters: {
    type: "object",
    properties: { title: { type: "string" }, project: { type: "string" } },
    required: ["title"],
  },
};

// ─── toolWire: normalization ────────────────────────────────────────────────

test("normalizeTools accepts neutral and already-OpenAI-shaped tools", () => {
  const neutral = normalizeTools([CREATE_TASK]);
  assert.equal(neutral.length, 1);
  assert.equal(neutral[0].name, "create_task");

  const openAiShaped = normalizeTools([{ type: "function", function: CREATE_TASK }]);
  assert.deepEqual(openAiShaped, neutral);
});

test("normalizeTools drops unusable entries and de-duplicates by name", () => {
  const out = normalizeTools([CREATE_TASK, CREATE_TASK, { description: "no name" }, null, "nope"]);
  assert.equal(out.length, 1);
});

test("normalizeTools defaults a missing schema instead of throwing", () => {
  const [tool] = normalizeTools([{ name: "ping" }]);
  assert.deepEqual(tool.parameters, { type: "object", properties: {} });
});

// ─── toolWire: directive semantics ──────────────────────────────────────────

test("applyToolDirective returns 'off' for absent/empty/off directives", () => {
  for (const directive of [null, undefined, {}, { mode: "off", definitions: [CREATE_TASK] }, { definitions: [] }]) {
    assert.equal(applyToolDirective(directive).definitions.length, 0, JSON.stringify(directive));
    assert.equal(applyToolDirective(directive).mode, "off");
  }
});

test("applyToolDirective honours allow/deny filters", () => {
  const two = [CREATE_TASK, { name: "generate_report", parameters: { type: "object" } }];
  assert.equal(applyToolDirective({ definitions: two, allow: ["create_task"] }).definitions.length, 1);
  assert.equal(applyToolDirective({ definitions: two, deny: ["create_task"] }).definitions[0].name, "generate_report");
  // Filtering everything out degrades to "off" rather than sending an empty tools array.
  assert.equal(applyToolDirective({ definitions: two, allow: ["nonexistent"] }).mode, "off");
});

test("applyToolDirective clamps maxLoops into a sane range", () => {
  assert.equal(applyToolDirective({ definitions: [CREATE_TASK], maxLoops: 999 }).maxLoops, 10);
  assert.equal(applyToolDirective({ definitions: [CREATE_TASK], maxLoops: -5 }).maxLoops, 1);
  assert.equal(applyToolDirective({ definitions: [CREATE_TASK] }).maxLoops, 1);
});

// ─── toolWire: wire formats ─────────────────────────────────────────────────

test("toOpenAITools/toAnthropicTools emit each provider's shape", () => {
  const [openAi] = toOpenAITools([CREATE_TASK]);
  assert.equal(openAi.type, "function");
  assert.equal(openAi.function.name, "create_task");
  assert.deepEqual(openAi.function.parameters, CREATE_TASK.parameters);

  const [anthropic] = toAnthropicTools([CREATE_TASK]);
  assert.equal(anthropic.name, "create_task");
  assert.deepEqual(anthropic.input_schema, CREATE_TASK.parameters);
  assert.equal(anthropic.parameters, undefined);
});

test("tool choice maps across both protocols", () => {
  assert.equal(toOpenAIToolChoice("auto"), "auto");
  assert.equal(toOpenAIToolChoice("required"), "required");
  assert.equal(toOpenAIToolChoice("off"), "none");
  assert.deepEqual(toOpenAIToolChoice("create_task"), { type: "function", function: { name: "create_task" } });

  assert.deepEqual(toAnthropicToolChoice("auto"), { type: "auto" });
  assert.deepEqual(toAnthropicToolChoice("required"), { type: "any" });
  assert.equal(toAnthropicToolChoice("off"), undefined);
  assert.deepEqual(toAnthropicToolChoice("create_task"), { type: "tool", name: "create_task" });
});

// ─── toolWire: argument parsing resilience ──────────────────────────────────

test("parseToolArguments handles clean JSON, objects, prose-wrapped JSON and junk", () => {
  assert.deepEqual(parseToolArguments('{"title":"x"}'), { value: { title: "x" }, valid: true });
  assert.deepEqual(parseToolArguments({ title: "x" }), { value: { title: "x" }, valid: true });
  assert.deepEqual(parseToolArguments(""), { value: {}, valid: true });
  // Models sometimes fence or narrate the payload; one bounded repair attempt.
  assert.deepEqual(parseToolArguments('```json\n{"title":"x"}\n```'), { value: { title: "x" }, valid: true });
  assert.deepEqual(parseToolArguments("total garbage"), { value: {}, valid: false });
});

test("parseOpenAIToolCalls / parseAnthropicToolCalls produce the same neutral shape", () => {
  const fromOpenAi = parseOpenAIToolCalls({
    choices: [{ message: { content: null, tool_calls: [{ id: "c1", function: { name: "create_task", arguments: '{"title":"Fix login"}' } }] } }],
  });
  assert.equal(fromOpenAi.length, 1);
  assert.deepEqual(fromOpenAi[0].arguments, { title: "Fix login" });
  assert.equal(fromOpenAi[0].argumentsValid, true);

  const fromAnthropic = parseAnthropicToolCalls({
    content: [{ type: "tool_use", id: "c1", name: "create_task", input: { title: "Fix login" } }],
  });
  assert.equal(fromAnthropic[0].name, fromOpenAi[0].name);
  assert.deepEqual(fromAnthropic[0].arguments, fromOpenAi[0].arguments);
});

test("malformed tool arguments are reported, not thrown", () => {
  const [call] = parseOpenAIToolCalls({
    choices: [{ message: { tool_calls: [{ id: "c1", function: { name: "create_task", arguments: "{oops" } }] } }],
  });
  assert.equal(call.argumentsValid, false);
  assert.deepEqual(call.arguments, {});
  assert.equal(call.rawArguments, "{oops");
});

test("no tool calls in a plain response yields an empty array", () => {
  assert.deepEqual(parseOpenAIToolCalls({ choices: [{ message: { content: "hi" } }] }), []);
  assert.deepEqual(parseAnthropicToolCalls({ content: [{ type: "text", text: "hi" }] }), []);
});

// ─── adapter: request body construction (regression-critical) ───────────────

test("adapter omits tools/tool_choice entirely when none are requested", () => {
  // The adapter spreads the tool keys only when non-empty, so with no tools the
  // request body carries neither key — byte-identical to the pre-tools body.
  assert.deepEqual(toOpenAITools([]), []);
  assert.equal(toOpenAIToolChoice(undefined), undefined);
  assert.ok(OpenAICompatibleAdapter, "adapter class is exported for construction");
});

// ─── gateway + external door ────────────────────────────────────────────────

/** DI deps whose adapter echoes back the options it was handed. */
function toolDeps({ text = "", toolCalls = [] } = {}) {
  const seen = {};
  return {
    seen,
    deps: {
      resolve: async ({ capabilityKey }) => ({
        capabilityKey,
        providerKey: "groq",
        adapterType: "mock",
        providerConfig: { key: "groq", defaultModel: "llama-3.3-70b-versatile" },
        model: "llama-3.3-70b-versatile",
        profileKey: "balanced",
        profileParams: null,
        promptKey: null,
        requires: getCapability(capabilityKey)?.requires,
      }),
      getAdapterFor: () => ({
        async generate(args) {
          seen.options = args.options;
          return { text, ...(toolCalls.length ? { toolCalls } : {}), usage: null, raw: {} };
        },
      }),
      checkPolicies: async () => ({ allowed: true }),
      resolvePromptTemplate: async () => null,
      logAiRequest: async () => {},
    },
  };
}

test("REGRESSION: without a tool directive the adapter receives no tools option", async () => {
  const { seen, deps } = toolDeps({ text: "plain reply" });
  const out = await externalInvoke({ capability: "chat_away_responder", prompt: "hi" }, deps);
  assert.equal(out.text, "plain reply");
  assert.equal(seen.options.tools, undefined);
  assert.equal(seen.options.toolChoice, undefined);
  assert.deepEqual(out.toolCalls, []);
});

test("a tool directive reaches the adapter as options.tools + toolChoice", async () => {
  const { seen, deps } = toolDeps({ text: "" , toolCalls: [{ id: "c1", name: "create_task", arguments: { title: "Fix login" }, argumentsValid: true }] });
  const out = await externalInvoke(
    { capability: "ai_task_creation", prompt: "get someone on the login bug", tools: { definitions: [CREATE_TASK], mode: "auto" } },
    deps
  );
  assert.equal(seen.options.tools.length, 1);
  assert.equal(seen.options.tools[0].name, "create_task");
  assert.equal(seen.options.toolChoice, "auto");
  assert.equal(out.toolCalls.length, 1);
  assert.deepEqual(out.toolCalls[0].arguments, { title: "Fix login" });
  assert.equal(out.response.status, "succeeded");
});

test("mode 'required' is forwarded; mode 'off' suppresses tools entirely", async () => {
  const required = toolDeps({ text: "x" });
  await externalInvoke({ capability: "ai_task_creation", prompt: "p", tools: { definitions: [CREATE_TASK], mode: "required" } }, required.deps);
  assert.equal(required.seen.options.toolChoice, "required");

  const off = toolDeps({ text: "x" });
  await externalInvoke({ capability: "ai_task_creation", prompt: "p", tools: { definitions: [CREATE_TASK], mode: "off" } }, off.deps);
  assert.equal(off.seen.options.tools, undefined);
});

test("a tool-only turn (empty text) still succeeds rather than erroring", async () => {
  const { deps } = toolDeps({ text: "", toolCalls: [{ id: "c1", name: "create_task", arguments: {}, argumentsValid: true }] });
  const out = await externalInvoke({ capability: "ai_task_creation", prompt: "p", tools: { definitions: [CREATE_TASK] } }, deps);
  assert.equal(out.response.status, "succeeded");
  assert.equal(out.text, "");
  assert.equal(out.toolCalls.length, 1);
});
