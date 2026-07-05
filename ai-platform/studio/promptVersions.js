// ai-platform/studio/promptVersions.js
//
// Epic C — prompt version lifecycle state machine (Contract §7). Pure logic:
// draft → testing → published → archived, with rollback (re-publish an archived/
// older version) and approval gating. No DB, no I/O — the registry service applies
// these transitions to persisted rows.

export const PROMPT_STATUSES = Object.freeze(["draft", "testing", "published", "archived"]);

// Allowed forward transitions.
const TRANSITIONS = Object.freeze({
  draft: ["testing", "published", "archived"],
  testing: ["published", "draft", "archived"],
  published: ["archived"],
  archived: ["published"], // rollback / re-publish
});

export function canTransition(from, to) {
  if (!PROMPT_STATUSES.includes(from) || !PROMPT_STATUSES.includes(to)) return false;
  if (from === to) return false;
  return (TRANSITIONS[from] || []).includes(to);
}

/**
 * Given the current versions of a prompt and a requested transition, compute the
 * resulting status set (publishing archives the previously-published version).
 * Pure. `versions` = [{version, status}], returns the mutations to apply.
 * @returns {{ok:boolean, reason?:string, mutations?:Array<{version:number,status:string}>}}
 */
export function planTransition({ versions = [], version, to, requireApproval = false, approved = false }) {
  const target = versions.find((v) => v.version === version);
  if (!target) return { ok: false, reason: "version_not_found" };
  if (!canTransition(target.status, to)) return { ok: false, reason: `illegal_transition:${target.status}->${to}` };
  if (to === "published" && requireApproval && !approved) return { ok: false, reason: "approval_required" };

  const mutations = [{ version, status: to }];
  if (to === "published") {
    // Archive any other currently-published version (single live published version).
    for (const v of versions) {
      if (v.version !== version && v.status === "published") mutations.push({ version: v.version, status: "archived" });
    }
  }
  return { ok: true, mutations };
}

/** The next draft version number for a prompt. */
export function nextVersionNumber(versions = []) {
  return versions.reduce((max, v) => Math.max(max, Number(v.version) || 0), 0) + 1;
}

/** The currently-published version (or null). */
export function publishedVersion(versions = []) {
  return versions.find((v) => v.status === "published") || null;
}
