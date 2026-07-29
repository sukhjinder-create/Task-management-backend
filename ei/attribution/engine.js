// ei/attribution/engine.js
//
// EI V2.1 §5′ — the deterministic Attribution Engine. Transforms canonical events
// into immutable attributions using the declared rule catalog. Pure & deterministic
// (same events + rules → same attributions, same ids). No LLM, no heuristics beyond
// the transparent catalog, no learning, no prediction. Cause precedes effect is
// enforced; "caused" (Tier C) is emitted ONLY when an identification strategy is
// supplied (experiments phase) — otherwise dormant.

import { createHash } from "node:crypto";
import { ATTRIBUTION_RULES } from "./rules.js";
import { createAttribution, wilsonInterval, TIERS } from "./attribution.js";

const DAY = 86400000;
const ms = (iso) => new Date(iso).getTime();
const primaryEntity = (ev) => (ev.entities || []).find((e) => e.role === "primary") || (ev.entities || [])[0] || { type: null, id: null };
const entityKeys = (ev) => new Set((ev.entities || []).filter((e) => e.id != null).map((e) => `${e.type}:${e.id}`));
const evidenceRef = (ev) => ({ eventId: ev.eventId, seq: ev.seq ?? null, type: ev.type, occurredAt: ev.occurredAt });
const inputHash = (ids) => "in_" + createHash("sha256").update(JSON.stringify([...ids].sort())).digest("hex").slice(0, 24);

function sharedEntity(effectEvent, factorEvent) {
  const fk = entityKeys(factorEvent);
  for (const e of effectEvent.entities || []) if (e.id != null && fk.has(`${e.type}:${e.id}`)) return { type: e.type, id: e.id };
  return null;
}

/**
 * @param {object} p
 * @param {string} p.workspaceId
 * @param {Array}  p.events                canonical events (from the Phase-1 log)
 * @param {Array}  [p.rules]
 * @param {object} [p.identificationStrategies]  ruleKey → { type, assumptions[], effectEstimate, interval } (experiments phase)
 * @param {string} [p.engineVersion]
 * @returns {Array} immutable attributions, deterministically ordered by id
 */
export function computeAttributions({ workspaceId, events = [], rules = ATTRIBUTION_RULES, identificationStrategies = {}, engineVersion = "ei-attr-1" } = {}) {
  const evs = events
    .filter((e) => e && String(e.workspaceId) === String(workspaceId))
    .slice()
    .sort((a, b) => (ms(a.occurredAt) - ms(b.occurredAt)) || ((a.seq ?? 0) - (b.seq ?? 0)));
  const byType = new Map();
  for (const e of evs) { if (!byType.has(e.type)) byType.set(e.type, []); byType.get(e.type).push(e); }

  const out = [];

  for (const rule of rules) {
    const effects = byType.get(rule.effectType) || [];
    if (effects.length === 0) continue;
    const factors = rule.factorTypes.flatMap((t) => byType.get(t) || []);

    // factor presence per effect (cause precedes effect, within window)
    const presence = effects.map((E) => {
      const from = ms(E.occurredAt) - rule.windowDays * DAY;
      const hits = factors.filter((F) => ms(F.occurredAt) >= from && ms(F.occurredAt) <= ms(E.occurredAt));
      const scoped = rule.mode === "observed" ? hits.filter((F) => sharedEntity(E, F)) : hits;
      return { E, hits: scoped };
    });

    if (rule.mode === "observed") {
      // Tier O — description of same-entity co-occurrence.
      for (const { E, hits } of presence) {
        if (hits.length === 0) continue;
        const shared = sharedEntity(E, hits[0]);
        const from = new Date(ms(E.occurredAt) - rule.windowDays * DAY).toISOString();
        const sourceIds = [E.eventId, ...hits.map((f) => f.eventId)];
        out.push(createAttribution({
          workspaceId, ruleKey: rule.key, tier: TIERS.OBSERVED,
          effect: { entity: primaryEntity(E), type: E.type, window: { from, to: E.occurredAt } },
          factor: { entity: shared, descriptor: rule.factorDescriptor },
          supportingEvidence: hits.map(evidenceRef),
          contradictingEvidence: [],
          temporalValidity: { from, to: E.occurredAt },
          provenance: { sourceEventIds: sourceIds, engineVersion, inputHash: inputHash(sourceIds) },
        }));
      }
    } else {
      // Tier A — population association (transparent proportion + Wilson interval).
      const withFactor = presence.filter((p) => p.hits.length > 0);
      const support = withFactor.length;
      const total = presence.length;
      const wilson = wilsonInterval(support, total);
      const confounders = (rule.confounders || []).map((name) => ({ name, controlled: false }));
      const contradictors = presence.filter((p) => p.hits.length === 0).slice(0, 3).map((p) => evidenceRef(p.E));

      for (const { E, hits } of withFactor) {
        const from = new Date(ms(E.occurredAt) - rule.windowDays * DAY).toISOString();
        const factorEnt = primaryEntity(hits[0]);
        const sourceIds = [E.eventId, ...hits.map((f) => f.eventId)];
        const strategy = identificationStrategies[rule.key] || null;
        const causal = Boolean(strategy);
        out.push(createAttribution({
          workspaceId, ruleKey: rule.key, tier: causal ? TIERS.CAUSAL : TIERS.ASSOCIATED,
          effect: { entity: primaryEntity(E), type: E.type, window: { from, to: E.occurredAt } },
          factor: { entity: factorEnt, descriptor: rule.factorDescriptor },
          supportingEvidence: hits.map(evidenceRef),
          contradictingEvidence: contradictors,
          associationStrength: causal ? (strategy.effectEstimate ?? wilson.point) : wilson.point,
          confidenceInterval: causal ? (strategy.interval ?? { low: wilson.low, high: wilson.high }) : { low: wilson.low, high: wilson.high },
          recordedConfounders: confounders,
          identificationStrategy: causal ? { type: strategy.type, assumptions: strategy.assumptions || [], ref: strategy.ref || null } : null,
          temporalValidity: { from, to: E.occurredAt },
          provenance: { sourceEventIds: sourceIds, engineVersion, inputHash: inputHash(sourceIds), populationN: total, populationSupport: support },
        }));
      }
    }
  }

  return out.sort((a, b) => a.attributionId.localeCompare(b.attributionId));
}
