# Asystence AI Platform — Master Implementation Program **V2** (Definitive)

**Author role:** Chief Platform Engineer / Technical Program Director.
**Supersedes:** `ASYSTENCE_AI_PLATFORM_MASTER_IMPLEMENTATION_PROGRAM_2026-07-04.md` (V1).
**Reconciles:** all accepted findings from `ASYSTENCE_AI_PLATFORM_IMPLEMENTATION_READINESS_AUDIT_2026-07-04.md`.
**Unchanged & frozen:** Contract v2 and the architecture. This document changes **only the execution plan** to match the real repositories.
**Nature:** Execution blueprint. No production code, migrations, APIs, or UI.
**Date:** 2026-07-04

---

## 0. Changes from V1 (every accepted audit finding applied)

| # | V1 assumption | V2 correction | Applied in |
|---|---|---|---|
| 1 | Canonical AI service = `Desktop/task_m/ai-service` (764-line stub) | **Canonical = `C:\Users\…\Documents\GitHub\ai-task`** (real agentic service, own `.git`). Desktop copy is stale → ignored/deleted | §1, Epic B′, Epic E |
| 2 | ai-service migration = one line in W6 | **New Epic B′** — full ai-task migration workstream (~9 capabilities) | §Epic B′ |
| 3 | `enterprise_intelligence` absent | **Registered** (4 `generateText` calls, json) → W1 | §Capabilities, W1 |
| 4 | `browser_agent` absent | **Registered** (15 `generateText` calls) → W5 agentic | §Capabilities, W5 |
| 5 | `dashboard_summary`, `task_suggestions`, `risk_analysis` are capabilities | **Removed** (no backing LLM code) | §Capabilities |
| 6 | One executive summary; `llm_explanation` via `generateText` | **Two exec-summary impls, split by backend**: `intelligence/executiveSummary.generator.js` (generateText → W1) vs `events/executive` + `events/llm/llmExplanation` (`generateNarrative → ai-service` → Epic B′) | §Capabilities, W1, B′ |
| 7 | 2 LLM clients | **4–5 clients + 2 bypass paths enumerated** | §1, Epic E |
| 8 | Entry points = routes/crons/workers | **Added** `/explain`, monthly-narrative jobs, ai-task webhook/eventBus | §Entry points |
| 9 | Migration order as V1 | **Re-ordered**: enterprise_intelligence→W1, browser_agent→W5, events-narrative→B′ | §Order |
| 10 | Prompt migration ≈ per-capability | **Re-baselined ~2×** (~40 backend sites + ai-task) | §Estimates |
| 11 | Rollout single-repo | **Cross-repo coordination** for B′ (backend external API GA before ai-task cutover) | §Rollout |
| 12 | Epic E deletes "the duplicate client" | **Enumerates all 4–5 clients + 2 bypass paths** | §Epic E |

**No change to:** Contract v2, the five-epic architecture, the phase-gating philosophy, the six regression guarantees, the testing taxonomy, or the readiness checklist (all carried forward from V1 unchanged unless noted).

---

## 1. Verified AI surface (the reconciled source of truth)

### 1.1 LLM clients (Epic E cleanup targets)
| # | Client | Location | Providers | Disposition |
|---|---|---|---|---|
| 1 | `services/llm.js` | backend | ollama/openai/grok/groq/huggingface | **KEEP** → becomes gateway shim (Phase 1 done) |
| 2 | `intelligence/llm/llmClient.js` | backend | re-export of #1 | Collapse into #1 (benign) |
| 3 | `events/llm/llmClient.js#generateNarrative` | backend | **HTTP → `AI_SERVICE_URL`** | **Bypass** → re-path through gateway/external API (Epic B′/E) |
| 4 | `src/services/llmResponder.js` | **ai-task** | groq/openai/local | Retire via external AI API (D1) |
| 5 | `src/autoReply/summarizer.js` | **ai-task** | direct OLLAMA | Retire via external AI API (D1) |
| — | `Desktop/task_m/ai-service/**` | stale copy | groq/ollama | **Delete** (not canonical) |
| — | `services/huddleSttProvider.service.js` | backend | Deepgram/OpenAI/Groq/AssemblyAI | STT/audio — **separate track**, keep |

### 1.2 AI entry points
HTTP: `/ai/*`, `/ai-features`, `/huddle/intelligence/*`, `/autopilot/*`, `/testing-agent/*`, `/adaptive/*`. Crons: `huddleIntelligence`, `monthlyIntelligence`, `autopilot`, `reviews`. Workers: `adaptiveWorker`, `huddleIntelligenceWorker`. Events: `aiObserver`, monthly scoring/executive jobs (→ `generateNarrative`), `realtime/ai.socket.js`. ai-task: `/internal/chat-event`, `/internal/clear-dm-context`, `/explain/:messageId`, internal `eventBus.on("chat:new-message")`.

### 1.3 Capability register (corrected)
**Backend, via `generateText` (migratable in Epic B):**
workspace_assistant · autopilot_standup · executive_summary (intelligence) · forecast_reasoning · **enterprise_intelligence (NEW)** · ai_features · **browser_agent (NEW)** · huddle_copilot · nl_task_creation · smart_browser_test · testing_agent · meeting_intelligence · huddle_topic_segmentation · huddle_risk_blocker_extraction · huddle_language_normalization.
**Backend, via `generateNarrative → ai-service` (migratable in Epic B′):** executive_summary (events) · user_monthly_narrative (was mis-registered as `llm_explanation`).
**ai-task service (Epic B′):** away_responder · ai_task_creation · report_generation · decision_intelligence · summarization · conversation_memory · explain_endpoint.
**Removed (speculative, no code):** ~~dashboard_summary~~ · ~~task_suggestions~~ · ~~risk_analysis~~ (risk narrative is inside enterprise_intelligence).
**Separate track (audio):** huddle transcription/STT.

---

## 2. Epic structure (V2)

| Epic | Theme | Phases | Change vs V1 |
|---|---|---|---|
| **A** | Core v2 platform | P0–P8 | unchanged |
| **B** | Backend capability migration (`generateText`) | W1–W5 | order corrected; +2 caps; −3 speculative |
| **B′** | **ai-task service migration (NEW)** | Q1–Q4 | **new epic** |
| **C** | Governance + AI Studio | G1–G5 | unchanged |
| **D** | Advanced modality/agentic | D1–D4 | unchanged (D1 now also gates B′) |
| **E** | Enforcement + legacy removal | E1–E5 | cleanup scope expanded to all clients |

---

## 3. Epic A — Core platform (P0–P8): unchanged
Carried forward verbatim from V1 (harness/CI → contract types → provider port + negotiation → gateway `invoke()` + shims → registry v2 → observability → cost engine → safety pipeline → key ownership). The Phase-1 foundation remains the seed; all phases permissive/flag-gated; zero behavior change. **One note:** P4 registry seeding must include the two newly registered capabilities and exclude the three speculative ones.

---

## 4. Epic B — Backend capability migration (corrected order)

Same per-capability template as V1 (§3.3): swap `generateText(...)` → `invoke({capability,…})`, move inline prompt into the registry verbatim, behind `AI_CAP_<key>_ENABLED`, parity-gated, per-cap rollback.

| Wave | Capability | File | Notes vs V1 |
|---|---|---|---|
| **W1** | forecast_reasoning | `intelligence/forecast/forecast.reasoning.js` | unchanged |
| W1 | executive_summary (intelligence) | `intelligence/executiveSummary.generator.js` | **canonical** exec-summary; the events one goes to B′ |
| W1 | **enterprise_intelligence** | `intelligence/enterpriseIntelligence.service.js` | **NEW**; 4 json calls; author golden corpus |
| **W2** | meeting_intelligence (+ topic/risk/language subs) | `services/huddleIntelligenceGeneration.service.js` (+3) | **injection seam `generate=`** → inject gateway for clean shadow-parity |
| W2 | huddle_copilot | `services/huddleCopilot.service.js` | unchanged |
| **W3** | workspace_assistant | `ai/ai.intelligence.service.js` | needs Safety(P7)+Retrieval(D3) permissive |
| W3 | ai_features | `services/aiFeatures.service.js`, `routes/aiFeatures.routes.js` | unchanged |
| **W4** | autopilot_standup | `autopilot/autopilot.engine.js` | idempotency (writes chat) |
| W4 | nl_task_creation | `services/nlTaskCreation.service.js` | idempotency (mutates tasks); ~~task_suggestions removed~~ |
| **W5** | testing_agent | `services/testingAgent.service.js` (7) | needs D2/D4 |
| W5 | smart_browser_test | `services/smartBrowserTest.service.js` (2) | needs D2/D4 |
| W5 | **browser_agent** | `services/browserAgent.service.js` (**15**) | **NEW**; largest agentic surface; needs Tool(D2)+orchestration(D4) |

**Removed from V1 order:** `llm_explanation` (→ B′), `dashboard_summary`, `task_suggestions`, `risk_analysis`.

---

## 5. Epic B′ — ai-task service migration (NEW)

**Canonical repo:** `C:\Users\…\Documents\GitHub\ai-task`. **Precondition:** D1 (external AI HTTP/SSE API over the gateway) GA, and prod-secret rotation done. **Pattern:** ai-task capabilities stop using their own clients (`llmResponder.js`, `summarizer.js`) and instead call the backend external AI API → `invoke()`. Cross-repo, so each phase is a coordinated backend+ai-task release.

| Phase | Scope | Depends | Risk | Rollback | Exit |
|---|---|---|---|---|---|
| **Q1** | Re-path the **events narrative** flows (`events/executive/executiveSummary.service.js`, `events/llm/llmExplanation.service.js`) off `generateNarrative`→ai-service and onto the gateway (as capabilities `executive_summary_events`, `user_monthly_narrative`) | D1 | M | flag → legacy `generateNarrative` | events narratives run through gateway; the `events/llm/llmClient.js` bypass is dead |
| **Q2** | Migrate **away_responder + summarization + explain_endpoint** (read-only/assistive) to the external API | D1 | M | ai-task flag → own client | ai-task read paths through gateway |
| **Q3** | Migrate **ai_task_creation + report_generation** (side-effecting: create tasks / reports) with idempotency + dry-run/shadow | D1, §13 idempotency | H | per-flow flag | ai-task write paths through gateway, no double-create |
| **Q4** | Migrate **decision_intelligence + conversation_memory** onto the platform **Memory/Retrieval ports** (D3); retire `llmResponder.js` + `summarizer.js` | D3 | H | ai-task flag | ai-task fully on-platform; own clients deletable |

**Per-capability fields** follow the standard template (§4/V1 §3.3), with the added **cross-repo release-coordination** and **shadow-first** requirement for Q3/Q4 (generate-but-don't-commit until parity proven).

---

## 6. Epic C — Governance + AI Studio: unchanged
G1 (governance matrix, permissive) → G2–G4 (Studio: providers/models/observability → prompt library → capabilities/routing/policies/budgets/keys) → G5 (enforcement). Studio UX guardrails unchanged. **Note:** the Studio capability list now reflects the corrected register (§1.3).

## 7. Epic D — Advanced modality/agentic: unchanged
D1 (streaming + external AI API) — **now also the gate for all of Epic B′**. D2 (tools), D3 (memory + retrieval — now also gates B′ Q4), D4 (orchestration). Carried forward from V1.

## 8. Epic E — Enforcement + legacy removal (scope expanded)

| Phase | Objective | V2 change |
|---|---|---|
| **E1** | Cost budgets enforced (fail-closed) | unchanged |
| **E2** | Safety enforced | unchanged |
| **E3** | **Retire ALL non-gateway clients & bypasses:** `events/llm/llmClient.js#generateNarrative` (re-pathed in B′-Q1), ai-task `llmResponder.js` + `summarizer.js` (retired in B′-Q4), **delete stale `Desktop/task_m/ai-service`** | **expanded** (was "the duplicate client") |
| **E4** | Remove legacy provider code in `services/llm.js`; collapse `intelligence/llm/llmClient.js` re-export; delete v1 shim | +collapse the re-export |
| **E5** | `AI_PLATFORM_REQUIRED=on` (fail-closed master) | unchanged |

**Definition of done (V2):** every entry point in §1.2 flows through `invoke()`; all clients in §1.1 except `services/llm.js` are deleted; both bypass paths are gone; enforced modes on.

---

## 9. Rollout strategy (V2 additions)
Environment ladder, flag taxonomy, shadow mode, and emergency rollback unchanged from V1. **Added:** Epic B′ requires **cross-repo release coordination** — the backend external AI API (D1) must be GA and version-compatible before any ai-task capability cuts over; each B′ phase is a paired backend+ai-task deploy with an independent ai-task rollback flag. Prod-secret rotation is a **hard predecessor** to P8 and Epic B′.

## 10. Regression / testing / readiness: unchanged
Six regression guarantees, 14-type testing taxonomy, and the per-phase production-readiness checklist carry forward verbatim from V1. **Only quantitative change:** prompt-regression scope grows (~40 backend prompt sites + ai-task), so the golden-corpus authoring budget is re-baselined ~2×.

---

## 11. MASTER PROGRAM V2 — phase ledger

| ID | Phase | Epic | Complexity | Duration (2–3 eng) | Depends | Priority |
|---|---|---|---|---|---|---|
| P0–P8 | Core platform | A | M–L each | ~10–14 wk total | sequential from P0 | critical |
| W1 | forecast · exec_summary · **enterprise_intelligence** | B | M | 2–3 wk | P3,P4,P5 | high |
| W2 | meeting_intelligence(+subs) · huddle_copilot | B | L | 2–4 wk | W1,P7 | high |
| W3 | workspace_assistant · ai_features | B | L | 2–4 wk | W2,P7,D3 | medium |
| W4 | autopilot_standup · nl_task_creation | B | L | 2–3 wk | W1,§13 | medium |
| W5 | testing_agent · smart_browser_test · **browser_agent** | B | XL | **4–6 wk** (was 3–5; +browser_agent 15 calls) | D2,D4 | medium |
| **Q1** | events narratives → gateway | **B′** | M | 1–2 wk | D1 | medium |
| **Q2** | away_responder · summarization · explain | **B′** | L | 2–3 wk | D1 | medium |
| **Q3** | ai_task_creation · report_generation | **B′** | L | 2–4 wk | D1,§13 | medium |
| **Q4** | decision_intelligence · conversation_memory | **B′** | XL | 3–5 wk | D3 | medium |
| G1–G5 | Governance + Studio | C | L | 5–7 wk | P4 | medium |
| D1–D4 | Advanced (streaming/tools/memory/orchestration) | D | L–XL | 9–14 wk | P3 | medium |
| E1–E5 | Enforcement + cleanup | E | M–L | 3–5 wk | dependents done | terminal |

### Critical path (V2)
`P0→P1→P2→P3→P4→P7→W1→W2` (fastest to flagship on-platform) → then two converging strands: **agentic** `D2→D4→W5` and **ai-task** `D1→B′(Q1→Q4)` → `E1..E5`. **P2, P3, and now D1** are the highest-leverage phases (D1 gates all of Epic B′).

### Parallelism (V2)
After P3: Epic D and Epic C start in parallel with W1. **D1 should be pulled early** (it unblocks Epic B′, the largest new scope). After P4: Governance/Studio parallel to B. Within W5, `browser_agent` parallelizes with `testing_agent`.

### Milestones (V2)
- **M1 Platform live, invisible** (P0–P4).
- **M2 Flagship on-platform** (W1–W2).
- **M3 Governed** (Epic C).
- **M4 Agentic + external API** (Epic D; unblocks W5 & B′).
- **M5 ai-task on-platform** (Epic B′ complete) — *the corrected "no scattered AI" milestone*.
- **M6 Enforced & clean** (Epic E; all clients in §1.1 deleted except `services/llm.js`).

---

## 12. Program risks (V2)
Carried from V1 (**bus factor = 1** top risk → staff a 2nd engineer before P2; no pre-existing CI → P0 mandatory; LLM nondeterminism → semantic parity; provider churn → model aliases). **Added:** cross-repo coordination risk for Epic B′ (mitigated by D1-first + paired deploys + independent ai-task rollback); larger-than-planned agentic surface (`browser_agent` 15 calls) in W5; prod-secret rotation is now a hard predecessor to P8 and B′.

---

## 13. Scope statement
No production code, migrations, APIs, UI, Contract-v2 changes, architecture changes, or new concepts were introduced. This document only reconciles the execution plan with the audited repositories. It is the definitive execution document; V1 is superseded.

---

The planning phase is complete.

The platform is ready for implementation.

The next task is P0 implementation.
