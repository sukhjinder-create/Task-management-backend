// ai-platform/testing/mockAdapter.js
//
// P0 test harness — provider mock/fixtures.
// A deterministic adapter that fulfils the SAME provider contract as the real
// adapters (base.adapter.js), so hermetic tests can exercise the platform
// without any network or provider keys. NOT wired into any production path.

/**
 * @param {object} opts
 * @param {(ctx:{prompt:string,options:object})=>(string|object)} [opts.script]
 *        deterministic producer; receives the flattened prompt + options
 * @param {Record<string,string|object>} [opts.table]  prompt → response map
 * @param {string|object} [opts.fixedText]             constant response
 * @param {string} [opts.model]
 */
export class MockAdapter {
  constructor({ script = null, table = null, fixedText = null, model = "mock-1" } = {}) {
    this.script = script;
    this.table = table;
    this.fixedText = fixedText;
    this.model = model;
    this.calls = []; // recorded invocations, for assertions
  }

  async generate({ model, prompt, messages, options = {}, providerConfig = {}, signal } = {}) {
    const key =
      prompt != null
        ? String(prompt)
        : Array.isArray(messages)
        ? messages.map((m) => m.content).join("\n")
        : "";

    this.calls.push({ key, options: { ...options }, model: model || null });

    let value;
    if (typeof this.script === "function") value = this.script({ prompt: key, options });
    else if (this.table && key in this.table) value = this.table[key];
    else if (this.fixedText != null) value = this.fixedText;
    else value = key; // default: echo the prompt (fully deterministic)

    let text;
    if (typeof value === "string") text = value;
    else text = JSON.stringify(value); // json-mode responses serialize deterministically

    return {
      text,
      usage: { inputTokens: key.length, outputTokens: text.length },
      raw: { mock: true, model: model || providerConfig.defaultModel || this.model },
    };
  }
}

/** Convenience: an adapter that always returns the same text. */
export function fixedMockAdapter(text) {
  return new MockAdapter({ fixedText: text });
}
