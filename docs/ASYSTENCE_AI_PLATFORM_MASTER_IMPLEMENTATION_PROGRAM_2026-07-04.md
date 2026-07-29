# Asystence AI Platform — Master Implementation Program (Contract v2)

**Author role:** Chief Platform Engineer / Technical Program Director.
**Source of truth:** `ASYSTENCE_AI_PLATFORM_CONTRACT_V2_2026-07-04.md` — **frozen**. Nothing in this program may alter it; every phase is checked against it.
**Nature:** Execution blueprint only. No production code, migrations, APIs, or UI are produced here.
**Date:** 2026-07-04

---

## 0. Program guardrails & assumptions

### 0.1 Invariants every phase must satisfy (no exceptions)
Compiles · deploys independently · reversible · zero regressions · preserves production behavior · no Contract-v2 drift · flag-gated · observable.

### 0.2 The reuse decision (avoids drift and waste)
The Phase-1 foundation (`ai-platform/*`, flag **OFF**, unused in prod) is the **seed**, not a parallel design. It is **refactored in place** to Contract v2: the vetted adapters gain the Provider Port; `runCapability`/`gatewayGenerateText`/`generateText` become **compatibility shims over the new `invoke(AIRequest)`**. Because nothing in production depends on the Phase-1 gateway yet (flag off), this refactor is low-risk.

### 0.3 Estimation legend (planning sizes, NOT hours)
Complexity: **S** (isolated) · **M** (one subsystem) · **L** (cross-cutting) · **XL** (multi-subsystem + external). Duration ranges assume a **focused 2–3 engineer team**; with the current **bus-factor-1** staffing (see §12) multiply by ~2.5–3× and treat the timeline as aspirational until a second platform engineer is added.

### 0.4 Flag taxonomy (used throughout)
`AI_PLATFORM_ENABLED` (global) · `AI_PLATFORM_ENABLED_WORKSPACES` (canary list) · `AI_CAP_<key>_ENABLED` (per-capability cutover) · `AI_SAFETY_MODE` / `AI_COST_MODE` / `AI_GOV_MODE` ∈ {`off`,`permissive`,`enforced`} · `AI_PLATFORM_REQUIRED` (fail-closed master, §E5).

---

## 1. Program structure — five epics

| Epic | Theme | Phases | Gate to start |
|---|---|---|---|
| **A** | Core v2 platform (reconcile Phase 1 → Contract v2) | P0–P8 | approved contract |
| **B** | Capability migration (one at a time) | W1–W6 (C1–C15) | A core (P1–P7) landed |
| **C** | Governance + AI Studio | G1–G5 | P4 (registry v2) |
| **D** | Advanced modality/agentic (streaming, tools, memory, retrieval, orchestration) | D1–D4 | P3 (invoke) |
| **E** | Enforcement + legacy removal | E1–E5 | dependent waves done |

Epics C and D run **in parallel** with Epic B. Epic E is terminal.

---

## 2. Epic A — Core v2 platform phases (full field treatment)

### P0 — Program & test-harness setup
- **Objective:** make every later phase measurable and reversible.
- **Scope:** CI pipeline (currently absent — DD gap), golden-output corpus infra, parity-diff runner, latency/cost baseline capture, flag plumbing, provider mock/fixtures.
- **Files affected:** `tests/*` (new AI harness), CI config (new), `ai-platform/testing/*` (fixtures/mocks) — all **new**, none behavioral.
- **DB changes:** none (test DB provisioning only).
- **API changes:** none. **UI changes:** none.
- **Risk:** **Low** (net-new, no prod path).
- **Rollback:** delete harness; nothing else references it.
- **Regression risks:** none (no prod code touched).
- **Automated tests:** the harness itself is the deliverable; self-test on fixtures.
- **Manual QA:** verify CI runs on PR and blocks on failure.
- **Success:** CI green; golden-diff runner produces a deterministic report on a sample capability.
- **Exit:** parity harness can capture legacy output for any capability and diff a candidate.

### P1 — v2 contract types (the envelope)
- **Objective:** introduce `AIRequest`/`AIResponse`/`Part`/`ErrorInfo`/`Usage` as the internal contract.
- **Scope:** type/interface layer + validators; **no** call-site changes.
- **Files:** `ai-platform/contract/*` (new). 
- **DB:** none. **API:** none. **UI:** none.
- **Risk:** **Low** (additive types).
- **Rollback:** remove module.
- **Regression risks:** none.
- **Automated tests:** contract unit tests (part discrimination, forward-compat unknown-kind ignore, envelope validation).
- **Manual QA:** none.
- **Success/Exit:** envelope round-trips a text request identical to today's `{prompt}`; unknown parts ignored, not errored.

### P2 — Provider Port upgrade + negotiation (permissive)
- **Objective:** give existing adapters `describe()/negotiate()/health()/estimateCost()` without changing text behavior.
- **Scope:** `ai-platform/providers/*` (extend), provider descriptors, model descriptors seed.
- **Files:** provider adapters, `providers/registry.js`, new `providers/descriptors/*`.
- **DB:** additive columns on `ai_providers`/`ai_models` (supports flags, modalities, pricing) — idempotent.
- **API:** none. **UI:** none.
- **Risk:** **Medium** (touches adapters; but `invoke` still text).
- **Rollback:** feature-flag the negotiation path; adapters retain legacy `generate`.
- **Regression risks:** adapter request-shape drift → **guarded by golden output per provider** (P0).
- **Automated tests:** contract tests per adapter vs recorded provider fixtures; negotiation unit matrix.
- **Manual QA:** live smoke against each configured provider in staging.
- **Success:** every adapter reports capabilities; `negotiate()` correctly accepts/rejects a sample requirement; text output byte-identical to legacy on the golden corpus.
- **Exit:** compatibility resolution can prove a provider/model satisfies a capability's `requires`.

### P3 — Gateway v2 `invoke()` + compatibility shims
- **Objective:** single `invoke(AIRequest): AIResponse` (buffered) as the real execution path; `generateText`/`runCapability` become shims over it.
- **Scope:** `ai-platform/gateway.js` rewrite around `invoke`; retry moves to per-capability policy; resolver split into ConfigResolver + CompatibilityResolver.
- **Files:** `gateway.js`, `config/resolver.js`, `services/llm.js` (shim only — legacy path preserved as today).
- **DB:** none. **API:** none. **UI:** none.
- **Risk:** **Medium-High** (central path) — mitigated: flag OFF keeps `legacyGenerateText`.
- **Rollback:** `AI_PLATFORM_ENABLED=false` (instant, byte-for-byte legacy).
- **Regression risks:** output/latency drift on flag-on path → golden + latency gates before any canary.
- **Automated tests:** invoke() integration with mock adapter; shim parity (generateText(old) == invoke(new) on corpus); retry idempotency tests.
- **Manual QA:** canary workspace smoke.
- **Success:** with flag on for a test workspace, `generateText` results match legacy within parity tolerance; with flag off, zero change.
- **Exit:** `invoke()` is the sole execution path when enabled; shims delegate to it.

### P4 — Capability registry v2 (contract vs configuration split)
- **Objective:** enforce code-owned **contract** vs DB-owned **configuration**; expand metadata (`requires`, modality, execution class, criticality, retry, sensitivity, permissions).
- **Scope:** `capabilities/registry.js` (contracts), new config tables; seeding maps code→config once, then config is authoritative.
- **Files:** `capabilities/*`, resolver.
- **DB:** additive columns/tables (`ai_capability_config`), idempotent; **no** change to existing tables.
- **API:** none yet (Epic C). **UI:** none yet.
- **Risk:** **Medium**.
- **Rollback:** drop new columns/tables; registry falls back to code defaults (non-regressive by design).
- **Regression risks:** resolution precedence bug → covered by resolver unit matrix (P3) extended with `requires`.
- **Automated tests:** contract/config precedence tests; negotiation-vs-requires tests.
- **Manual QA:** verify a capability with `requires.json` rejects a non-JSON provider config.
- **Success:** every seeded capability carries full metadata; incompatible config is rejected at resolution.
- **Exit:** contract and config are provably separate; no split-brain.

### P5 — Observability v2 (trace, execution tree, trigger)
- **Objective:** trace context + parent/child spans + `sourceModule` + `trigger` on every invocation.
- **Scope:** `telemetry/*`, gateway instrumentation, propagate `TraceContext`/`ExecutionContext`.
- **Files:** `telemetry/requestLog.js` (+columns), gateway.
- **DB:** additive columns on `ai_request_logs` (trace_id, span_id, parent_span_id, source_module, trigger_type, parent_request_id).
- **API:** none. **UI:** none (dashboard is G-series).
- **Risk:** **Low-Medium** (best-effort, never throws).
- **Rollback:** telemetry flag; columns nullable.
- **Regression risks:** none (off critical path).
- **Automated tests:** span-tree assembly unit tests; propagation tests across a multi-pass capability.
- **Manual QA:** confirm an agent-style fan-out shows a single trace tree.
- **Success/Exit:** any invocation is traceable to its business trigger and parent.

### P6 — Cost engine (estimate before execution; permissive)
- **Objective:** pre-execution cost estimate from pricing tables; record actuals; **observe-only** (no blocking yet).
- **Scope:** `cost/*`, pricing seed on `ai_models`, gateway pre/post hooks.
- **Files:** `ai-platform/cost/*` (new), gateway, telemetry (est + actual cost columns).
- **DB:** additive (pricing columns already added P2; `ai_request_logs.est_cost_usd`/`actual_cost_usd`).
- **API:** none. **UI:** none.
- **Risk:** **Low** (permissive).
- **Rollback:** cost flag off.
- **Regression risks:** none (log-only).
- **Automated tests:** cost-estimate unit tests vs known pricing; token-estimate accuracy tests.
- **Manual QA:** compare estimated vs provider-billed on staging traffic.
- **Success:** `est_cost_usd` populated (fixes the "always null" gate finding); budgets *could* fire (enforcement in E1).
- **Exit:** pre-exec estimation accurate within an agreed tolerance band.

### P7 — Safety pipeline (permissive)
- **Objective:** injection scan, variable isolation, output-schema validation, PII tagging — **observe-and-tag**, don't block.
- **Scope:** `safety/*`, gateway input/output stages, prompt variable escaping.
- **Files:** `ai-platform/safety/*` (new), gateway, prompt resolver.
- **DB:** additive (`ai_safety_events`).
- **API:** none. **UI:** none.
- **Risk:** **Medium** (touches prompt assembly) — permissive mode + golden output guards behavior.
- **Rollback:** `AI_SAFETY_MODE=off`.
- **Regression risks:** variable-escaping could alter prompts → golden diff MUST show no change in permissive mode (escaping applied but output-equivalent, then tightened later).
- **Automated tests:** injection corpus (red-team prompts) detection rate; schema-validation tests; PII detector precision/recall.
- **Manual QA:** review flagged-but-not-blocked events on staging.
- **Success:** injection/PII events recorded; output schema validated where declared; zero output change vs legacy in permissive.
- **Exit:** safety telemetry trustworthy enough to later enforce (E2).

### P8 — Key ownership + secret-manager resolution
- **Objective:** `KeyRef` indirection; platform-managed keys first; BYO scaffolding; secrets resolved only in adapters.
- **Scope:** `keys/*`, adapter key resolution via secret manager, `ai_key_ownership` table.
- **Files:** `providers/base.adapter.js` (key resolution), `ai-platform/keys/*` (new).
- **DB:** additive `ai_key_ownership` (+ encrypted `KeyRef`, never raw secret).
- **API:** none. **UI:** none.
- **Risk:** **Medium** (security-sensitive) — no behavior change if only platform keys configured.
- **Rollback:** fall back to env-name resolution (current behavior).
- **Regression risks:** key resolution failure → provider auth errors; covered by staging smoke per provider.
- **Automated tests:** KeyRef resolution unit tests (env / secret-manager stubs); "secret never logged/returned" assertions.
- **Manual QA:** rotate a staging key via secret manager without redeploy.
- **Success:** adapters resolve keys via `KeyRef`; per-workspace BYO path proven on one workspace.
- **Exit:** who-pays/whose-key model operational (closes gate Critical #4); ready for enterprise BYO.

---

## 3. Epic B — Capability migration order (with rationale)

### 3.1 Ordering principle
Migrate by ascending **blast radius** and descending **diffability**: internal, async, read-only, easily golden-tested capabilities first; user-facing/realtime next; data-mutating; then agentic/tool-calling; the cross-repo `ai-service` **last**. Prestige (meeting_intelligence) does not jump the queue — but it ranks early because it is **async + produces stored artifacts** (ideal for offline parity).

### 3.2 The order
| Wave | Phase | Capability | Why here |
|---|---|---|---|
| **W1** | C1 | `llm_explanation` | Smallest, internal, single-shot text. Proves `invoke`+shim+telemetry+parity harness at minimum blast radius. |
| W1 | C2 | `forecast_reasoning` | Internal, async/batch, read-only. First JSON-output + schema-validation exercise. |
| W1 | C3 | `executive_summary` | Cron-generated, **stored artifact** → perfect golden-output diff; multi-input context. |
| W1 | C4 | `dashboard_summary` | Read-only but higher traffic → introduces **caching + cost estimation at volume** safely. |
| W1 | C5 | `risk_analysis` | Internal scoring narrative; rounds out the intelligence cluster on proven patterns. |
| **W2** | C6 | `meeting_intelligence` (+ `huddle_topic_segmentation`, `huddle_risk_blocker_extraction`, `huddle_language_normalization`) | **Flagship.** Already async via worker → reversible & diffable. Proves **multi-step composition / `dependsOn`**; biggest observability + value win. |
| W2 | C7 | `huddle_copilot` | Near-real-time, huddle-scoped. Migrated after batch huddle caps prove the pipeline; first lower-latency path. |
| **W3** | C8 | `workspace_assistant` | First **user-facing realtime + RAG**. Requires Safety (P7) over untrusted user text + Retrieval (D3) at least permissive. Higher blast radius → deferred until safety/observability proven. |
| W3 | C9 | `ai_features` | Assistant grab-bag; reuses C8 patterns. |
| **W4** | C10 | `autopilot_standup` | **Writes chat messages** (side effects). Needs scheduling + idempotency proven. |
| W4 | C11 | `nl_task_creation` | **Mutates core task data** — highest care; output-schema validation + human-confirm patterns. |
| W4 | C12 | `task_suggestions` | Lower side-effect sibling of C11; same wave. |
| **W5** | C13 | `testing_agent` | **Agentic / tool-calling** → requires Tool contract (D2) + orchestration (D4) + browser tool. |
| W5 | C14 | `smart_browser_test` | Same family; reuses D2/D4. |
| **W6** | C15 | `chat_away_responder` (**ai-service**, cross-repo) | **Last.** Requires the external AI API (D1) + cross-repo coordination; lets us delete the duplicate LLM client and route it through the gateway — achieving "no scattered AI." |

### 3.3 Per-capability migration template (applied to each C-phase)
Each capability phase carries the same fields; the distinguishing content is the **special-handling** notes below.

> **Standard fields (all C-phases):**
> **Objective** — route capability X through `invoke()` behind `AI_CAP_X_ENABLED`, config-driven, no behavior change until parity-passed.
> **Scope/Files** — the capability's service file(s) (e.g., `services/huddleMeetingIntelligence.service.js`) swap `generateText(...)` → `invoke({capability:"X", input, variables, ...})`; move its inline prompt into the Prompt registry (draft→published) preserving text exactly.
> **DB** — none beyond registry rows (prompt/version/config). **API/UI** — none (Studio manages later).
> **Risk** — per table. **Rollback** — `AI_CAP_X_ENABLED=false` → falls back to the legacy shim → then global flag off.
> **Regression risks** — output/latency/cost drift; **guarded by a per-capability golden corpus + latency/cost gates before flip.**
> **Automated tests** — capability parity (legacy vs invoke), prompt-render equivalence, output-schema validation.
> **Manual QA** — capability-specific workflow on canary workspace.
> **Success/Exit** — parity within tolerance on the corpus; canary clean for the soak window; then progressive workspace rollout.

### 3.4 Special handling (representative deep-dives)

**C6 `meeting_intelligence`**
- **Current:** `services/huddleMeetingIntelligence.service.js` + sibling huddle services call `generateText` inline, multi-pass, from a worker/cron; output persisted to `huddle_meeting_digests`.
- **Target:** a composed capability — parent `meeting_intelligence` invokes sub-capabilities (`dependsOn`) each as their own `invoke()`, unified trace tree (P5), structured output validated against a digest schema (P7).
- **Migration steps:** (1) register the 4 prompts verbatim; (2) migrate sub-caps first (topic/risk/language) with golden diffs on recorded transcripts; (3) migrate the parent orchestration; (4) canary on one internal workspace; (5) diff produced digests vs legacy on a fixed transcript set.
- **Compatibility adapter:** legacy path stays until digests match; both can run shadow (produce v2 digest, compare, discard) before flip.
- **Parity:** golden digests (decisions/action-items/summary) with semantic-equivalence scoring, not string-equality (LLM nondeterminism) — see §5.
- **Rollback:** per-cap flag; shadow mode means zero user exposure during validation.
- **Risks:** nondeterminism inflating false parity failures → mitigated by deterministic profile + semantic scoring + tolerance band.

**C8 `workspace_assistant`**
- **Current:** `ai/ai.intelligence.service.js` RAG over sanitized context, `[OUT_OF_SCOPE]` guard, deterministic fallback.
- **Target:** `invoke()` with Retrieval directive (D3), Safety strict-ready (injection over user questions), structured refusal via output schema; the existing ID-sanitization becomes a Safety-pipeline redaction step.
- **Special:** first capability where **injection defense must be real** before enforced mode; keep the deterministic fallback as the platform's provider-unavailable path.
- **Risks:** user-facing latency; RAG grounding correctness → grounding check (P7/D3) + latency gate.

**C10 `autopilot_standup` / C11 `nl_task_creation`**
- **Special:** side-effecting. Require `idempotencyKey` (§13) so a retried invocation never double-posts a standup or double-creates a task. Parity is on the *proposed* content, with a dry-run/shadow mode that generates but does not commit until validated.

**C15 `chat_away_responder` (ai-service, cross-repo)**
- **Current:** separate `ai-service` with its **own** duplicate LLM client, called via `AI_SERVICE_URL`.
- **Target:** `ai-service` calls the backend's **external AI API** (D1) which fronts `invoke()`; the duplicate `llm.service.js` is deleted; the away-responder becomes capability `chat_away_responder`.
- **Special:** cross-repo release coordination; the external API must be GA (D1) and authed via the existing service-secret model (hardened per DD). Achieves the program's "no scattered AI" success criterion.

---

## 4. Epic C — Governance + AI Studio

| Phase | Objective | DB | API | UI | Risk | Rollback | Exit |
|---|---|---|---|---|---|---|---|
| **G1** | Governance matrix (object×verb×role×scope) + audit; **permissive** | `ai_grants`,`ai_locks`,`ai_audit` (additive) | `/superadmin/ai-platform/*` read+write (superadmin-mounted before global auth) | none | M | `AI_GOV_MODE=off` | grants/locks resolvable; all changes audited |
| **G2** | AI Studio: Providers · Models · **Observability** (read-first) | none | read APIs | new pages (existing design system, no redesign) | L | route flag | admins can *see* config/health before editing |
| **G3** | AI Studio: **Prompt Library** (draft/test/preview/diff/approve/publish/rollback) | prompt tables (exist) | prompt APIs | prompt pages | L | route flag | non-technical admin can safely edit+test+publish a prompt |
| **G4** | AI Studio: Capabilities/Routing · Policies/Budgets · Key Ownership | config tables | config APIs | pages | L | route flag | per-capability routing + budgets editable with guardrails |
| **G5** | Governance **enforcement** (permissive→enforced) | none | none | none | M | `AI_GOV_MODE=permissive` | unauthorized/ locked writes are blocked (fail-closed) |

**Studio UX guardrails (constitutional):** admin-task framing (not engineer jargon), safe defaults, **test-before-publish** in-flow, blast-radius warnings ("affects N workspaces"), inline cost preview, validation preventing dangerous configs (no provider without a key; can't remove the only fallback).

---

## 5. Epic D — Advanced modality / agentic

| Phase | Objective | Depends | Risk | Exit |
|---|---|---|---|---|
| **D1** | Streaming transport (SSE/WebSocket) + **external AI API** facade over `invoke()` (for web/Electron/Flutter/integrations) | P3 | M | clients stream responses; external API authed + rate-limited |
| **D2** | Tool contract + tool registry + permissioned/ safety-classed execution + agent loop bounds | P3,P4 | L | a governed tool can be invoked within `maxSteps` |
| **D3** | Memory + Retrieval ports (tenant-scoped, retention/forget) | P3,P7 | L | RAG + memory available to capabilities; citations grounded |
| **D4** | Multi-step / agent orchestration (steps, execution tree, DLQ) | D2,P5,§13 scheduling | XL | a bounded multi-tool capability runs, fully traced |

D1–D4 unblock W5/W6 and future voice/vision/computer-use — all as Contract-v2 parts/directives (no contract change).

---

## 6. Epic E — Enforcement & legacy removal (terminal)

| Phase | Objective | Precondition | Rollback |
|---|---|---|---|
| **E1** | Cost budgets **enforced** (fail-closed hard limits) | P6 accurate; W1–W4 migrated | `AI_COST_MODE=permissive` |
| **E2** | Safety **enforced** (injection/PII/content block) | P7 telemetry trusted | `AI_SAFETY_MODE=permissive` |
| **E3** | Route `ai-service` through gateway; **delete duplicate LLM client** | C15 done, D1 GA | revert ai-service to shim |
| **E4** | Remove legacy provider code in `services/llm.js`; delete v1 shim | **all** callers migrated + soaked | git revert (behavioral no-op since shim unused) |
| **E5** | `AI_PLATFORM_REQUIRED=on` (fail-closed master; no env-default degradation) | E1–E4 stable | flip back to permissive |

**E4/E5 are the definition of done:** no scattered AI, everything through the gateway, providers fully abstracted, governance/cost/safety enforced.

---

## 7. Rollout strategy (per phase & per capability)

**Environment ladder:** Developer → Local → **QA** (automated gates) → **Staging** (prod-like, live providers) → **Canary** (1 internal workspace) → **Progressive workspace rollout** (5% → 25% → 50% → 100%) → **Production GA**.

- **Feature flags:** global → workspace canary → per-capability → per-mode (off/permissive/enforced). A capability advances only when the prior ring is clean for its **soak window** (24–72h depending on traffic/criticality).
- **Progressive/workspace rollout:** driven by `AI_PLATFORM_ENABLED_WORKSPACES` and `AI_CAP_X_ENABLED`; business-critical capabilities (meeting_intelligence) get longer soaks and shadow-mode first.
- **Shadow mode:** for async/diffable capabilities, run v2 alongside legacy, compare, discard v2 output until parity proven — **zero user exposure** during validation.
- **Emergency rollback:** any flag flip is instant and byte-for-byte (legacy path preserved through E3). A single global kill-switch (`AI_PLATFORM_ENABLED=false`) reverts the entire platform.

---

## 8. Regression strategy (six guarantees)

| Guarantee | Mechanism | Gate (block if…) |
|---|---|---|
| **No output regressions** | Golden corpus per capability + **semantic-equivalence scoring** (embedding similarity + rubric checks), not string-equality (LLM nondeterminism) | similarity below tolerance or rubric fail |
| **No latency regressions** | p50/p95 captured pre-migration; per-capability latency budget | p95 exceeds baseline + agreed % |
| **No cost regressions** | Pre-exec estimate + actuals; per-capability cost/call baseline | cost/call exceeds baseline band |
| **No permission regressions** | Governance matrix test suite (grant/deny per verb/role/scope) | any unauthorized allow / authorized deny |
| **No tenant regressions** | Cross-tenant isolation tests (workspace A cannot read B's config/logs/keys) | any cross-tenant leakage |
| **No security regressions** | Injection red-team corpus, secret-never-logged assertions, RLS tests on `ai_*` | any injection success / secret leak / RLS gap |

All six run in CI (P0) and again pre-canary; enforced gates block promotion.

---

## 9. Testing strategy (by type)

| Type | Guards | Runs |
|---|---|---|
| **Unit** | resolver precedence, `pickWithLock`, profile precedence, part discrimination | CI, every PR |
| **Integration** | `invoke()` end-to-end with mock adapter + test DB | CI |
| **Contract** | each adapter vs recorded provider fixtures; `negotiate()` matrix | CI |
| **Golden output** | semantic parity per capability | pre-canary + nightly |
| **Performance** | latency budgets per capability | pre-canary |
| **Load** | gateway throughput, queue/concurrency (§13) | pre-GA of async waves |
| **Security** | injection corpus, PII, secret handling, RLS, permission matrix | CI + pre-GA |
| **Chaos** | provider timeouts/500s, DB blips, secret-manager down | staging, pre-GA |
| **Provider failover** | ordered fallback on provider outage (§5/§18) | staging, per business-critical cap |
| **Prompt regression** | prompt-version A/B on golden set; block regressive publish | in Prompt Library (G3) |
| **Cost validation** | estimate vs billed reconciliation | staging nightly |
| **Streaming** | SSE/WS chunk ordering, cancellation, final==buffered | D1 |
| **Tool calling** | tool schema, bounded loops, side-effect/idempotency | D2/D4 |
| **Future capabilities** | vision/audio parts accepted; unknown-kind ignored (forward-compat) | contract tests (P1) |

---

## 10. Production readiness checklist (every phase passes before promotion)

- [ ] Compiles; deploys independently; **flag OFF = zero change** verified.
- [ ] All six regression gates (§8) green on the affected scope.
- [ ] Golden parity within tolerance (for capability phases).
- [ ] Latency p95 and cost/call within baseline bands.
- [ ] Rollback rehearsed (flag flip verified to restore legacy).
- [ ] Observability: traces/spans/cost/safety events visible for the phase.
- [ ] Security: no secret in logs; RLS/permission/tenant tests pass.
- [ ] Runbook + alert thresholds updated; on-call aware.
- [ ] Contract-v2 conformance review (no drift) signed off.
- [ ] Canary soak clean for the required window.

---

## 11. MASTER IMPLEMENTATION PROGRAM

### 11.1 Phase ledger
| ID | Phase | Epic | Complexity | Duration (2–3 eng) | Depends on | Priority |
|---|---|---|---|---|---|---|
| P0 | Harness/CI | A | M | 1–2 wk | — | P0-critical |
| P1 | Contract types | A | S | ~1 wk | P0 | critical |
| P2 | Provider Port + negotiate | A | L | 2–3 wk | P1 | critical |
| P3 | Gateway `invoke()` + shims | A | L | 2–3 wk | P1,P2 | critical |
| P4 | Registry v2 (contract/config) | A | M | 1–2 wk | P3 | critical |
| P5 | Observability v2 | A | M | 1–2 wk | P3 | high |
| P6 | Cost engine (permissive) | A | M | 1–2 wk | P2,P5 | high |
| P7 | Safety pipeline (permissive) | A | L | 2–3 wk | P3 | high |
| P8 | Key ownership | A | M | 1–2 wk | P2 | high |
| W1 | C1–C5 (intelligence cluster) | B | M each (S corpus) | 2–3 wk total | P3,P4,P5 | high |
| W2 | C6–C7 (huddle/meeting) | B | L | 2–4 wk | W1,P7 | high |
| W3 | C8–C9 (assistant/RAG) | B | L | 2–4 wk | W2,P7,D3 | medium |
| W4 | C10–C12 (writers) | B | L | 2–4 wk | W1,§13 idempotency | medium |
| W5 | C13–C14 (agentic) | B | XL | 3–5 wk | D2,D4 | medium |
| W6 | C15 (ai-service) | B | L | 2–3 wk | D1 | medium |
| G1 | Governance matrix | C | M | 1–2 wk | P4 | high |
| G2–G4 | AI Studio | C | L | 4–6 wk | G1,P5,P6 | medium |
| G5 | Governance enforced | C | M | ~1 wk | G1–G4,W1–W4 | medium |
| D1 | Streaming + external API | D | L | 2–3 wk | P3 | medium |
| D2 | Tools | D | L | 2–3 wk | P3,P4 | medium |
| D3 | Memory + Retrieval | D | L | 2–3 wk | P3,P7 | medium |
| D4 | Orchestration | D | XL | 3–5 wk | D2,P5 | medium |
| E1–E5 | Enforcement + cleanup | E | M–L | 3–5 wk | dependents done | terminal |

### 11.2 Critical path
`P0 → P1 → P2 → P3 → P4 → P7 → W1 → W2 (meeting_intelligence GA)` is the **value-critical path** (fastest route to the flagship on the platform). The **completion-critical path** extends: `… → D1/D2/D3/D4 → W5/W6 → E1..E5`. P2 and P3 are the two highest-leverage phases — everything waits on them.

### 11.3 Parallelism (what can run concurrently)
- After **P3**: Epic D (streaming/tools/memory) can start in parallel with W1.
- After **P4**: Epic C (governance + Studio) runs parallel to Epic B.
- **P5/P6/P7** can be built in parallel with W1 (they are permissive/observe-only, so they don't block early waves).
- Within a wave, sibling capabilities (e.g., C1/C2/C5) parallelize across engineers.

### 11.4 Milestones
- **M1 "Platform live, invisible":** P0–P4 done, flag on for internal workspace, `generateText` runs through `invoke()` with parity. (Nothing user-visible changed.)
- **M2 "Flagship on-platform":** W1 + W2 GA; meeting_intelligence fully governed/observed/cost-metered.
- **M3 "Governed":** Epic C GA; admins self-serve providers/prompts/routing/budgets via AI Studio.
- **M4 "Agentic-ready":** Epic D GA; tools/memory/streaming available; W5/W6 migrated.
- **M5 "No scattered AI":** Epic E complete; legacy removed; enforced modes on; `AI_PLATFORM_REQUIRED` on.

### 11.5 Implementation priority (if forced to sequence a single engineer)
1. P0→P4 (platform spine) → 2. P5–P8 (observability/cost/safety/keys, permissive) → 3. W1→W2 (prove value) → 4. G1 + Studio read-only (visibility) → 5. W3–W4 → 6. D-series → 7. W5–W6 → 8. Enforcement + cleanup (E).

---

## 12. Program risks (must be managed, not ignored)
- **Bus factor = 1 (top risk).** A year-long platform migration cannot be safely executed or maintained by one engineer; the timeline and quality both assume a second platform engineer. **Recommendation: staff a 2nd engineer before P2.**
- **No pre-existing CI/tests** (DD finding): P0 is therefore a hard prerequisite, not optional.
- **LLM nondeterminism** breaking naive parity: mitigated by deterministic profiles + semantic scoring + shadow mode.
- **Provider churn / deprecations** mid-program: mitigated by model aliases (Contract §6) — a data change, not a code change.
- **Scope creep into redesign:** forbidden — Contract v2 is frozen; any "we need to change the contract" is a stop-and-escalate event, not an in-flight edit.
- **Prod-secret exposure (open DD item):** must be rotated **before** BYO-key work (P8) touches secret managers.

---

## 13. What this program explicitly does NOT do
No production code, no migrations, no APIs, no UI, no Contract-v2 changes, no Phase-2 start. This is the plan of record. Execution begins only on explicit authorization, phase-by-phase, each gated by §10.

*End of Master Implementation Program.*
