# Asystence AI Platform — Architecture Specification & Phase 1 Implementation

**Author role:** Chief AI Platform Architect.
**Status:** Architecture ratified · **Phase 1 (Gateway foundation) implemented, compiles, smoke-tested, feature-flagged OFF by default.**
**Non-negotiable invariant honored:** no behavior changes until explicitly enabled; instant rollback via one flag.
**Date:** 2026-07-04

> This document is the permanent specification. It is deliberately honest about what is **built now** (Phase 1) versus what is **specified for later phases**. Nothing here claims the full migration is complete — it is not, and a "big bang" was explicitly forbidden. Phase 1 lays the load-bearing foundation every later phase snaps onto.

---

## 0. Problem statement (from Phases 1–3)

Today AI is **scattered**: `services/llm.js` (5 providers), a re-export `intelligence/llm/llmClient.js`, ~20 call sites building inline prompts, and a **separate `ai-service`** with its *own* duplicate LLM client. Providers, models, prompts, and parameters are hard-coded or env-coupled; there is no per-workspace routing, no governance, no cost/telemetry, no prompt versioning. This spec replaces that with **one centralized AI Platform** that is *infrastructure*, alongside Auth, Workspaces, Notifications, Analytics, Billing.

---

## 1. Complete AI Platform Architecture Specification

### 1.1 Principles (enforced by design)
1. **Single choke point.** No module talks to any provider directly; everything flows through the **AI Gateway** (`ai-platform/gateway.js`). Providers are reachable *only* through adapters.
2. **AI is infrastructure, not a feature.** The platform is a backend subsystem (`ai-platform/`) with its own schema, registries, and governance.
3. **No hidden AI.** Every capability is **registered** (`ai-platform/capabilities/registry.js` + `ai_capabilities`). Unregistered AI is a defect.
4. **Configuration replaces code.** Provider, model, prompt, temperature, tokens, policy, routing, fallback are **data** (DB rows), never code edits.
5. **Backward compatibility is mandatory.** Migration is incremental, feature-flagged, reversible, regression-tested before any legacy path is removed.

### 1.2 The request pipeline (implemented in `gateway.js#runCapability`)
```
caller
  └─▶ AI GATEWAY
        1. Capability resolution      (registry + ai_capabilities)
        2. Policy resolution          (ai_policies: allow/block, compliance)
        3. Workspace resolution       (ai_workspace_overrides + locking)
        4. Provider resolution        (ai_providers → adapter type)
        5. Model resolution           (capability/workspace/env)
        6. Prompt resolution          (workspace → platform published → code → caller-verbatim)
        7. Runtime profile            (ai_runtime_profiles + per-call overrides)
        8. Budget check               (ai_budgets hard limits)
        9. Execution                  (provider adapter + transient retry)
       10. Logging                    (ai_request_logs)
       11. Response                   ({ text, meta })
```
Nothing bypasses this once a caller adopts `runCapability()`. During migration, `services/llm.js#generateText` delegates to the gateway when the flag is on; otherwise the legacy path runs untouched.

### 1.3 Module map (Phase 1, all under `ai-platform/`)
| Concern | File | Role |
|---|---|---|
| Feature flag | `config/featureFlag.js` | Global + per-workspace canary switch; default OFF |
| Gateway | `gateway.js` | `runCapability()` + `gatewayGenerateText()` (legacy-shaped) |
| Config resolver | `config/resolver.js` | Inheritance + **locking**; schema-absent safe fallback |
| Prompt resolver | `prompts/promptResolver.js` | workspace→platform→code→verbatim fallback + `{{var}}` render |
| Runtime profiles | `runtime/runtimeProfiles.js` | 7 named profiles; `balanced` == legacy defaults |
| Capability registry | `capabilities/registry.js` | Code source-of-truth for all AI features |
| Policy engine | `policy/policyEngine.js` | Provider allow/block + hard budgets (fail-open when unconfigured) |
| Telemetry | `telemetry/requestLog.js` | Best-effort per-request logging (never throws) |
| Provider adapters | `providers/*.adapter.js` | OpenAI-compatible, Ollama, Anthropic, Gemini, HuggingFace, Bedrock(stub) |
| Adapter registry | `providers/registry.js` | adapterType→instance; providerKey→adapterType |
| Retry | `shared/retry.js` | Transient backoff ported verbatim from legacy |

---

## 2. Database schema

Delivered: `migrations/20260704_ai_platform_foundation.sql` (additive, idempotent, `IF NOT EXISTS`, seeds 7 system profiles). Tables:

- **`ai_providers`** — key, adapter, base_url, `api_key_env` (name only, never the secret), default_model, timeout, `lock_level`, `config_json`.
- **`ai_models`** — provider+model, context window, input/output cost per 1k, lock.
- **`ai_runtime_profiles`** — named param bundles (`params_json`), system vs custom, lock.
- **`ai_prompts`** + **`ai_prompt_versions`** — first-class prompts with version history and `status ∈ {draft,testing,published,archived}`, `approved_by`, `published_at`.
- **`ai_capabilities`** — feature registry with default provider/model/profile/prompt + lock.
- **`ai_workspace_overrides`** — the inheritance leaf: `(workspace_id, object_type, object_key) → value_json`, with `lock_level` (supports **workspace_locked**).
- **`ai_policies`**, **`ai_budgets`** — governance & spend controls (global/workspace scope).
- **`ai_request_logs`** — full-fidelity observability (provider, model, prompt version, profile, latency, tokens, cost, status, failure, retries, correlation_id).
- **`ai_audit_logs`** — every config change/approval (actor, action, before/after JSON).

Rollback SQL is embedded at the bottom of the migration.

## 3. Backend architecture
A self-contained `ai-platform/` subsystem with a strict dependency DAG (`llm.js → gateway → {resolver, promptResolver, profiles, policy, telemetry, providers}`; none import back into `llm.js`, so no cycles — verified). DB access is centralized in resolver/promptResolver/policy/telemetry and is **defensive**: every query is wrapped so a missing table or DB blip degrades to env/registry defaults rather than failing the AI call.

## 4. Frontend architecture (AI Studio) — *specified, Phase 4*
A new **AI Studio** flagship module in `Task-management/src/pages/AIStudio*` mirroring the existing Superadmin console patterns (see `SuperadminSettings.jsx`, `superadminApi.js`) and the current design language (Tailwind + lucide-react + the existing component kit) — **no redesign**. Pages: Providers, Models, Prompt Library (with diff/preview/test/approve), Runtime Profiles, Capabilities & Routing, Policies & Budgets, Observability, Audit. Every control ships with contextual help ("what this does / when to use / recommended / warnings / cost / tradeoffs") and validation that prevents dangerous configs (e.g., routing to a provider with no key, or removing the only fallback).

## 5. API contracts — *superadmin/workspace, Phase 3*
Mounts follow the existing convention in `index.js`:
- `‎/superadmin/ai-platform/*` (Superadmin-only, before global auth): providers, models, prompts, versions, publish/rollback, profiles, capabilities, routing, policies, budgets, logs, audit.
- `‎/ai-platform/workspace/*` (authMiddleware + requireWorkspaceForUser + admin): read effective config; write **only** overrides the platform marks `workspace_customizable`.
Contract shape (representative):
```
GET  /superadmin/ai-platform/capabilities            → [{key,name,category,defaults,lock_level,enabled}]
PUT  /superadmin/ai-platform/capabilities/:key       → { provider, model, profile, prompt_key, lock_level }
POST /superadmin/ai-platform/prompts/:key/versions   → { body, notes } (draft)
POST /superadmin/ai-platform/prompts/:key/publish    → { version }         (approval workflow)
PUT  /ai-platform/workspace/:wsId/routing/:capKey     → { provider?, model?, profile?, prompt_key? }  (403 if global_locked)
GET  /superadmin/ai-platform/logs?workspace=&cap=     → paginated telemetry
```

## 6. SDK design (internal)
Callers use one function:
```js
import { runCapability } from "../ai-platform/gateway.js";
const { text, meta } = await runCapability({
  capability: "meeting_intelligence",
  workspaceId,
  variables: { transcript },   // renders the platform-managed prompt
  overrides: { json: true },   // optional; per-call wins
  signal,
});
```
Legacy callers keep calling `generateText(...)` from `services/llm.js` unchanged; they are migrated capability-by-capability in Phase 2.

## 7. Provider adapter design
One contract (`providers/base.adapter.js`): `generate({model,prompt,messages,options,providerConfig,signal}) → {text,usage,raw}`. Secrets are read **only** inside adapters via `resolveApiKey()` (env-name indirection) and are never returned or logged. Every OpenAI-Chat-compatible provider (OpenAI, Groq, Grok, OpenRouter, Together, DeepSeek, Azure) is **one** adapter parameterized by data — adding such a provider is a DB row, zero code. New protocols (Anthropic, Gemini, HuggingFace) each have a small dedicated adapter. Bedrock is registered but fails loudly pending SigV4 (Phase 2).

## 8. Prompt registry
Prompts are first-class (`ai_prompts`/`ai_prompt_versions`): unique key, category, feature, declared variables, owner, version history, draft/testing/published/archived, approval + rollback, audit. Resolution order (implemented): **workspace override → platform published version → code fallback → caller-verbatim**, with `{{variable}}` rendering. The verbatim fallback is what preserves every current call site that already builds its own prompt.

## 9. Runtime profile system
7 system profiles seeded (`balanced, creative, analytical, deterministic, fast, low_cost, high_quality`). Admins pick an intent, not 10 knobs; Advanced mode exposes raw params via `params_json`. Precedence (implemented): **per-call override > workspace profile > capability profile > balanced**. `balanced` is defined to equal the legacy defaults, guaranteeing no drift.

## 10. Policy engine
Central enforcement (`policy/policyEngine.js`): approved/blocked providers, allowed models, daily/monthly budgets, workspace limits, compliance rules. **Fail-open when unconfigured** (no rows ⇒ no new denials ⇒ no regression); tightens purely by Superadmin configuration. Selected policies can be made fail-closed in a later phase.

## 11. Workspace inheritance
`ai_workspace_overrides` is the leaf. The resolver walks: workspace override → platform default (`ai_capabilities`/`ai_providers`) → code registry → env. Applies to providers, models, prompts, profiles, capability routing, and policies.

## 12. Locking model
Every configurable object carries `lock_level`:
- **global_locked** — platform wins; workspace override ignored (`pickWithLock` returns platform value).
- **workspace_customizable** — workspace override wins if present.
- **workspace_locked** — a specific workspace pinned by the platform (override row with that lock).
Implemented in `config/resolver.js#pickWithLock` and enforced per field (provider/model/profile/prompt).

## 13. AI Studio UX — *Phase 4* (see §4). Principles: zero-AI-knowledge admin, contextual help everywhere, guardrails, existing design language, no visual regressions, onboarding + validation.

## 14. Migration strategy (incremental, reversible)
- **Phase 1 (DONE):** foundation + gateway + adapters + schema + feature flag (OFF). Behavior identical to today.
- **Phase 2:** enable flag on a **canary workspace** (`AI_PLATFORM_ENABLED_WORKSPACES`); migrate call sites one capability at a time to `runCapability({capability,...})`; validate output parity per capability before moving on.
- **Phase 3:** Superadmin/workspace governance APIs.
- **Phase 4:** AI Studio UI.
- **Phase 5:** route `ai-service` (away-responder) and remaining inline prompts through the gateway; move prompts into the registry.
- **Phase 6:** after regression sign-off, delete the legacy provider code in `llm.js` and the duplicate client in `ai-service`.

## 15. Rollback strategy
- **Instant, global:** `AI_PLATFORM_ENABLED=false` → legacy path, byte-for-byte.
- **Per-workspace:** remove the workspace from the canary list.
- **Schema:** the migration's embedded `DROP` block; with the flag off, dropping the tables is inert.
- **Code:** Phase 1 adds *new* files and a thin dispatcher in `llm.js`; reverting is a clean removal because the legacy functions were preserved (`legacyGenerateText`).

## 16. Regression strategy
- Flag-off is the primary guarantee (no code path change).
- Flag-on parity: for each migrated capability, compare gateway output vs legacy on a fixed prompt corpus before cutover.
- Smoke test (already run): `balanced` == legacy defaults; per-call overrides win; flag defaults off; adapter/capability wiring resolves. All passed.
- Schema-absent test: resolver returns env defaults when tables are missing (built into `hasAiPlatformSchema` fast-path).

## 17. Test strategy
- **Unit:** runtime-profile precedence, `pickWithLock` matrix, prompt fallback order, adapter request shaping (mock axios).
- **Contract:** each adapter against a recorded provider fixture.
- **Integration:** gateway end-to-end with a mock adapter + a test DB (extends the existing `node --test` suite in `tests/`).
- **Regression:** capability parity harness (Phase 2). Adopt these into a CI gate (currently absent — see Phase-2 gap in the DD reports).

## 18. Security review
- **Secrets:** only env-var *names* are stored (`api_key_env`); values are read solely inside adapters and never logged/returned. Aligns with the "no secrets in code/DB" requirement and directly mitigates the plaintext-secrets finding from the Phase 2 DD.
- **RBAC:** Superadmin owns the platform (mounted before global auth like existing superadmin routes); workspace admins may edit only `workspace_customizable` objects; `global_locked` is 403 at the API and ignored at the resolver (defense in depth).
- **Isolation:** all config/telemetry keyed by `workspace_id`; RLS-eligible (tables are additive to the existing RLS regime).
- **Audit:** every change and approval recorded in `ai_audit_logs`.
- **Rotation:** because providers reference env-var names, key rotation is an env change with no DB/code edit.

## 19. Performance review
- Resolution adds a handful of indexed, cached lookups; `hasAiPlatformSchema()` is memoized; telemetry is best-effort and off the critical failure path.
- Retry/backoff preserved from legacy.
- Provider latency dominates; the gateway overhead is negligible relative to a model round-trip. (A resolution cache per (capability,workspace) with short TTL is specified for Phase 3 if profiling warrants.)

## 20. Implementation roadmap
| Phase | Scope | State |
|---|---|---|
| 1 | Gateway, adapters, registries, schema, flag | **DONE (this deliverable)** |
| 2 | Canary + capability-by-capability cutover + parity harness | Next |
| 3 | Superadmin/workspace governance APIs | Planned |
| 4 | AI Studio UI | Planned |
| 5 | Route `ai-service` + inline prompts through gateway; prompts→registry | Planned |
| 6 | Remove legacy provider code after sign-off | Planned |

---

## Appendix A — Phase 1 acceptance evidence
- `node --check` passes on all 18 new modules + modified `services/llm.js` + `run-ai-platform-migration.js`.
- DB-free smoke test passes: `balanced` profile = `{temperature:0.4, maxTokens:900, topP:0.9, topK:20}` (= legacy); `{maxTokens:350,temperature:0.7}` per-call override wins; `isAiPlatformEnabled()===false` by default; `groq→openai_compatible`, `claude→anthropic`; 19 capabilities registered.
- Feature flag **OFF** by default ⇒ zero behavioral change in production until deliberately enabled.

## Appendix B — How to enable (operator runbook)
1. `npm run migrate:ai-platform` (creates tables, seeds 7 profiles, 12 providers, 19 capabilities; idempotent).
2. Canary: set `AI_PLATFORM_ENABLED_WORKSPACES=<workspaceId>` (or `AI_PLATFORM_ENABLED=true` for all).
3. Observe `ai_request_logs`; compare against expectations.
4. Rollback anytime: unset the flag. Drop tables only if fully abandoning.

## Appendix C — Success criteria status
| Criterion | Status |
|---|---|
| Centralized gateway exists; nothing needs to bypass it | ✅ built (`gateway.js`) |
| Providers fully abstracted behind adapters | ✅ built (6 adapter types, secrets in-adapter) |
| Multi-provider routing (per workspace/capability) | ✅ engine built; ⏳ needs governance UI/APIs to operate (Phase 3–4) |
| Workspace overrides + locking + inheritance | ✅ engine built (`resolver.pickWithLock`); ⏳ UI/APIs |
| Prompt management (versions/approval/rollback) | ✅ schema + resolver; ⏳ APIs/UI + call-site adoption |
| Runtime profiles | ✅ built & seeded |
| Superadmin governance | ⏳ schema ready; APIs/UI in Phase 3–4 |
| AI Studio intuitive for non-technical users | ⏳ Phase 4 |
| Existing functionality unchanged / no regressions | ✅ flag-off guarantee + smoke test |
| Clean enough for future capabilities without redesign | ✅ register a capability + (optionally) a prompt; no core change |
| No scattered AI remains | ⏳ Phases 2 & 5 (cutover + legacy removal) |

**Honest bottom line:** the *platform core and its guarantees are real and in the tree today*, flag-gated to change nothing. The *operator-facing surface* (governance APIs, AI Studio) and the *cutover of the ~20 call sites + `ai-service`* are the remaining phases. This is by design — it is the only way to reach "no scattered AI" without a big-bang rewrite or regressions.
