// services/workspace.service.js
import * as repo from "../repositories/workspace.repository.js";
import { generateUniqueSlug, validateSlug } from "./workspaceSlug.service.js";
import { getUserById } from "../repositories/user.repository.js";

// ✅ ADD: chat helpers for default channels
import { createChannel, getChannelByKey } from "./chat.service.js";

/**
 * Business logic for workspaces.
 * - create workspace (superadmin only typically)
 * - add member (enforce max_members + billing plan limits)
 * - remove member
 */

/* ==================================================
   PHASE 2.3 — PLAN DEFINITIONS (ADDITIVE)
   ================================================== */

const PLAN_RULES = {
  free: {
    max_members: 3,
    features: {
      chat: true,
      reports: false,
      huddle: false,
    },
  },
  basic: {
    max_members: 10,
    features: {
      chat: true,
      reports: true,
      huddle: true,
    },
  },
  pro: {
    max_members: 50,
    features: {
      chat: true,
      reports: true,
      huddle: true,
    },
  },
  enterprise: {
    max_members: null, // unlimited
    features: {
      chat: true,
      reports: true,
      huddle: true,
    },
  },
};

/* ==================================================
   ✅ ENSURE DEFAULT CHANNELS PER WORKSPACE
   ================================================== */
export async function ensureDefaultChannelsForWorkspace(workspaceId, createdBy) {
  const defaults = [
    { key: "team-general", name: "Team General" },
    { key: "availability-updates", name: "Availability Updates" },
    { key: "project-manager", name: "Project Manager" },
  ];

  for (const ch of defaults) {
    const existing = await getChannelByKey(ch.key, workspaceId);
    if (existing) continue;

    await createChannel({
      key: ch.key,
      name: ch.name,
      type: "channel",
      createdBy,
      isPrivate: false,
      workspaceId,
    });
  }
}

class WorkspaceService {
  async create({
    name,
    slug = null,
    createdBy = null,
    billing_plan = null,
    max_members = 10,
    metadata = null,
  }) {
    if (!name) throw new Error("Workspace name required");

    // Every workspace gets a routable slug. It becomes `<slug>.asystence.com`,
    // which the edge router validates on every request, so a workspace without
    // one simply cannot be reached by subdomain. An explicit slug is validated
    // rather than corrected -- silently rewriting what someone typed produces a
    // URL they did not ask for.
    let resolvedSlug = String(slug || "").trim().toLowerCase();
    if (resolvedSlug) {
      const reason = validateSlug(resolvedSlug);
      if (reason) throw new Error(reason);
    } else {
      resolvedSlug = await generateUniqueSlug(name);
    }

    const ws = await repo.createWorkspace({
      name,
      slug: resolvedSlug,
      createdBy,
      billing_plan,
      max_members,
      metadata,
    });
// ✅ ENSURE DEFAULT CHAT CHANNELS
await ensureDefaultChannelsForWorkspace(ws.id, createdBy);

    if (createdBy) {
      try {
        await repo.addWorkspaceUser(ws.id, createdBy, "admin");
      } catch (err) {
        console.warn(
          "Failed to add creator as workspace admin:",
          err.message
        );
      }
    }

    // ✅ ENSURE 3 DEFAULT CHAT CHANNELS (WORKSPACE-SAFE)
    try {
      await ensureDefaultChannelsForWorkspace(ws.id, createdBy);
    } catch (err) {
      console.error(
        "Failed to ensure default chat channels:",
        err.message
      );
    }

    return ws;
  }

  async getOne(id) {
    return repo.getWorkspaceById(id);
  }

  async list(opts) {
    return repo.listWorkspaces(opts);
  }

  /* ==================================================
     PHASE 2.3 — PLAN HELPERS (ADDITIVE)
     ================================================== */

  getPlanRules(billingPlan) {
    return PLAN_RULES[billingPlan] || PLAN_RULES.basic;
  }

  getEffectiveMaxMembers(workspace) {
    const planRules = this.getPlanRules(workspace.billing_plan);

    const planLimit = planRules.max_members;
    const manualLimit = workspace.max_members;

    if (planLimit == null && manualLimit == null) {
      return null; // unlimited
    }

    if (planLimit == null) return manualLimit;
    if (manualLimit == null) return planLimit;

    return Math.min(planLimit, manualLimit);
  }

  hasFeature(workspace, featureKey) {
    const planRules = this.getPlanRules(workspace.billing_plan);
    return !!planRules.features?.[featureKey];
  }

  /* ==================================================
     MEMBER MANAGEMENT (ENFORCED)
     ================================================== */

  async addMember({ workspaceId, userId, role = "member" }) {
    const ws = await repo.getWorkspaceById(workspaceId);
    if (!ws) throw new Error("Workspace not found");

    const current = await repo.countWorkspaceMembers(workspaceId);
    const effectiveLimit = this.getEffectiveMaxMembers(ws);

    if (effectiveLimit != null && current >= effectiveLimit) {
      throw new Error(
        `Workspace member limit reached (${effectiveLimit}) for plan '${
          ws.billing_plan || "basic"
        }'`
      );
    }

    const user = await getUserById(userId);
    if (!user) throw new Error("User not found");

    try {
      await repo.addWorkspaceUser(workspaceId, userId, role);
    } catch (err) {
      if (err?.code === "23505") {
        throw new Error(
          "This user already belongs to another workspace. Please use a different account or remove that user from the other workspace first."
        );
      }
      throw err;
    }

    return { workspaceId, userId, role };
  }

  async removeMember({ workspaceId, userId }) {
    await repo.removeWorkspaceUser(workspaceId, userId);
  }

  async isMember(workspaceId, userId) {
    const rec = await repo.getWorkspaceUser(workspaceId, userId);
    return !!rec;
  }

  async getMembership(workspaceId, userId) {
    return repo.getWorkspaceUser(workspaceId, userId);
  }

  async getMembershipByUserId(userId) {
    return repo.getWorkspaceUserByUserId(userId);
  }
}

const workspaceService = new WorkspaceService();
export default workspaceService;
