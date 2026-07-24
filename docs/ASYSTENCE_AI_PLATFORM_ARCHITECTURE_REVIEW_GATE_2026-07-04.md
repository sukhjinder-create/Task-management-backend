# Asystence AI Platform — Final Architecture Review Gate (pre-Phase 2)

**Reviewer role:** Principal Enterprise Architect (independent). I did not design this; I am reviewing it as if handed someone else's design.
**Rule honored:** If any **Critical** architectural issue exists, Phase 2 does not begin. Redesign, then re-gate.
**Scope reviewed:** `ai-platform/*` (Phase 1 code), `migrations/20260704_ai_platform_foundation.sql`, the modified `services/llm.js`, and the architecture spec.
**Date:** 2026-07-04

> **Verdict up front (details in §20): NOT APPROVED for Phase 2 as designed.** The foundation's *shape* is sound and worth keeping, but the core **invocation contract is text-only**, and three multi-tenant concerns (per-workspace keys / who-pays, provider-capability compatibility, prompt-injection & isolation) are unmodeled. These are cheap to fix now and very expensive to fix after ~20 call sites cement themselves on the current contract — which is exactly what this gate exists to prevent.

---

## What I am explicitly NOT going to soften
The Phase 1 code is clean, non-regressive, and the choke-point/adapter/inheritance ideas are correct. That is not the question. The question is whether this is *permanent platform infrastructure*. Judged against Copilot / Vertex / Einstein / Now Assist, **it is currently a well-built LLM text-proxy, not an AI platform.** The gap is structural, not cosmetic.

---

## 1. Platform Architecture (decomposition)
**Findings.**
- Decomposition is mostly right (gateway / providers / resolver / prompts / profiles / policy / telemetry). But two boundaries are wrong for the long run:
  - **`resolver.js` conflates two different resolutions** — *configuration* resolution (which provider/model/prompt) and *compatibility* resolution (can that provider actually satisfy this capability's requirements). These must be separate concerns; today only the first exists (§4, §5). 
  - **The capability registry is split-brain**: the immutable contract of a capability (its modality, I/O schema, required provider features) lives in code, while its *operational routing* lives in DB — but Phase 1 mixes both (code seeds DB with `ON CONFLICT DO NOTHING`, then both drift). Ownership must be explicit: **code owns the contract; DB owns operations.**
- **10-year test:** the folder names survive, but `gateway.js` modeled on "prompt→text" will not. Renames needed: `generateText`-centric naming → `invoke`/`AIRequest`/`AIResponse`.

**Rec:** split resolver into `ConfigResolver` + `CompatibilityResolver`; formalize registry ownership. **(Important)**

## 2. Gateway
**Findings (this is the biggest one).**
- `runCapability()` returns `{ text, meta }`; `gatewayGenerateText()` returns a bare string. The entire contract is **text-in/text-out**. This cannot represent, without a breaking change:
  - **Streaming** (return type becomes an async iterator; you cannot `withTransientRetry(() => adapter.generate())` a half-streamed response).
  - **Tool / function calling** (needs `tools` in, `tool_calls` out, and a multi-turn tool loop the gateway currently has no place for).
  - **Structured output** (only a `json:true` boolean; no output JSON schema, no validation).
  - **Multimodal input** (`toMessages()` coerces content to `String(prompt)`; images/audio/files impossible).
  - **Embeddings / rerank / classification** (different provider endpoints entirely).
- **Retry is at the wrong layer.** Wrapping the whole adapter call in blind transient-retry is unsafe for tool-calls, streaming, and non-idempotent operations, and can double-bill on 429 without idempotency keys.
- **No request envelope versioning.** The response object is ad-hoc and unversioned; once callers depend on `.text`/`.meta`, evolution is a breaking change.

**Rec (blocker):** redefine the contract as a **modality-agnostic, versioned envelope** — `AIRequest{ schemaVersion, capability, workspaceId, trigger, input: Part[], tools?, responseSchema?, stream?, idempotencyKey }` → `AIResponse{ schemaVersion, output: Part[], toolCalls?, usage, meta }`, where `Part` ∈ {text, image, audio, file, json}. Keep a thin `generateText` shim on top for legacy. Move retry to a **per-capability retry policy** and make it idempotency-aware. **(CRITICAL)**

## 3. Capability Registry (field review)
Current fields: key, name, description, category, owner, default{provider,model,profile,prompt}, fallbackPrompt, enabled. **Missing, and needed before cementing:**
- **Modality / I/O:** `inputModality[]`, `outputModality`, `inputSchema`, `outputSchema`, `outputType`.
- **Provider requirements:** `requires: {json, tools, vision, streaming, minContextTokens}` → drives compatibility resolution (§4/§5).
- **Execution class:** `execution: sync|async|streaming`, `expectedLatencyMs`, `costClass`, `priority`, `businessCritical`, `retryStrategy`, `timeoutMs`.
- **Lifecycle & deps:** `lifecycle: experimental|ga|deprecated`, `dependsOn[]` (capabilities that call capabilities — agents), `sinceVersion`.
- **Governance:** `dataSensitivity` (does it see PII/transcripts?), `piiHandling`.

Without `requires`/modality, the platform cannot route safely or evolve to non-text. **Rec:** expand the registry schema now; it is the cheapest thing to change today and the most expensive later. **(CRITICAL)**

## 4. Provider Architecture
**Findings.**
- Adapter isolation is good, but **the adapter contract is text-chat only** (§2). "Add providers forever without touching business logic" is *false the moment* a capability needs vision/tools/streaming — you'd change the base contract, i.e., business logic.
- **Provider/model capabilities are not discoverable.** `ai_providers`/`ai_models` don't declare {supportsJSON, supportsTools, supportsVision, supportsStreaming, contextWindow, modalities}. The resolver will happily route a 128k-context capability to an 8k model, or a vision capability to Ollama-text, failing at runtime.
- Hidden assumption: **one API key per provider globally** (`api_key_env` is a single env name). This structurally prevents per-workspace keys (§12/§16).

**Rec:** make provider *capabilities* first-class and discoverable; the base adapter must advertise `capabilities()` and accept a typed request. **(CRITICAL)**

## 5. Prompt Platform
**Findings.**
- Prompt = single `body` text + naive `{{var}}` substitution. That is a **prompt-injection vector** (user-controlled variables are concatenated into instruction text with no escaping or role separation), and it cannot express: system/developer/user segmentation, few-shot examples, output schema, safety rules, **prompt↔model coupling** (a Claude-tuned prompt silently degrades on Gemini), composition/chaining.
- Versioning/approval/rollback/audit **schema** exists (good), but there is **no output validation, no prompt testing/preview path, no analytics/health** (win-rate, failure-rate per version), and no prompt↔capability↔model compatibility.
- No **A/B or diff-eval** at runtime (the tables allow versions but nothing compares them on real traffic).

**Rec:** promote prompts to **structured objects** (`system`, `developer`, `messages[]`, `fewShot[]`, `variables{schema}`, `outputSchema`, `safety`, `modelHints`), render with escaping/segmentation, validate output against schema, and add a sandbox test path. **(CRITICAL for injection; Important for the rest)**

## 6. Runtime Profiles
**Findings.** Profiles conflate *sampling* with *policy*. Enterprises need these as **separate policy axes**, not one profile enum: **execution policy** (sync/async/stream, timeout, concurrency), **reasoning policy** (effort/verbosity/tool-use budget), **cost policy** (max cost/call, model tier ceiling), **performance policy** (latency SLO, failover), **safety policy** (content filters, PII redaction, injection defense). Today "balanced/creative/…" only covers sampling.
**Rec:** keep sampling profiles, but introduce an orthogonal **Policy Set** (execution/reasoning/cost/performance/safety) attached at capability+workspace. **(Important)**

## 7. Governance
**Findings (the spec author already conceded locking is insufficient — confirmed).**
- `lock_level` is a **single 3-value enum**. It cannot express object-level, verb-level permissions. There is no way to say "workspace admin may **test** but not **publish** a prompt," or "may override **model** but not **provider**," or "may **clone** a platform prompt but not **edit** it."
- No permission matrix over verbs: **view/edit/override/test/publish/rollback/approve/clone/export/import/reset**.
- No **separation of duties** (author ≠ approver) even though approval columns exist.
- No delegation / role hierarchy beyond superadmin vs workspace-admin.

**Rec:** replace the single lock enum with an **object × verb × role × scope permission model** (with lock levels as one derived constraint), and enforce it in both API and resolver. **(Important, trending Critical because it's a data-model change)**

## 8. AI Studio UX
**Findings.** Specified, not built — acceptable for this gate — but the *terminology* is engineer-first and will fail the "admin knows nothing about AI" bar: "Runtime Profile," "adapter," "capability routing," "lock level." There is no onboarding, no safe-default wizard, no blast-radius warning ("this change affects 340 workspaces"), no test-before-publish in the flow, no cost preview at the point of change.
**Rec:** reframe around admin tasks ("Choose smarter vs faster," "Who can change AI," "Try it before you turn it on," "What will this cost"), enforce test+preview before publish, and show impact/estimated cost inline. **(Important — Phase 4, but the information architecture must be decided now because it constrains the APIs in §5-contract.)**

## 9. Cost Platform
**Findings.** This is currently **non-functional governance theater**: `ai_budgets` exists, but the gateway writes `est_cost_usd = null`, and the budget check sums `est_cost_usd` — so **budgets can never trigger**. There is:
- No **pricing table** wired (the `ai_models` cost columns exist but are unused).
- No **pre-execution** estimate → cannot *prevent* an over-budget call, only observe it after the fact.
- No forecasts, no per-workspace/feature ROI, no cost attribution to trigger/module.

**Rec:** implement pre-flight cost estimation (token estimate × `ai_models` pricing), enforce budgets *before* execution, and record actual cost post-execution. Budgets must fail-**closed** when configured. **(Critical for the "cost governance" claim; Important operationally)**

## 10. Observability
**Findings.** Per-request logging exists, but the **causal chain is missing**: `correlation_id` is generated fresh per call (`randomUUID`) and not propagated, so a capability that fans out to sub-requests (agents, multi-pass meeting intelligence) cannot be traced as a tree. No `traceId`/`parentSpanId`, no `sourceModule`, no `businessEvent`/`trigger`, no `userJourney`, no child-request linkage.
**Rec:** adopt trace-context propagation (`traceId` + `spanId` + `parentSpanId`), and record `sourceModule`, `trigger`, and `parentRequestId` on every row. **(Important)**

## 11. Event Architecture
**Findings.** AI requests have **no notion of why they exist**. There's already a first-class event bus in the product (`events/eventBus.js`); the AI platform ignores it. A request triggered by `meeting.ended` vs `dashboard.opened` needs different cost attribution, priority, and ret/async policy — none expressible today.
**Rec:** every `AIRequest` carries a `trigger { eventType, entityRef }`; allow capabilities to be **event-bound** so the platform (not each caller) decides sync/async/priority. **(Important)**

## 12. Security
**Findings — several are Critical.**
- **Per-workspace keys impossible.** One global env key per provider means every workspace using "openai" shares one platform-funded key. This breaks BYO-key, breaks tenant cost isolation, and means a workspace override can spend **platform** money on a **platform** key. **Who-pays / whose-key is unmodeled.** (Critical)
- **Prompt injection unhandled** at the platform layer (§5). For a platform that ingests untrusted chat/transcripts, this is Critical.
- **New tables are outside the RLS regime.** The existing product enables RLS on all tables; this migration creates `ai_*` tables but does **not** enable RLS or define policies on them, and the app relies on service-role. Tenant isolation for AI config/logs is by convention only. (Important→Critical)
- **Fail-open everywhere.** Policy and schema checks fail open (great for non-regression, wrong for a security control once live) — a dropped table silently reverts governance to env defaults. Need a "platform-required" mode. (Important)
- Secrets still in env (the exact class the DD flagged as leaked). No KMS/secret-manager integration, no rotation beyond env edits, no encryption-at-rest for future per-workspace keys. (Critical)

**Rec:** model **key ownership** (platform-key vs workspace BYO-key, stored encrypted via secret manager, resolved in-adapter per workspace); add prompt-injection defenses (role separation, variable escaping, output filtering, PII redaction as a safety policy); enable RLS + policies on all `ai_*` tables; add a fail-closed platform-required mode. **(CRITICAL)**

## 13. Future AI (voice/vision/agents/tools/RAG/memory/planning)
**Findings.** **Not supported.** The text-only contract (§2/§4) blocks vision, voice, screen understanding, tool calling, computer use. Agents/planning need multi-step orchestration, tool loops, and **memory** — the platform has no memory abstraction, no tool registry, no orchestration/step model, no RAG/retrieval abstraction. The registry's `dependsOn` (capability-calling-capability) doesn't exist.
**Rec:** the §2 envelope + a **Tool Registry** + an **orchestration/step interface** + a **retrieval/memory port** must be designed before Phase 2, even if implemented later — otherwise callers cement on a contract that can't host them. **(CRITICAL — this is the whole point of "will it last 10 years")**

## 14. Mobile (Flutter)
**Findings.** The gateway is an **in-process Node import**; Flutter cannot consume it. There is no external AI HTTP API, no auth model for device→AI, no streaming transport (SSE/WebSocket) for mobile, no offline/timeout UX contract.
**Rec:** define an **external AI API** (thin HTTP/SSE facade over the gateway, authed via the existing JWT/workspace model) as part of the contract now. **(Important)**

## 15. Desktop (Electron)
**Findings.** Electron renderer is the same web client — it will consume the same external AI API as web. Fine, *provided* §14's HTTP/SSE facade exists. The only Electron-specific note: streaming must not be blocked by the desktop CSP/proxy. **(Nice-to-have, contingent on §14)**

## 16. Integrations (Slack/Teams/Email/Google/MS/Asana/Jira/GitHub)
**Findings.** Integrations run server-side and *could* call `runCapability` directly, but they are also **event sources** — the right pattern is event-bound capabilities (§11), not each integration hand-rolling AI calls. Today nothing stops an integration from bypassing the gateway (the "no scattered AI" rule is aspirational until Phase 5/6). Outbound (AI→Slack/Teams) needs a **delivery abstraction**, not per-capability code.
**Rec:** integrations produce **triggers**; capabilities subscribe; outputs flow through a delivery port. **(Important)**

## 17. AI Health Dashboard (design)
Missing entirely. Design: per-**provider** health (success rate, p50/p95 latency, error taxonomy, rate-limit hits), per-**model** health (deprecations, drift, cost/1k trend), per-**capability** health (volume, failure %, budget burn, prompt-version win-rate), per-**workspace** health (spend vs budget, throttle events), and **platform** SLOs with alerting. Fed by `ai_request_logs` + a new `ai_provider_health` rollup. **(Important)**

## 18. AI Operations
**Findings.** No operational tooling: no provider/model **failover** (single provider returned by resolver), no circuit breaker / health-aware routing, no kill-switch per capability/provider, no replay/diagnostics, no DR story for the AI config (config lives only in Postgres; no export/import — which §7 also flags). 
**Rec:** health-aware routing + circuit breakers + per-capability/provider kill-switch + config export/import + request replay. **(Important; failover trends Critical for `businessCritical` capabilities)**

## 19. Missing Platform Features (net-new gaps)
Caching/dedup (exact + semantic), rate limiting & concurrency control / queueing, idempotency keys, batch/async job model, tool registry, memory/RAG ports, output validation, content safety/PII, evaluation harness (offline + online), model alias/lifecycle management, per-workspace key vault, external API + streaming transport, config export/import, health-aware failover. **(Mixed — several Critical, listed in §20.)**

## 20. Final Verdict

### VERDICT: **NOT APPROVED** (do not begin Phase 2)
The design is a strong *text-LLM proxy* with excellent non-regression properties, but it is **not yet platform infrastructure that lasts 10 years**. The blocking issues are all **data-model / contract** decisions that get 10× more expensive after ~20 call sites adopt the current shape.

### KEEP (do not rework — these are right)
Gateway-as-choke-point; adapter isolation with secrets-in-adapter; inheritance/locking *skeleton*; feature-flag non-regression; best-effort telemetry; the phased/reversible migration philosophy.

### CRITICAL — must be redesigned before Phase 2 (each one blocks)
1. **Modality-agnostic, versioned invocation envelope** replacing text-in/text-out (enables streaming, tools, multimodal, embeddings). *(§2, §13)*
2. **Provider & model capability discovery + compatibility resolution** (no silent mis-routing). *(§4, §5)*
3. **Expanded capability registry** (modality, I/O schema, `requires`, execution class, retry/timeout, lifecycle, sensitivity). *(§3)*
4. **Key-ownership & per-workspace secrets model** (platform-key vs BYO-key, encrypted, who-pays). *(§12)*
5. **Prompt-injection & safety layer** + structured prompts + output validation. *(§5, §12)*
6. **Tenant isolation for `ai_*`** (RLS + policies) and a **fail-closed platform-required mode**. *(§12)*
7. **Cost estimation before execution** + fail-closed budgets (today budgets can never fire). *(§9)*
8. **Tool registry + orchestration/step + memory/RAG ports** at least at the interface level, so agents can exist without a contract break. *(§13)*

### IMPORTANT — before or during early Phase 2
Object×verb permission model replacing the single lock enum (§7); orthogonal policy sets (execution/reasoning/cost/performance/safety) (§6); trace-context + business-event observability (§10, §11); external AI HTTP/SSE API for mobile/desktop/integrations (§14–16); health-aware failover + circuit breakers + kill-switch (§18); AI Health dashboard (§17); caching/rate-limit/idempotency (§19); model alias/lifecycle (§4).

### NICE TO HAVE
JSONB→typed columns where queried (§ data model); `hasAiPlatformSchema` cache TTL/invalidation (§ ops); config export/import (§18); prompt A/B eval harness (§5).

### Path back to APPROVED
Produce a **Contract v2** design covering the 8 Criticals (chiefly: the `AIRequest`/`AIResponse` envelope, provider/model capability matrix, expanded registry, key-ownership model, safety layer, `ai_*` RLS, pre-exec cost, and tool/memory ports as interfaces). Re-run this gate against Contract v2. **Only then** begin capability migration — starting, as planned, with `meeting_intelligence` on the canary flag.

---

**Bottom line, brutally:** Phase 1 proved we can wrap today's text calls safely. It did **not** prove we designed a platform. If we start Phase 2 now, we will cement 20 callers on a string-returning, single-key, injection-unaware, text-only contract — and then pay enterprise prices to unwind it. Fix the eight Criticals first. This is precisely the expensive mistake the gate exists to stop.
