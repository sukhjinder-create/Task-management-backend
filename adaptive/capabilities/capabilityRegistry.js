const capabilities = new Map();

const APPROVAL_MODES = new Set(["automatic", "approval_required", "manual_only"]);
const RISK_LEVELS = new Set(["low", "medium", "high", "critical"]);

export function registerCapability(capability) {
  if (!capability?.key || typeof capability.execute !== "function") {
    throw new TypeError("Capability requires key and execute()");
  }
  if (capabilities.has(capability.key)) return false;
  const normalized = {
    version: 1,
    description: "",
    riskLevel: "medium",
    approvalMode: "approval_required",
    autoEligible: false,
    allowedRoles: ["admin", "owner", "manager", "user"],
    validate: () => true,
    planning: null,
    ...capability,
  };
  if (!APPROVAL_MODES.has(normalized.approvalMode)) throw new Error(`Invalid approval mode: ${normalized.key}`);
  if (!RISK_LEVELS.has(normalized.riskLevel)) throw new Error(`Invalid risk level: ${normalized.key}`);
  capabilities.set(normalized.key, Object.freeze(normalized));
  return true;
}

export function getCapability(key) {
  return capabilities.get(key) || null;
}

export function listCapabilities() {
  return Array.from(capabilities.values()).map((capability) => ({
    key: capability.key,
    version: capability.version,
    description: capability.description,
    riskLevel: capability.riskLevel,
    approvalMode: capability.approvalMode,
    autoEligible: capability.autoEligible,
    allowedRoles: capability.allowedRoles,
    inputContract: capability.inputContract || null,
    planning: capability.planning ? {
      intents: capability.planning.intents || [],
      businessValue: capability.planning.businessValue ?? 0.5,
      sequence: capability.planning.sequence ?? 50,
      actionType: capability.planning.actionType || null,
      contextTags: capability.planning.contextTags || [],
    } : null,
  }));
}

export function listPlannableCapabilities() {
  return Array.from(capabilities.values()).filter((capability) => (
    capability.planning?.actionType && Array.isArray(capability.planning?.intents)
  ));
}

export function clearCapabilitiesForTests() {
  capabilities.clear();
}
