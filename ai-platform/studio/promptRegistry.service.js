// ai-platform/studio/promptRegistry.service.js
//
// Epic C — Prompt Registry (Contract §7): prompts + versions with the lifecycle
// state machine (promptVersions.js). DB-backed and schema-tolerant. Every mutation
// is audited. UNVERIFIED AT RUNTIME (needs a migrated DB).

import { q } from "./db.js";
import { nextVersionNumber, planTransition } from "./promptVersions.js";
import { recordAudit } from "./audit.service.js";

export async function listPrompts() {
  const { rows } = await q(`SELECT * FROM ai_prompts ORDER BY key`);
  return rows;
}

export async function getPrompt(key) {
  const { rows } = await q(`SELECT * FROM ai_prompts WHERE key = $1`, [key]);
  return rows[0] || null;
}

export async function createPrompt({ key, category = null, feature = null, description = null, owner = null, createdBy = null }) {
  await q(
    `INSERT INTO ai_prompts (key, category, feature, description, owner, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (key) DO NOTHING`,
    [key, category, feature, description, owner, createdBy]
  );
  await recordAudit({ actorType: "superadmin", actorId: createdBy, action: "create", objectType: "prompt", objectKey: key, after: { key, category, feature } });
  return getPrompt(key);
}

export async function listVersions(promptKey) {
  const { rows } = await q(
    `SELECT v.* FROM ai_prompt_versions v JOIN ai_prompts p ON p.id = v.prompt_id WHERE p.key = $1 ORDER BY v.version`,
    [promptKey]
  );
  return rows;
}

export async function createVersion({ promptKey, body, notes = null, createdBy = null }) {
  const versions = (await listVersions(promptKey)).map((v) => ({ version: v.version, status: v.status }));
  const version = nextVersionNumber(versions);
  await q(
    `INSERT INTO ai_prompt_versions (prompt_id, version, body, status, notes, created_by)
     SELECT id, $2, $3, 'draft', $4, $5 FROM ai_prompts WHERE key = $1`,
    [promptKey, version, body, notes, createdBy]
  );
  await recordAudit({ actorType: "superadmin", actorId: createdBy, action: "create_version", objectType: "prompt_version", objectKey: `${promptKey}#${version}` });
  return version;
}

/**
 * Apply a lifecycle transition (draft/testing/published/archived, rollback).
 * Publishing archives the previously-published version (single live version).
 */
export async function transitionVersion({ promptKey, version, to, actorId = null, requireApproval = false, approved = false }) {
  const versions = (await listVersions(promptKey)).map((v) => ({ version: v.version, status: v.status }));
  const plan = planTransition({ versions, version, to, requireApproval, approved });
  if (!plan.ok) return { ok: false, reason: plan.reason };

  for (const m of plan.mutations) {
    await q(
      `UPDATE ai_prompt_versions v
          SET status = $3,
              approved_by = CASE WHEN $3 = 'published' THEN $4 ELSE v.approved_by END,
              published_at = CASE WHEN $3 = 'published' THEN now() ELSE v.published_at END
         FROM ai_prompts p
        WHERE v.prompt_id = p.id AND p.key = $1 AND v.version = $2`,
      [promptKey, m.version, m.status, actorId]
    );
  }
  await recordAudit({ actorType: "superadmin", actorId, action: `prompt_${to}`, objectType: "prompt_version", objectKey: `${promptKey}#${version}`, after: { to } });
  return { ok: true, mutations: plan.mutations };
}
