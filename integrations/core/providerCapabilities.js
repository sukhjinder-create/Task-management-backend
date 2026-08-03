// integrations/core/providerCapabilities.js
//
// One machine-readable description per provider, served to the frontend so the
// Migrations UI can render itself instead of hardcoding a bespoke React panel
// (and a matching entry in a SOURCES array) for every platform.
//
// Adding a built-in provider should mean adding an entry here — not editing the
// frontend. Admin-defined ("custom:") providers produce the same shape at
// runtime from their stored configuration, so the UI treats them identically.

/**
 * @typedef {Object} ProviderCapability
 * @property {string}  key             Stable identifier, matches workspace_integrations.provider
 * @property {string}  name            Human label
 * @property {string}  category        'tasks' | 'chat'
 * @property {'oauth'|'token'|'none'} authType  How the admin connects
 * @property {Array}   authFields      Fields the UI must collect for 'token' auth
 * @property {boolean} supportsProjects        Has a project/board concept to pick from
 * @property {boolean} supportsProjectScoping  Sync/webhooks can be limited to chosen projects
 * @property {'auto'|'manual'|'none'} webhookMode  How real-time updates are established
 * @property {boolean} supportsReconciliation   Can be swept for missed events
 * @property {boolean} builtIn
 */

const BUILT_IN_PROVIDERS = Object.freeze([
  {
    key: "asana",
    name: "Asana",
    category: "tasks",
    authType: "oauth",
    authFields: [],
    connectPath: "/oauth/asana/connect",
    supportsProjects: true,
    supportsProjectScoping: true,
    // Asana registers webhooks for us over its API, but silently deactivates
    // them after repeated delivery failures — reconciliation is what catches that.
    webhookMode: "auto",
    supportsReconciliation: true,
    defaultReconcileMinutes: 1440,
    builtIn: true,
  },
  {
    key: "youtrack",
    name: "YouTrack",
    category: "tasks",
    authType: "token",
    authFields: [
      { name: "baseUrl", label: "YouTrack URL", type: "url", required: true, placeholder: "https://yourcompany.youtrack.cloud" },
      { name: "token", label: "Permanent token", type: "password", required: true, placeholder: "perm:..." },
    ],
    connectPath: "/integrations/youtrack/connect",
    supportsProjects: true,
    supportsProjectScoping: true,
    // YouTrack cannot register its own webhooks; an admin pastes the generated
    // URL + token into YouTrack's Webhook Triggers app.
    webhookMode: "manual",
    supportsReconciliation: true,
    defaultReconcileMinutes: 1440,
    builtIn: true,
  },
  {
    key: "slack",
    name: "Slack",
    category: "chat",
    authType: "token",
    authFields: [
      { name: "token", label: "Bot or user token", type: "password", required: true, placeholder: "xoxb-..." },
    ],
    connectPath: "/integrations/slack/validate",
    supportsProjects: true, // channels
    projectNoun: "channel",
    supportsProjectScoping: true,
    webhookMode: "none",
    // Slack import is a deliberate one-shot history migration, not a live sync.
    supportsReconciliation: false,
    builtIn: true,
  },
]);

export function listBuiltInProviders() {
  return BUILT_IN_PROVIDERS.map((provider) => ({ ...provider }));
}

export function getBuiltInProvider(key) {
  const found = BUILT_IN_PROVIDERS.find((provider) => provider.key === key);
  return found ? { ...found } : null;
}

export const CUSTOM_PROVIDER_PREFIX = "custom:";

export function isCustomProvider(key) {
  return String(key || "").startsWith(CUSTOM_PROVIDER_PREFIX);
}

export function customProviderKey(slug) {
  return `${CUSTOM_PROVIDER_PREFIX}${slug}`;
}

/** Strip the prefix to get back the slug stored in custom_integration_providers. */
export function customProviderSlug(key) {
  return isCustomProvider(key) ? String(key).slice(CUSTOM_PROVIDER_PREFIX.length) : null;
}

/**
 * Present an admin-defined provider using the exact same contract the built-ins
 * use, so every consumer (UI, sync scheduler, webhook router) stays uniform.
 */
export function describeCustomProvider(row) {
  const hasWebhook = Boolean(row.endpoints?.webhook?.enabled);
  return {
    key: customProviderKey(row.provider_key),
    name: row.name,
    description: row.description || null,
    category: "tasks",
    authType: row.auth_type === "none" ? "none" : "token",
    authFields: [],           // captured in the custom-provider setup flow instead
    supportsProjects: Boolean(row.endpoints?.projects?.path),
    supportsProjectScoping: true,
    webhookMode: hasWebhook ? "manual" : "none",
    // Reconciliation needs a way to list tasks; without a tasks endpoint there
    // is nothing to sweep.
    supportsReconciliation: Boolean(row.endpoints?.tasks?.path),
    defaultReconcileMinutes: 1440,
    builtIn: false,
    status: row.status,
    lastTestOk: row.last_test_ok,
    lastTestedAt: row.last_tested_at,
  };
}
