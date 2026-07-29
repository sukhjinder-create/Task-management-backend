# Asystence Enterprise Intelligence V2 — Architecture (Design Only)

**Author role:** Principal AI & Enterprise-Architecture Lead.
**Status:** Design specification. **No code, migrations, APIs, or UI.** Optimized for a 10-year horizon.
**Reuses (does not redesign):** the Contract-v2 AI Platform — Gateway `invoke()`, Capability Registry, Prompt Registry, Provider Negotiation, Runtime Profiles, Governance/Locks, Safety, Cost Engine, Telemetry, AI Studio.
**Date:** 2026-07-05

> **Brutal-honesty preface (grounded in the current code).** Today's "Enterprise Intelligence" is a **per-module deterministic scoring engine** (`intelligence/evaluators/{user,project,team,workspace,attendance}` → `scorePrimitives` → `unifiedIntelligence.engine` → snapshots) with **LLM narratives bolted on top** (`enterpriseIntelligence.service.js`'s 4 JSON calls, `executiveSummary.generator`, `forecast.reasoning`, `events/llm/llmExplanation`). It scores each entity **in isolation** and cannot answer *why*. The `adaptive/context/operationalContextGraph` assembles a **throwaway per-request** graph, not a persistent one. "Reasoning" is regex + `riskDelta += 0.12` heuristics. Evidence is hashed (good) but there are no **reasoning chains, calibrated confidence, contradicting evidence, or causal inference**. V2 **inverts the model**: a transparent, persistent, relational reasoning substrate produces the conclusions; the LLM (through the AI Platform) only **explains and hypothesizes**, never invents the numbers. That inversion is the whole design.

---

## 1. Vision
Enterprise Intelligence V2 is **not a dashboard and not a chatbot**. It is the platform's **reasoning substrate**: a continuously-updated model of *how the organization actually works* — people, work, time, communication, dependencies, outcomes — over which the system performs **causal, predictive, and explainable reasoning**. Its output is not "a score of 72"; it is *"Engineering Health fell 11 points because Sprint 18 slipped; the slip was caused by a dependency on the Payments team, whose lead was 40% under normal availability during the two weeks the blocking task sat unassigned; confidence 0.78; here is the evidence, the contradicting signal, and the two actions with expected impact."*

## 2. Principles (non-negotiable)
1. **Explainable-first, AI-second.** The core conclusions come from a **deterministic, inspectable reasoning graph**. LLMs (via the AI Platform) generate *language* and *candidate hypotheses*, never the authoritative causality or numbers.
2. **Relational, not modular.** Reasoning happens across relationships (attendance↔meetings↔tasks↔dependencies↔comms↔outcomes), not per module.
3. **Everything carries provenance.** Every claim traces to immutable events. If it can't be traced, it isn't asserted.
4. **Confidence is calibrated, not decorative.** Confidence is derived and back-tested, decomposed into its parts, and shown.
5. **Every conclusion is challengeable.** Contradicting evidence and alternative explanations are first-class outputs. Trust before intelligence.
6. **Transparent learning only.** Improvement = versioned, auditable, AI-Studio-governed weight/config changes and calibration — never hidden model drift.
7. **Incremental & event-driven.** Compute is materialized incrementally on events; deep reasoning is scheduled/on-demand. Scales by partitioning + caching, not by rewriting.
8. **Tenant-isolated by construction.** Cross-workspace reasoning exists only where governance explicitly permits, and is redacted/aggregated by default.
9. **One AI path.** All model calls go through the AI Platform gateway as registered capabilities. Zero duplicate LLM/telemetry/cost/safety.

## 3. Enterprise-Intelligence philosophy
Three questions, three mechanisms:
- **"What is true?"** → the **Organizational Knowledge Graph** (entities + typed, temporal relationships) derived from the event log.
- **"Why did it happen?"** → the **Reasoning Graph**: explicit **causal hypotheses** scored by evidence propagated over the knowledge graph. Causality is *modeled and evidenced*, not guessed by an LLM.
- **"What next / what to do?"** → the **Prediction** and **Recommendation** engines, which propagate leading indicators over the graph and attach expected impact + confidence.
The LLM's job is the *last mile*: turn a reasoning trace into an executive-grade sentence, and propose candidate hypotheses for the deterministic engine to test. This is the opposite of today's "LLM writes the story over opaque scores."

## 4. Complete architecture (the layered brain)
```
                    ┌─────────────────────────────────────────────────────────┐
   Domain events →  │  0. EVENT LOG (immutable substrate)  ← reuse events/store │  provenance + time
                    └───────────────┬─────────────────────────────────────────┘
                                    │ (event-driven, incremental)
   ┌──────────────┬────────────────┼──────────────┬───────────────┬───────────────┐
   │ 1. SIGNAL    │ 2. EVIDENCE     │ 3. BEHAVIOR   │ 4. RELATIONSHIP│  (materialized layers)
   │  detectors   │  typed+weighted │  baselines/   │  ORG KNOWLEDGE │
   │ (reuse       │  provenance     │  anomalies    │  GRAPH (entities+
   │  evaluators) │                 │               │  temporal edges)
   └──────┬───────┴───────┬─────────┴──────┬────────┴──────┬────────┘
          └───────────────┴────────────────┴───────────────┘
                                    │
                    ┌───────────────▼───────────────┐
                    │ 5. REASONING GRAPH (causal)    │  deterministic causal inference
                    │   hypotheses × evidence × paths│  → Reasoning Traces (explainable)
                    └───────────────┬───────────────┘
             ┌──────────────────────┼──────────────────────┐
   ┌─────────▼─────────┐ ┌──────────▼──────────┐ ┌──────────▼──────────┐
   │ 6. PREDICTION     │ │ 7. RECOMMENDATION   │ │  EXPLANATION         │
   │  ensemble+confid. │ │  actions+impact     │ │  (AI Platform invoke │
   └─────────┬─────────┘ └──────────┬──────────┘ │   capabilities)      │
             └─────────────┬────────┘            └──────────────────────┘
                    ┌───────▼───────┐
                    │ 8. EXECUTIVE  │  lensing + governance + narrative
                    └───────────────┘
   ── cross-cutting: Confidence · Provenance · Governance(RBAC+AI-Studio) · Learning/Backtest · Cost/Safety(AI Platform)
```
Each layer is **additive, cached, and event-incremental**. Removing the LLM leaves a fully functional (if silent) reasoning engine — the intelligence does not *depend* on generation.

## 5. Reasoning model
- **Causal hypotheses as first-class objects.** A hypothesis = `{ effect, candidate_cause, mechanism, required_evidence[], temporal_constraint }` (e.g., "dependency-block → task-delay if the blocking task's owner availability was low during the block window"). Hypotheses come from (a) a curated **causal library** (domain knowledge encoded once) and (b) LLM-proposed candidates (via a `reasoning.hypothesize` capability) that must pass the same evidence test.
- **Evidence scoring, not vibes.** Each hypothesis is scored by propagating supporting/contradicting evidence over the knowledge graph with temporal ordering (cause must precede effect), producing a **causal-strength** ∈ [0,1] + a **reasoning path** (the exact edges/events used).
- **Determinism + reproducibility.** Given the same events + config version, the same conclusion + trace results (evidence-hash reproducibility, extended from today's `hashEvidence`).
- **LLM boundary.** LLMs never set causal strength or numbers. They (1) propose hypotheses to test, (2) translate the winning trace into language. Both are AI-Platform capabilities with safety + cost governance.

## 6. Knowledge model — *hybrid, and here's why*
**Decision: a layered hybrid, not a single graph.**
- **Event Log (source of truth):** append-only, per-workspace, the existing `events/store`. Gives **temporality, provenance, auditability, replay**. A pure knowledge graph lacks these; you can never lose them.
- **Organizational Knowledge Graph (derived, materialized):** typed **entities** (User, Team, Project, Task, Sprint, Meeting, Channel, Dependency, Goal, Workspace, Customer) and **temporal, typed edges** (`assigned_to`, `blocks`, `attended`, `manages`, `depends_on`, `discussed_in`, `owns`, `escalated_to`) — each edge stamped with validity intervals and source-event refs. Answers **relationship** questions.
- **Reasoning Graph (derived, ephemeral-cacheable):** the causal overlay (§5) built on demand from the knowledge graph + hypotheses. Answers **why**.
**Why hybrid:** events = *what happened & when* (immutable truth); knowledge graph = *how things relate* (fast traversal); reasoning graph = *why* (causal). Any one alone fails a requirement (no provenance / no relationships / no causality). Each is derivable and rebuildable from the layer below — so the truth is never in the derived layers.

## 7. Event model
- **Canonical domain events** (extend the existing `eventTypes` + `emitWorkspaceEvent`): every state change in attendance/tasks/projects/sprints/meetings/chat/deps/goals emits a typed, workspace-scoped, versioned event with entity refs and a correlation/trace id (reuse the AI Platform's trace context).
- **Event → graph projection:** deterministic projectors turn events into entity/edge upserts (with validity intervals). This is the only writer of the knowledge graph → single source of derivation, fully replayable.
- **Signals** are derived events (level-2): "availability dropped", "blocker unresolved >N days", "review overdue", "comms silence on a critical path". Signal detectors reuse today's `signal.detector` / evaluators as producers.
- **Idempotent, ordered, replayable.** Reprocessing the log rebuilds every layer — the ultimate audit + disaster-recovery guarantee.

## 8. Intelligence lifecycle
`event → project to graph → detect signals → accrue/weight evidence → (re)build affected reasoning subgraph → refresh predictions on impacted entities → generate/refresh recommendations → surface by lens → capture human feedback → backtest & calibrate`. Two clocks:
- **Hot path (event-driven, cheap):** projection, signal detection, incremental evidence + local reasoning on the *affected subgraph only* (bounded blast radius).
- **Cold path (scheduled/on-demand, deep):** full causal sweeps, cross-entity predictions, executive rollups, backtesting/calibration.
Everything is **cached with provenance-based invalidation** (a conclusion is invalidated only when an event in its reasoning path changes).

## 9. Prediction engine
- **Transparent ensemble**, each member emitting `{prediction, confidence, evidence, method}`:
  1. **Statistical/trend** (velocity, burn, availability trajectories) — reproducible.
  2. **Graph-propagation risk** (a blocker/overload/attrition signal propagates along dependency/management edges to downstream deliverables).
  3. **Leading-indicator models** (behavioral precursors that historically preceded failures — learned as *weights*, §14).
  4. **Scenario narration** (optional, LLM via AI Platform) — describes, never scores.
- **Fusion** is a weighted, explainable combiner; the ensemble disagreement itself is a confidence input. Outputs: "Sprint 19 will miss by ~2 days (P=0.71)" with the contributing members and their evidence.

## 10. Recommendation engine
- Maps a predicted/root-caused risk → a **ranked action set**, each with **expected impact** (modeled delta on the target KPI), **confidence**, **effort**, **owner**, and **approval class** (reuse `adaptive/approvals`). e.g., *"Reassign blocking task X to Y (frees the Payments dependency); expected: Sprint-19 slip −1.5 days; confidence 0.68; requires manager approval."*
- **Every recommendation is challengeable:** it ships with its reasoning trace and the counter-evidence, and records accept/reject/modify as labeled feedback (§14).
- Never auto-acts beyond governed policy; human-in-the-loop by default for anything consequential.

## 11. Explainability framework — the **Reasoning Trace** (mandatory on every output)
A conclusion is invalid unless it carries:
`{ claim, confidence + decomposition, reasoning_chain (ordered causal steps), supporting_signals[], contradicting_signals[], evidence[] (event-linked), historical_comparison, alternative_explanations[] (with why-rejected), recommended_actions[], expected_impact }`.
Rendered progressively (one sentence → chain → raw events). No "AI magic": if the trace can't be built, the claim is downgraded to "observation" (no causal assertion). This extends today's evidence-hashing into full, replayable chains.

## 12. Evidence model
Typed evidence: `{ type, source_event_refs[], polarity(support/contradict), weight, freshness, confidence, entity_scope }`, content-hashed for reproducibility. Contradicting evidence is stored and surfaced (today it's discarded). Evidence weights are **governed config** (versioned in AI Studio), not code constants — so tuning is auditable, not a redeploy.

## 13. Confidence model
Confidence is **decomposed and calibrated**:
`confidence = f(data_completeness, signal_strength, causal_path_strength, model_reliability, recency)` — each factor shown. **Calibration** comes from backtesting (predicted P vs observed outcomes; Brier/reliability curves per capability). A stated 0.8 must *empirically* mean ~80% correct; miscalibration is itself reported and drives learning (§14). Never a bare, uncalibrated number.

## 14. Learning model (transparent, auditable)
- **Outcome capture:** every prediction/recommendation is linked to its eventual real-world outcome (from the event log) → labeled examples with zero manual labeling.
- **Calibration:** confidence factors and ensemble weights are re-fit against outcomes on the cold path.
- **Evidence/causal re-weighting:** hypothesis and evidence weights adjust from outcomes — but **only as a versioned config change** proposed → reviewed → published through **AI Studio governance** (draft/test/publish/rollback, exactly like prompts). No hidden weights, no silent drift.
- **Human feedback:** accept/reject/challenge and manual corrections are high-value labels.
- **Auditability:** every weight version records *what changed, why (which outcomes), by whom/what, and the backtest delta*. Learning is a reviewable diff, not a black box. (Reuse the AI Platform audit + governance surfaces.)

## 15. Risk model
Risk is **propagation + emergence + prediction**, all explainable:
- **Propagated risk:** a local signal (blocker, overload, attrition, silence on a critical path) flows along typed edges to downstream deliverables/goals, with decaying weight and a visible **risk path**.
- **Emerging risk:** behavioral anomalies vs baselines (a team's review latency creeping up, a manager becoming a decision bottleneck) detected before they hit outcomes.
- **Predictive risk:** leading indicators (§9) with calibrated probability.
Every risk carries severity × likelihood × the exact path × the earliest intervention point.

## 16. Executive Intelligence (lens)
Surfaces: **portfolio-level KPI trajectories with predicted target misses**, the **top N risks requiring executive intervention** (ranked by impact × confidence × reversibility), **why** each is happening (root cause), **what changed since last period**, and **which recommendations are pending**. One narrative sentence per item, expandable to the full trace. Cross-workspace only where governance permits, aggregated/anonymized by default.

## 17. Workspace Intelligence (lens)
Workspace-health decomposition into its causal drivers (execution, availability, dependency load, communication health, review compliance), **at-risk projects with root cause**, bottleneck managers/teams, and **improving vs declining** trajectories with the events that drove the change. This is where "Why is Engineering Health decreasing?" is answered concretely.

## 18. Team Intelligence (lens)
Team delivery reliability, dependency exposure (who they block / who blocks them), meeting-influence-on-delivery (which meetings actually changed task outcomes — a real query the graph enables), workload balance, and coaching signals (reuse the existing coaching engine as a *consumer* of traces, not a separate scorer).

## 19. Individual Intelligence (lens)
Per-person: execution reliability, overload/underload with cause, on-time trajectory, and *supportive* framing — **strictly governed** (dataSensitivity=restricted; visibility gated by RBAC + the AI Platform governance). Individual conclusions always show evidence and are challengeable by the individual — this is a trust and fairness requirement, not a nicety.

## 20. Business Intelligence (lens)
Ties execution to business outcomes: goal/OKR attainment forecasts, **customer/workspace churn risk** (from engagement + health + trajectory signals), which internal behaviors predict external outcomes, and expected KPI misses with lead time. Confidence-scored, evidence-backed, cross-workspace only under governance.

## 21. Scalability architecture (100 → 100,000 without redesign)
- **Event-driven incremental compute:** work is proportional to *change*, not to data size. A single event touches a bounded subgraph.
- **Tenant partitioning:** the knowledge/reasoning graph is **sharded per workspace**; cross-workspace queries are a separate, governed aggregation plane — so per-tenant cost is flat as tenant count grows.
- **Tiered compute:** cheap signals real-time; expensive causal/predictive on the cold path with backpressure and priority (reuse the AI Platform scheduling/priority concepts).
- **Provenance-based caching:** conclusions are cached and invalidated only by events in their path → high hit rates.
- **LLM cost bounded by the AI Platform** (negotiation, cost engine, budgets) — reasoning volume can grow while spend stays governed; the deterministic core needs **no LLM at all** to function.
- **Graph storage** starts on Postgres (adjacency + validity intervals, reusing the current DB) and can migrate to a dedicated graph/columnar store behind the same projector interface **without touching the reasoning layers** — the projector is the seam.

## 22. Failure scenarios (and designed responses)
- **Data gaps / sparse tenant:** confidence's `data_completeness` factor collapses → the system *degrades to observations, not assertions* (never fabricates causality).
- **AI provider outage:** the deterministic core keeps producing traces (silent, no narration); narration resumes via AI-Platform failover. Intelligence never *depends* on generation.
- **Causal mis-inference:** guarded by evidence thresholds, contradicting-evidence surfacing, calibrated confidence, and human-in-the-loop on consequential actions; systematically caught by backtesting.
- **Graph drift / projector bug:** the event log is truth → **rebuild the graph by replay**; projectors are pure and testable.
- **Cost runaway:** AI-Platform budgets/negotiation cap spend; deep reasoning is schedulable/deferrable.
- **Privacy / cross-workspace leakage:** default tenant isolation; cross-workspace only via governed, aggregated views; individual data is restricted-sensitivity and RBAC-gated.
- **Feedback poisoning / gaming:** learning changes are governed, reviewed, backtested diffs — a bad signal can't silently move the model.

## 23. Extension strategy
New domains/signals = **new entity types + edge types + projectors + evidence collectors + causal hypotheses** — additive; the layers and traces don't change. New reasoning *methods* register as ensemble members with the standard `{output, confidence, evidence}` contract. New *explanations/hypothesizers* register as AI-Platform capabilities. The architecture grows by adding nodes to a stable frame, never by reshaping it.

## 24. Migration from the existing Enterprise Intelligence (strangler-fig, no big-bang)
1. **Adopt the event log as substrate** (it exists) — ensure all domains emit canonical events; backfill from current tables via one-time projectors.
2. **Reframe the current scoring engine as Signal/Evidence producers.** `intelligence/evaluators/*` become **signal + evidence emitters** (their math is reusable, valuable, and reproducible) — not the top-level answer. Keep them running in parallel (shadow) so current scores are unaffected.
3. **Materialize the Organizational Knowledge Graph** from the event log (the `adaptive/operationalContextGraph` logic becomes the *persistent* projector instead of a per-request build).
4. **Introduce the Reasoning Graph + traces** behind a flag; run **shadow** against current outputs; compare and calibrate before surfacing.
5. **Route all narration/hypothesis LLM calls through the AI Platform** as capabilities (`reasoning.explain`, `reasoning.hypothesize`, `prediction.narrate`) — retiring the bespoke `enterpriseIntelligence.service`, `executiveSummary.generator`, `forecast.reasoning`, `events/llm/*` provider logic (consistent with the unification already done).
6. **Cut over lens-by-lens** (Workspace → Team → Executive → Individual → Business), each flag-gated, shadow-validated, reversible — mirroring the AI Platform's proven wave method.
7. **Retire legacy scoring-as-answer** only after backtests show the reasoning engine is at least as accurate and strictly more explainable. Legacy stays as fallback until then.

## 25. Final certification (self-review against the mandate)
| Requirement | Met by design? |
|---|---|
| Reasoning engine, not a dashboard/chatbot | ✅ §1–5 (causal reasoning graph; LLM only narrates) |
| Cross-relational (attendance→…→KPIs) | ✅ §6 knowledge graph + §5 causal propagation |
| Explains why / what caused / what next / what to do | ✅ §5,§9,§10,§11 |
| Causal / dependency / risk / predictive / historical reasoning | ✅ §5,§15,§9 |
| Explainability (evidence, confidence, chain, contradictions, alternatives, actions, impact) | ✅ §11 Reasoning Trace (mandatory) |
| Calibrated, decomposed confidence | ✅ §13 (back-tested) |
| Transparent, auditable learning (no hidden behavior) | ✅ §14 (governed versioned config + calibration) |
| Every recommendation challengeable | ✅ §10,§11 |
| Scales 100→100k without redesign | ✅ §21 (incremental + partitioned + cached; LLM-optional core) |
| Reuses the AI Platform (no duplication) | ✅ §2.9, §5, §24.5 (capabilities/prompts/governance/cost/safety/telemetry) |
| Tenant isolation + governed cross-workspace | ✅ §21,§22, §16/§20 |
| Failure resilience | ✅ §22 (event-log replay; provider failover; degrade-to-observation) |

**Verdict: DESIGN CERTIFIED.** The central bet is the inversion — *transparent reasoning graph first, LLM last* — which fixes the current system's fatal flaw (opaque per-module scores narrated by an LLM) and satisfies the explainability, trust, scalability, and 10-year-extensibility mandates while reusing the AI Platform wholesale.

---

*Design phase only. No code, migrations, APIs, or UI were produced or modified. Implementation, if authorized, follows the §24 strangler-fig migration — additive, flag-gated, shadow-validated, reversible.*
