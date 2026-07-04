// ai-platform/keys/keyOwnership.js
//
// P8 — Key ownership model (Contract v2 §10): who supplies the key
// (platform_managed | workspace_byo), who pays (billingOwner), and who the spend
// is attributed to (costOwner). Epic A ships the platform-managed default that
// maps to the SAME env var the adapters already use — so behavior is unchanged.
// Per-workspace BYO is structurally supported here; DB wiring is a later phase.

export const KEY_MODES = Object.freeze(["platform_managed", "workspace_byo"]);

// providerKey → default platform env var (matches the existing adapter defaults)
const DEFAULT_ENV = Object.freeze({
  openai: "OPENAI_API_KEY",
  groq: "GROQ_API_KEY",
  grok: "GROK_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  together: "TOGETHER_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  azure: "AZURE_OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  huggingface: "HUGGINGFACE_API_KEY",
});

/**
 * @param {{providerKey:string, workspaceId?:string|null}} args
 * @returns {{mode:string, keyRef:object|null, billingOwner:string, costOwner:(string|object), status:string}}
 */
export function resolveKeyOwnership({ providerKey, workspaceId = null } = {}) {
  const envName = DEFAULT_ENV[String(providerKey || "").toLowerCase()] || null;
  return {
    mode: "platform_managed",
    keyRef: envName ? { manager: "env", ref: envName } : null,
    billingOwner: "platform",
    costOwner: workspaceId ? { workspaceId } : "PLATFORM",
    status: "active",
  };
}
