# Asystence AI Platform — Implementation Readiness Audit (Repository Reconciliation)

**Purpose:** Verify that the real repositories match the assumptions in Contract v2 and the Master Implementation Program **before** implementation begins. Read-only. No code changed, no plan/contract redesigned.
**Method:** Evidence from grep/inspection of `Task-management-be`, `ai-service` (Desktop copy), and the canonical AI repo the user identified: `C:\Users\Sukhjinder Singh\Documents\GitHub\ai-task`.
**Date:** 2026-07-04

> **Headline:** The plan is **directionally correct but materially under-scoped**. The repository contains **four to five distinct LLM clients (not two)**, **two undocumented text paths that bypass `services/llm.js`**, **unregistered high-volume AI callers**, and — most importantly — the **canonical AI microservice is `Documents/GitHub/ai-task`, a real agentic service**, not the 764-line stub at `Desktop/task_m/ai-service` that earlier phases assessed. Three findings are **✗ Blocking**; the plan must be updated before Phase 2.

---

## 0. Reconciliation summary (what changed vs the plan)

| Assumption in the Program | Reality in the repo | Verdict |
|---|---|---|
| All text AI flows through `services/llm.js#generateText` | **Also** `events/llm/llmClient.js#generateNarrative → AI_SERVICE_URL`, plus the ai-service's own client(s) | ✗ Blocking |
| The ai-service is a ~764-line stub (away-responder) | That is a **stale copy** (`Desktop/task_m/ai-service`); the **canonical `Documents/GitHub/ai-task`** is a real agentic service (task creation, decision extraction, memory) | ✗ Blocking |
| ~19 registered capabilities cover the AI surface | `browser_agent` (15 calls) and `enterprise_intelligence` (4 calls) are **unregistered**; several ai-task agents are absent from the registry | ⚠ Needs adjustment |
| Registered capabilities map to real code | `dashboard_summary`, `task_suggestions`, `risk_analysis` have **no backing LLM code** in the backend | ⚠ Needs adjustment |
| One executive-summary implementation | **Two** (`intelligence/executiveSummary.generator.js` via `generateText`; `events/executive/executiveSummary.service.js` via `generateNarrative→ai-service`) with **different backends** | ⚠ Needs adjustment |
| Huddle caps call `generateText` directly | They call it via a **`generate = generateText` injection seam** (good — easier migration) | ✓ Ready (better than assumed) |
| Only `generateText`/STT touch providers directly | Confirmed for backend text (no rogue provider calls); STT is a **separate audio surface** | ✓ / note |

---

## 1. Capability Inventory (actual)

### 1A. Backend capabilities via `services/llm.js#generateText` (the migratable core)
| Capability | File(s) | Call sites | Registered? | Plan wave | Readiness |
|---|---|---|---|---|---|
| workspace_assistant | `ai/ai.intelligence.service.js` | 1 | ✓ | W3 | ✓ Ready |
| autopilot_standup | `autopilot/autopilot.engine.js` | 1 | ✓ | W4 | ✓ Ready |
| executive_summary (intelligence) | `intelligence/executiveSummary.generator.js` | 2 | ✓ | W1 | ⚠ (duplicate — see 1C) |
| forecast_reasoning | `intelligence/forecast/forecast.reasoning.js` | 1 | ✓ | W1 | ✓ Ready |
| **enterprise_intelligence** | `intelligence/enterpriseIntelligence.service.js` | **4** (json) | **✗ not registered** | — | ⚠ Needs adjustment |
| ai_features | `services/aiFeatures.service.js`, `routes/aiFeatures.routes.js` | 2 | ✓ | W3 | ✓ Ready |
| **browser_agent** | `services/browserAgent.service.js` | **15** | **✗ not registered** | — | ⚠ Needs adjustment |
| huddle_copilot | `services/huddleCopilot.service.js` | 1 | ✓ | W2 | ✓ Ready |
| nl_task_creation | `services/nlTaskCreation.service.js` | 2 | ✓ | W4 | ✓ Ready |
| smart_browser_test | `services/smartBrowserTest.service.js` | 2 | ✓ | W5 | ✓ Ready |
| testing_agent | `services/testingAgent.service.js` | 7 | ✓ | W5 | ✓ Ready |
| meeting_intelligence | `services/huddleIntelligenceGeneration.service.js` | via `generate=` inject | ✓ | W2 | ✓ Ready (injection seam) |
| huddle_topic_segmentation | `services/huddleTopicSegmentation.service.js` | via inject | ✓ | W2 | ✓ Ready |
| huddle_risk_blocker_extraction | `services/huddleRiskBlockerExtraction.service.js` | via inject | ✓ | W2 | ✓ Ready |
| huddle_language_normalization | `services/huddleLanguageNormalization.service.js` | via inject | ✓ | W2 | ✓ Ready |

**Backend generateText total: ~40 call sites across ~16 files.**

### 1B. Backend capabilities via `events/llm/llmClient.js#generateNarrative` (→ ai-service HTTP)
| Capability | File | Path | Registered? | Readiness |
|---|---|---|---|---|
| executive_summary (events) | `events/executive/executiveSummary.service.js` | `generateNarrative → AI_SERVICE_URL` | ✗ | ✗ Blocking (bypasses gateway) |
| llm_explanation / monthly user narrative | `events/llm/llmExplanation.service.js` | `generateNarrative → AI_SERVICE_URL` | partially (`llm_explanation` registered but mismapped to `generateText`) | ✗ Blocking |

### 1C. ai-service (canonical `Documents/GitHub/ai-task`) capabilities — **absent from the plan**
Real agents/flows (own LLM clients `src/services/llmResponder.js` + `src/autoReply/summarizer.js`):
- **Away-responder** (`agents/responder.js`, `autoReply/dmAutoReply.js`)
- **AI task creation** (`agents/createTaskFromAI.js`, `buildTaskDescription.js`, `taskExecutor.js`, `taskIntentDetector.js`, `resolveTaskAssignee.js`, `taskConfirmationHandler.js`)
- **Report generation** (`agents/reportIntentDetector.js`, `intentRouter.js`)
- **Decision intelligence** (`cognition/decisionExtractor.js`, `authorityEvaluator.js`, `provenanceBuilder.js`)
- **Summarization** (`autoReply/summarizer.js`)
- **Memory** (`memory/conversationStore.js`, `decisionLedger.js`, `longTerm.js`, `shortTerm.js`) — real, not the empty stubs in the Desktop copy
- **Entry points:** `/internal/chat-event`, `/internal/clear-dm-context`, `/explain/:messageId`

**Verdict:** the plan's single `chat_away_responder` (W6) understates the ai-task surface by ~10 capabilities. ✗ Blocking for scope.

### 1D. Registered-but-unbacked (speculative) capabilities
`dashboard_summary`, `task_suggestions`, `risk_analysis` — **no `generateText`/`generateNarrative` backing found** in the backend. ⚠ Remove or re-map (risk narrative likely lives inside `enterprise_intelligence`).

### 1E. Separate AI surface (out of text-LLM scope)
- **STT / transcription:** `services/huddleSttProvider.service.js` (Deepgram `nova-3` default, OpenAI/Groq/AssemblyAI). Audio modality — Contract v2 supports it, but it bypasses the gateway today. ⚠ Note as future audio-capability, not in current waves.

---

## 2. Prompt Inventory
- **Backend:** prompts are **inline** in each capability file (template strings / `buildPrompt`, `systemMessage`). No shared prompt store today (as Contract v2/§7 anticipates). Distinct prompt-bearing files ≈ the 16 in §1A + the 2 in §1B. `browserAgent` and `testingAgent` alone hold ~22 of the ~40 prompt sites.
- **ai-task:** structured prompt-ish builders exist (`agents/*`, `autoReply/summarizer.js`, `cognition/*`) — more numerous than the backend assumed.
- **Readiness:** ⚠ Prompt migration effort is **larger than planned** (the Program's "move the inline prompt to the registry" step must be multiplied by ~40 backend sites + ai-task). No blocking issue, but re-estimate.

## 3. Provider Inventory
| Provider client | Location | Providers | Notes |
|---|---|---|---|
| `services/llm.js` | backend | ollama/openai/grok/groq/huggingface | The unified client Phase 1 wraps ✓ |
| `intelligence/llm/llmClient.js` | backend | re-export of `services/llm.js` | Benign alias ✓ |
| `events/llm/llmClient.js` | backend | **HTTP → ai-service** (`generateNarrative`) | **Bypass** ✗ |
| `Desktop/task_m/ai-service/.../llm.service.js` | stale copy | groq/ollama | Duplicate #1 (stub) |
| `Documents/GitHub/ai-task/src/services/llmResponder.js` | **canonical ai-service** | groq/openai/local | Duplicate #2 (real) |
| `Documents/GitHub/ai-task/src/autoReply/summarizer.js` | ai-service | direct OLLAMA | Duplicate #3 (inline) |
| `services/huddleSttProvider.service.js` | backend | Deepgram/OpenAI/Groq/AssemblyAI | STT (audio) — separate |

**Finding:** **4–5 text-LLM clients**, not 2. The plan's Epic E ("delete the duplicate LLM client") must target all of them. ✗ Blocking assumption correction.

## 4. AI Entry-Point Inventory
- **HTTP routes (backend):** `/ai/*` (`ai/ai.routes.js`), `/ai-features` (`routes/aiFeatures.routes.js`), `/huddle/intelligence/*`, `/autopilot/*`, `/testing-agent/*`, `/adaptive/*`.
- **Crons:** `huddleIntelligence.cron`, `monthlyIntelligence.cron`, `autopilot.cron`, `reviews.cron` (all can trigger LLM).
- **Workers:** `adaptive/runtime/adaptiveWorker.service.js`, `services/huddleIntelligenceWorker.service.js`.
- **Event-driven:** `events/observers/aiObserver.js`, monthly scoring/executive jobs → `generateNarrative`; `realtime/ai.socket.js`.
- **ai-service:** `/internal/chat-event` (webhook from `services/chat.service.js`), `/explain/:messageId`, `/internal/clear-dm-context`; internal `eventBus.on("chat:new-message")`.
- **Readiness:** ⚠ The Program's entry-point list omitted `/explain`, the monthly-narrative jobs, and the ai-task task-creation flow.

## 5. Migration Inventory (order impact)
- W1–W2 (intelligence + huddle) — ✓ largely accurate; huddle injection seam makes them **easier** than planned.
- W3–W4 — ✓ but add `enterprise_intelligence` (new) and re-map the **events-path** executive/narrative flows (they go to ai-service, so they migrate with W6, not W1).
- W5 — add **`browser_agent`** (15 calls) alongside testing/smart-browser; it's the largest single agentic surface.
- W6 — **massively under-scoped**: it must cover the real ai-task (task creation, decision extraction, summarizer, memory), not a stub.
- **Readiness:** ⚠ Re-sequence and re-size (details in §10 recommendations).

## 6. Duplicate AI Inventory
1. **ai-service duplicated on disk:** `Desktop/task_m/ai-service` (stub) vs `Documents/GitHub/ai-task` (canonical, `.git`). ✗ Blocking — earlier assessments used the stub.
2. **Two executive-summary implementations** with different backends (§1A vs §1B). ⚠
3. **4–5 LLM clients** (§3). ✗
4. `intelligence/llm/llmClient.js` re-export — benign. ✓

## 7. Missing Capability Inventory (registered/planned but absent in code)
- `dashboard_summary` — no backing. ⚠
- `task_suggestions` — no backing. ⚠
- `risk_analysis` — no dedicated backing (likely inside `enterprise_intelligence`). ⚠
**Action:** remove from the registry or bind to real code before their waves.

## 8. Unexpected AI Inventory (in code, absent from plan)
- `enterprise_intelligence` (4 LLM calls, json). ✗ register
- `browser_agent` (15 LLM calls). ✗ register
- `events/*` monthly narrative + executive summary via **ai-service HTTP**. ✗ register + re-path
- ai-task agentic suite (task creation, decision extraction, provenance, summarizer, memory, `/explain`). ✗ register
- STT/transcription (audio). ⚠ note

## 9. Risk Inventory
| Risk | Severity | Evidence |
|---|---|---|
| "No scattered AI" unachievable as scoped — 4–5 clients + 2 bypass paths | **High** | §3, §1B |
| Plan built partly on the **wrong ai-service copy** | **High** | §6.1 |
| Unregistered high-volume callers (`browser_agent` 15, `enterprise_intelligence` 4) migrate blind | **High** | §1A |
| Cross-repo coordination (backend ↔ ai-task ↔ events path) undersized in W6 | **High** | §1C |
| Speculative capabilities create false "done" signals | Medium | §7 |
| STT audio surface unowned by the platform | Medium | §1E |
| Prod secrets still unrotated (BYO-key/P8 dependency) | Medium | prior DD |
| Bus factor = 1 across all repos | High | prior DD |

---

## 10. IMPLEMENTATION READINESS REPORT

### Overall: ⚠ **NOT READY to start Phase 2 as written — 3 Blocking items must first update the plan (not the code, not the contract).**

| Area | Status | Required plan update (do NOT code) |
|---|---|---|
| Backend `generateText` core (W1–W5 caps) | ✓ Ready | Proceed; add the two unregistered caps below |
| `enterprise_intelligence` (4 calls) | ✗ Blocking | Register as a capability; assign to W1/W3; author its golden corpus |
| `browser_agent` (15 calls) | ✗ Blocking | Register; fold into the agentic wave (W5) with `testing_agent`/`smart_browser_test`; it needs Tool/orchestration ports (D2/D4) |
| Events path (`generateNarrative → ai-service`) | ✗ Blocking | Re-map `llm_explanation` + `events/executive` off `generateText`; they migrate with the **ai-service** wave, not W1 |
| Canonical ai-service = `Documents/GitHub/ai-task` | ✗ Blocking | Repoint all ai-service references from `Desktop/task_m/ai-service` to `ai-task`; re-inventory its ~10 agentic capabilities; expand W6 from 1 → ~10 capabilities across a new **Epic B′ (ai-service migration)** |
| Provider/duplicate-client count (4–5) | ✗ Blocking | Epic E cleanup must enumerate all clients: `services/llm.js` (keep), `events/llm/llmClient.js`, ai-task `llmResponder.js` + `summarizer.js`, Desktop stub |
| Speculative caps (`dashboard_summary`, `task_suggestions`, `risk_analysis`) | ⚠ Adjust | Remove from registry or bind to code before their waves; don't count them as "migrated" |
| Duplicate executive summary | ⚠ Adjust | Decide canonical implementation; migrate one, deprecate the other |
| Huddle injection seam (`generate=`) | ✓ Ready (better) | Exploit it: inject the gateway in tests for clean shadow-parity |
| STT / transcription (audio) | ⚠ Adjust | Add a future audio-capability track (Contract-v2 audio parts); out of current text waves |
| Provider bypass scan (backend text) | ✓ Ready | Confirmed clean apart from the two known paths |
| Prod secrets rotation | ⚠ Adjust | Sequence rotation before P8 (BYO-key) — unchanged from DD |

### Recommended plan amendments (surgical, no contract change)
1. **Add Epic B′ — ai-service (ai-task) migration** as a first-class workstream (not a one-line W6): inventory its ~10 capabilities, route them through the backend's external AI API (D1), and retire `llmResponder.js` + `summarizer.js`.
2. **Register the two backend orphans** (`enterprise_intelligence`, `browser_agent`) and drop the three speculative capabilities.
3. **Split the "executive/narrative" flows** by backend: `intelligence/executiveSummary.generator.js` (generateText) → W1; `events/executive` + `events/llm/llmExplanation` (ai-service) → Epic B′.
4. **Correct Epic E** to enumerate 4–5 clients and 2 bypass paths.
5. **Add an audio track** for STT under Contract-v2 audio parts (future).
6. **Re-baseline the prompt-migration estimate** (~40 backend sites + ai-task), which roughly doubles W1–W5 prompt effort.

### What is genuinely ✓ Ready to build first (unchanged)
`P0 (CI/harness) → P1 (contract types) → P2 (provider port) → P3 (invoke + shim) → P4 (registry v2)` are all validated against the repo and safe to start. The huddle injection seam even makes the first real capability migration cleaner than assumed.

---

## 11. Statement of scope
This is a read-only audit. No production code, migration, API, UI, Contract v2, or Master Program file was modified. The above are **recommended amendments to the Master Implementation Program**, to be applied before Phase 2 is authorized. Earlier acquisition/commercial assessments that characterized the ai-service as a "764-line stub" should be footnoted: that described `Desktop/task_m/ai-service`; the canonical, materially larger service is `Documents/GitHub/ai-task`.
