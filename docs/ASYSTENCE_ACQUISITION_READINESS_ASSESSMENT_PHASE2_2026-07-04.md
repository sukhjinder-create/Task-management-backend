# Asystence — Acquisition Readiness Assessment (Phase 2)

**Prepared for:** Internal technical due diligence of a global enterprise software acquirer.
**Prepared as:** Technical Due-Diligence Team.
**Question this answers:** *"If we acquired Asystence today, what exactly would we be buying?"*
**Method:** Evidence-only, from the four repositories. Unverifiable items are marked **[UNVERIFIED]**. No valuation, no company worth, no pitch — as instructed.
**Date:** 2026-07-04

**Repositories now in scope (Phase 1 covered only the first two):**
| Repo | Own git repo? | Size | Role |
|---|---|---|---|
| `Task-management` | yes | ~57.6k LOC | Web + Electron desktop frontend |
| `Task-management-be` | yes | ~128.9k LOC | Backend API, DB, intelligence, integrations |
| `Task-management-landing` | yes | ~4.4k LOC | Marketing / SEO / release-notes site |
| `ai-service` (the "ai-task" repo) | **no `.git`** | **~764 LOC** | Standalone AI chat microservice |

> This phase **builds on and revises** Phase 1 (`ASYSTENCE_TECHNICAL_PRODUCT_DUE_DILIGENCE_AUDIT_PHASE1_2026-07-04.md`). Two Phase-1 conclusions change materially after reading `ai-service` and the deployment file; those revisions are called out explicitly in **§0**.

---

## §0. Revisions to Phase 1 (read this first)

1. **The production LLM is NOT a 1B demo model.** Phase 1 flagged the code default `OLLAMA_MODEL=llama3.2:1b`. The actual deployment config (`task_m/envvars-deploy.yaml`) sets `LLM_PROVIDER=groq`, `GROQ_MODEL=llama-3.3-70b-versatile` (and `OLLAMA_MODEL=gpt-oss:120b-cloud`). **In production the AI runs on Groq Llama-3.3-70B, a capable model.** The "1B" is only the unconfigured fallback. **Revise the AI-quality concern down** — the concern is now *cost/metering and dependence on Groq*, not model capability.

2. **There are TWO overlapping AI assistants, and the "AI service" is far smaller than its structure implies.** Phase 1 saw only the in-backend RAG assistant (`ai/ai.intelligence.service.js`). The separate `ai-service` microservice is a **~764-line "away-colleague" chat auto-responder**, whose impressive folder names (`agents/`, `cognition/`, `memory/`, `perception/`, `actions/`, `prompts/`, `core/`) are **mostly empty or dead** (evidence in §2). This **reinforces**, and makes more concrete, Phase 1's "naming inflation" thesis.

3. **New critical security finding:** `task_m/envvars-deploy.yaml` contains **real production secrets in plaintext** and **weak default secret values** (details in §8). This was not visible in Phase 1's two-repo scope. It is now the single most urgent risk item.

Everything else in Phase 1 stands.

---

## §1. Complete Product Capability Map

Capabilities grouped into pillars. **Maturity** = reviewer judgment from code depth/tests. **Replicate** = difficulty for a competent team to rebuild the *implemented* behavior (not the brand).

### Pillar A — Work Management *(the real core)*
| Capability | Purpose | Maturity | Depends on | Business value | Replicate |
|---|---|---|---|---|---|
| Projects/Tasks/Subtasks/Statuses | Core issue tracking, ticket numbering, story points, task types | **Production** | pg, workspace mw | High (the product's spine) | Months |
| Sprints / Boards | Agile planning | **Mature** | tasks | High | Months |
| Task links / watchers / votes / tags / saved filters / issue templates | Jira/YouTrack parity features | **Beta→Prod** | tasks | Medium | Weeks–Months |
| Time tracking | Estimates vs actuals (feeds scoring) | **Beta** | tasks | Medium | Weeks |

### Pillar B — Communication & Meetings
| Capability | Purpose | Maturity | Depends on | Value | Replicate |
|---|---|---|---|---|---|
| Chat (channels, DMs, unread, member keys) | Slack-style messaging | **Beta→Prod** | socket.io | High | Months |
| Huddles (video) | LiveKit rooms, tokens, ICE, media policy, recovery/heartbeats, device identity | **Beta** | livekit-server-sdk | High but fragile | Months–>1yr (infra) |
| Transcription | Deepgram/OpenAI/Groq/AssemblyAI STT pipeline | **Beta** | STT vendors | High | Months |
| Meeting Intelligence | Transcript → topics → risk/blockers → decisions/action-items → exec summary | **Beta** | LLM (Groq) | **High / differentiator** | Months |

### Pillar C — AI & Intelligence *(see §2, §3 for the honest depth check)*
| Capability | Purpose | Maturity | Depends on | Value | Replicate |
|---|---|---|---|---|---|
| Enterprise/Workspace Intelligence | Deterministic scoring of users/projects/teams/workspaces w/ evidence hashing | **Beta** | pg + evidence collectors | Medium–High | Months |
| Adaptive Intelligence | Event-driven heuristic reasoning→planning→approvals→learning | **Prototype→Beta** | event bus | Medium (as heuristics) | Months |
| In-backend AI assistant | RAG Q&A over workspace, scope-guarded, deterministic fallback | **Beta** | LLM | Medium | Weeks–Months |
| `ai-service` away-responder | Auto-answers DMs about an away colleague, permission-gated | **Beta (narrow)** | LLM + backend `/internal` | Low–Medium | **Weeks** |
| Autopilot | Rule-based workspace analysis → proposed actions + LLM standups | **Beta** | LLM, cron | Medium | Months |
| Testing Agent | Playwright browser test authoring/execution | **Prototype→Beta** | playwright + LLM | Medium (niche) | Months |
| NL task creation | Natural-language → task | **Beta** | LLM | Low–Medium | Weeks |

### Pillar D — Attendance & HR / People Ops
| Capability | Purpose | Maturity | Value | Replicate |
|---|---|---|---|---|
| Attendance (events→daily/monthly, geo, screen-activity, recalc, cron) | Workforce time tracking | **Mature** | High (India/SMB-fit) | Months |
| Leave / Holidays | Time-off management | **MVP→Beta** | Medium | Weeks–Months |
| Performance Reviews / OKRs-Goals | Reviews, objectives, sprint-goal sync | **MVP→Beta** | Medium | Months |

### Pillar E — Administration & Enterprise
| Capability | Maturity | Notes | Replicate |
|---|---|---|---|
| Auth (JWT, bcrypt, Google OAuth, magic links, reset) | **Production** | Solid fundamentals | Months |
| MFA (TOTP), SSO (SAML) | **MVP** | Present, breadth ≫ depth | Months |
| RBAC + plan-feature gating | **Production** | URL-bypass-proof enterprise gate | Months |
| Superadmin control plane | **Beta** | Cross-tenant ops, backups, plans, growth | Months |
| Audit logs / GDPR / API keys / outbound webhooks | **MVP** | Checkbox-level | Weeks–Months |

### Pillar F — Monetization
| Capability | Maturity | Notes |
|---|---|---|
| Stripe billing (plans, seats, trials, checkout, webhooks w/ raw-body sig verify) | **Beta→Prod** | Real, no Stripe SDK (hand-rolled via axios) |
| Razorpay billing | **Beta** | Newer; India market |

### Pillar G — Integrations / Developer Platform
| Capability | Maturity | Notes | Replicate |
|---|---|---|---|
| Universal integration framework (registry/manager/providers/webhooks/rehydration/state) | **Beta** | Genuinely architected; providers: Asana, YouTrack, Jira, base | Months |
| Slack migration, Git automation (webhooks + inference) | **Beta** | Real sync scaffolding | Months |

### Pillar H — Clients (Reach)
| Capability | Maturity | Notes |
|---|---|---|
| Web app (React/Vite) | **Production** | 46 pages, strong API client |
| Desktop (Electron win/mac/linux) | **Beta→Prod** | Full build pipeline |
| Mobile (Flutter, `mobile/asystence_mobile`) | **[UNVERIFIED store status]** | Present; APK URL in deploy env |

### Pillar I — Landing / Brand / SEO
| Capability | Maturity | Notes | Replicate |
|---|---|---|---|
| Marketing site (React/Vite) | **Beta** | contentPages/marketingPages, designSystem | Weeks |
| SEO tooling (sitemap generator, `seo.js`) | **Beta** | Prebuild sitemap step | Days–Weeks |
| Release Center (`ReleaseCenter.jsx`, `releaseData.js`) | **Beta** | Public changelog; pulls public plans from API | Weeks |

**Pillar-level honest read:** The **breadth is real and verified** across all four repos. Depth is concentrated in Work Management, Attendance, and Auth/Tenancy; everything labeled "enterprise" or "AI/adaptive" is thinner than its name. The landing site and `ai-service` are the two smallest, least defensible assets.

---

## §2. AI Capability Assessment (now including `ai-service`)

### 2.1 Inventory of what actually exists
**A. In-backend AI (the larger, real surface — Phase 1):**
- LLM abstraction `services/llm.js` (ollama/openai/grok/groq/huggingface, retry/backoff, JSON mode).
- Meeting Intelligence pipeline (topic segmentation, risk/blocker extraction, language normalization, copilot, multi-pass executive summary) — **the flagship, genuine end-to-end LLM use.**
- RAG workspace assistant `ai/ai.intelligence.service.js` (context builder + ID sanitization + `[OUT_OF_SCOPE]` guard + deterministic fallback).
- Autopilot standups, NL task creation, testing agent, forecast reasoning, executive summary/LLM-explanation services.

**B. The standalone `ai-service` microservice (new in Phase 2):**
- **Live code path (only this works):** `index.js` exposes `POST /internal/chat-event` (Bearer == `AI_SERVICE_SECRET`) → `eventBus.emit` → `agents/responder.js#maybeRespond` → Groq via `services/llm.service.js`.
- **Real capability = one workflow:** when a DM targets an *away* user, it (1) calls backend `/internal/association` to confirm the two users **share a project** (permission gate — genuinely thoughtful), (2) fetches the away user's task context scoped to shared projects, (3) prompts Groq to emit a `REASONING:`/`ANSWER:` reply, (4) posts it back via `/internal/ai/reply`. Channel messages get a canned "👋 I'm here to help!" only.
- **Safety engineering is real:** absolute try/catch isolation ("AI can never break chat"), loop-guard (`__from_ai`), min-length guard, workspace `ai_enabled`/`ai_auto_reply` flags, deterministic fallback text.

### 2.2 What the grand folders actually contain (evidence)
| Path | Advertised | Reality (verified) |
|---|---|---|
| `memory/longTerm.js` | Long-term memory | **0 bytes (empty)** |
| `prompts/chat.prompt.js` | Prompt library | **0 bytes (empty)** |
| `actions/chatWriter.js` | Action framework | **0 bytes (empty)** |
| `memory/shortTerm.js` | Short-term memory | **Broken** — refers to undefined `channelKey`; never imported |
| `cognition/intentDetector.js` | Cognition/intent | 4-line keyword `if (text.includes("?"))`; never imported by responder |
| `perception/chatListener.js` | Perception layer | Polling listener referencing an unimported `fetchChannels`; superseded by the webhook |
| `app.js` + `routes/ai.routes.js` + `context/buildContext.js` | HTTP AI API | **Dead path** — `index.js` builds its own app and never mounts `app.js` |
| `core/aiIdentity.js` | Agent identity | 5-line constant object |

**So:** of ~764 lines, the functioning agent is roughly **~300 lines** in `responder.js` + `backendApi.js` + `llm.service.js`. There is **no** persistent memory, **no** planning, **no** tool-calling, **no** multi-agent orchestration, **no** retrieval beyond a single backend context fetch, and the "reasoning pipeline" is a **one-shot prompt** that asks the model to prefix a `REASONING:` sentence.

### 2.3 Sophisticated vs commodity vs unique vs prototype
- **Genuinely sophisticated:** Meeting Intelligence (multi-pass transcript→executive-synthesis) is the only capability that would take a competitor real effort and reflects real prompt/pipeline work.
- **Thoughtful but simple:** the away-responder's **permission-gated context sharing** (share-a-project association check before revealing a colleague's workload) is a nice product idea, but trivially small in code.
- **Commodity:** the LLM abstraction, RAG-over-your-data assistant, NL-task-creation, standup generation — every competitor has equivalents; these are prompt-wrappers around Groq/OpenAI.
- **Not really AI (mislabeled):** "Enterprise Intelligence" and "Adaptive Intelligence" are deterministic scoring/heuristics (Phase 1 §4). The `ai-service` "cognitive architecture" is **aspirational scaffolding**.
- **Prototype:** Testing Agent; adaptive "learning" (it records accept/reject signals, no model training).

**Net AI verdict:** The AI story is **one strong feature (meeting intelligence) + a set of competent prompt-wrappers + a lot of impressively-named scaffolding.** An acquirer should value the *meeting-intelligence pipeline and the data/plumbing that feeds it*, and assign near-zero standalone value to `ai-service` as a "cognitive platform."

---

## §3. Intellectual Property Assessment

Ranked by how defensible/proprietary each item genuinely is (evidence-based):

1. **Explainable, evidence-hashed scoring model** (`intelligence/evaluators/*`, `engine/scorePrimitives.js`, per-workspace `scoringConfig`). *Why it's IP:* a coherent, versioned, reproducible way to turn task/attendance/time data into user/project/team/workspace scores with an attached evidence hash and confidence. It's not ML, but it is a **non-trivial, opinionated domain model** that encodes real judgment about "what good execution looks like." Hardest single thing to reproduce faithfully.
2. **Meeting-intelligence pipeline** (`services/huddle*Intelligence*`, topic segmentation → risk/blocker extraction → decisions/action-items → executive synthesis, feeding `huddle_meeting_digests`). *Why:* prompt architecture + schema + the loop that turns a call into task-level operational signal. This closed loop (meeting → action items → task risk → recommendation) is the most differentiated flow in the product.
3. **Non-invasive event architecture** (`events/eventBus.js`, observers, `adaptive/bootstrap.js`). *Why:* lets analytics/AI evolve without entangling the CRUD core — a genuinely good architectural asset, reusable and clean.
4. **Universal integration framework** (`integrations/core` registry/manager + provider abstraction + webhook rehydration/state). *Why:* a real adapter pattern with state reconciliation; more than a one-off Asana connector.
5. **Adaptive reasoning heuristics** (`adaptive/reasoning/*` riskDelta model, idempotency keys, approval invariants). *Why:* encodes operational-context-to-recommendation logic; moderate IP, easily out-innovated.
6. **Data model** (121 tables spanning work+chat+video+HR+billing+intelligence under one tenancy). *Why:* the schema itself represents accumulated product decisions; migration/portability cost is real.
7. **Permission-gated AI context sharing** (`/internal/association` share-a-project check). *Why:* small but a genuinely good privacy primitive for "AI answering on behalf of a colleague."

**Weak/limited IP:** `ai-service` "cognitive" scaffolding (empty), the landing site, the SSO/GDPR/audit checkboxes, and anything branded "certification/governance" in `docs/`.

---

## §4. Competitive Position (implementation-only)

Comparing only **capabilities that exist in code**, not price/market.

**Where Asystence is AHEAD / unusual:**
- **Single tenanted app spanning issue-tracking + chat + video-with-transcription + attendance/HR + OKRs + billing + AI.** No single incumbent implements *all* of these in one product — Jira/Linear (tracking) don't do video+HR; Slack/Teams (chat/meetings) don't do issue tracking + HR scoring; Monday/ClickUp/Notion (work mgmt) don't run their own LiveKit video + STT + attendance with geo/screen-activity. The **breadth is the position.**
- **Attendance with geo + screen-activity + recalculation** is deeper than what Jira/ClickUp/Monday/Notion/Linear/Asana offer (they don't target workforce-time at all).
- **Explainable scoring with evidence hashes** is more transparent than the black-box "insights" in Monday/ClickUp.

**Where it's BEHIND (implementation):**
- **Issue tracking depth** vs Jira/Linear: no automations engine parity, no JQL-class query language (only saved filters), weaker workflow customization, no roadmap/portfolio management.
- **Chat** vs Slack/Teams: no threads-at-Slack-depth, huddles fragile (heavy recovery code), no enterprise chat governance/eDiscovery.
- **Video** vs Zoom/Teams: LiveKit gives WebRTC, but no evidence of recording infra parity, breakout rooms, phone dial-in, large-scale webinar mode. Reliability **[UNVERIFIED, likely weaker]**.
- **Docs/Wiki** vs Notion: shallow (`wiki_pages`), no block editor / databases / templates ecosystem.
- **Automation** vs ClickUp/Monday: autopilot is rule-based and narrow, not a user-facing no-code automation builder.
- **Enterprise** vs all incumbents: SSO/audit/GDPR present but unattested (no SOC2/pen-test), no admin depth (SCIM, DLP, retention policies).

**UNIQUE (in one product):** meeting-intelligence → task-risk loop; workforce attendance fused with execution scoring; permission-gated "AI answers for an away teammate."

**MISSING vs the field:** no-code automation builder, roadmaps/portfolio, dashboards-as-a-product/BI export, marketplace/public API, native mobile parity **[UNVERIFIED]**, recording/compliance for meetings.

**Blunt verdict:** Asystence is a **broad "good-enough at many things" platform** that is **behind the category leader in every individual category** but **combines categories no single leader combines.** Its competitive claim is *integration surface*, not best-in-class depth anywhere except (arguably) attendance and the meeting-intelligence loop.

---

## §5. Acquisition Value — what you'd actually be buying

| Asset | Real value | Evidence-based caveat |
|---|---|---|
| **Product breadth / feature surface** | High — a working, tenanted super-app across 15+ modules | Depth uneven; "enterprise" shallow |
| **Core architecture** (event bus, tenancy, plan-gating, integration framework) | High — clean, extensible, reusable | Service layer inconsistent (8/93 use repositories) |
| **Meeting-intelligence pipeline + data** | High — the flagship differentiator | Reliability of the video path unproven |
| **Explainable scoring engine** | Medium–High — opinionated domain IP | Not ML; replicable in months |
| **Attendance/workforce module** | Medium–High — deeper than incumbents; India-market fit | Niche outside SMB/services |
| **Multi-client reach** (web + Electron desktop + Flutter mobile) | Medium — real cross-platform footprint | Mobile store status **[UNVERIFIED]** |
| **Integration framework + connectors** (Asana/YouTrack/Jira/Slack/Git) | Medium — migration on-ramp from competitors | Beta-grade |
| **Talent / engineering capability** | **High but concentrated** — one developer built all four repos at high velocity | **Bus factor 1** = the asset *is* the person |
| **Infrastructure/deployment** | Low–Medium — Cloud Run + Vercel + Supabase, scripted | No CI/CD, no IaC, manual deploys |
| **Documentation** | Low — voluminous but largely self-generated status/marketing docs | Not engineering-grade; some misleading "certifications" |
| **Brand / landing / SEO** | Low — small marketing site + sitemap | ~4.4k LOC, easily rebuilt |
| **Customers / traction** | **[UNVERIFIED — not in code]** | Must be provided separately |
| **`ai-service` as a "platform"** | ~Zero standalone | Mostly empty scaffolding |

**The core insight for a buyer:** you are primarily acquiring **(a) a broad, coherent product+data model with one genuinely differentiated AI loop, and (b) a single, unusually productive builder.** The "AI platform," the "enterprise certifications," and the brand are not where the value is.

---

## §6. Engineering Investment (ranked, no hours)

- **Very High:** Huddles/real-time media stack (LiveKit rooms, tokens, ICE, media policy, device identity, recovery/heartbeats/restoration — the volume of remediation code signals sustained effort) · The overall backend surface (121 tables, 69 route groups, 93 services, 81 migrations) · Meeting-intelligence pipeline.
- **High:** Attendance system (event stream → daily/monthly aggregation + recalculation + geo/screen-activity) · Intelligence scoring engine (evidence collectors + evaluators + scoring config) · Integration framework + connectors · Frontend (46 pages + Electron + strong API client) · Billing (dual Stripe/Razorpay + webhooks).
- **Medium:** Adaptive engine · Autopilot · Chat · Superadmin console · Enterprise checkboxes (MFA/SSO/audit/GDPR) · Testing Agent.
- **Low:** `ai-service` microservice (~764 LOC, much of it empty) · Landing site · NL task creation · Various single-purpose routes.

**Signal:** effort correlates with the *core and the video stack*, not with the "AI/adaptive intelligence" branding. The most-hyped modules received the least code.

---

## §7. Replaceability (rebuild the *implemented behavior*)

- **Weeks:** `ai-service` away-responder · landing/SEO site · NL task creation · canned autopilot rules · basic RBAC/plan-gating · saved filters/tags/watchers/votes.
- **Months:** Core work management (projects/tasks/sprints) · chat · attendance · scoring/intelligence engine · integration framework · billing · auth+MFA+SSO · desktop packaging · meeting-intelligence pipeline (given transcripts already exist).
- **More than a year (or highest-risk to rebuild):** The **full integrated breadth as one coherent tenanted product** — any one module is months, but reproducing *all pillars working together under consistent tenancy + an event architecture + multi-client delivery* is the >1-year effort. Also **>months of hardening** for the **video/huddle reliability** to reach Zoom/Teams-grade (this is where most teams underestimate).

**Implication:** No single module is a moat; the **assembled whole** is the only thing that's expensive to replicate — and even that is "expensive," not "impossible."

---

## §8. Risk Assessment

**Security (highest-priority):**
- **CRITICAL — plaintext production secrets on disk.** `task_m/envvars-deploy.yaml` contains real Supabase `DATABASE_URL`/`DB_PASSWORD`, a live Groq API key, Google & Asana OAuth client secrets, two Slack webhook URLs, and the VAPID private key. Anyone with repo/workspace access gets full DB + third-party control. *(Values not reproduced here by design.)*
- **CRITICAL — weak/default secret values.** `JWT_SECRET="task_management_secret"` is literally the dev fallback that `config/secrets.js` refuses in production (with `NODE_ENV=production` the backend should throw at boot — so either this env file is stale or the deployed env differs; **must be clarified**). `AI_SERVICE_SECRET="super-secret-token"`. Forgeable tokens if actually used.
- **HIGH — internal endpoints may be unauthenticated.** `/internal` is mounted with no blanket auth; `/internal/chat/context` and `/internal/attendance/summary` use `requireInternalServiceSecret`, but `/internal/ai/reply`, `/internal/user-context/:id`, and `/internal/association` appear to **lack that guard** in `routes/internal.js`. If so, workspace context and AI-message posting are reachable without the service secret. **[VERIFY]**
- **MEDIUM:** non-constant-time token compares in `ai-service` (`token !== AI_SECRET`); `rejectUnauthorized:false` on DB SSL; per-request URL logging (token/PII leakage into logs); 50 MB JSON limit; no app-layer rate limiting on the main backend (the AI service has `express-rate-limit` as a dep but the main API relies on Cloud Run/Cloudflare); open CORS in non-prod.
- **No external validation:** the `docs/` "SECURITY CERTIFICATION" is self-generated; no SOC2/pen-test artifacts.

**Technical / Architecture:**
- Inconsistent data access (8/93 services use repositories; the rest embed SQL) → large audit surface, injection risk rests on universal parameterization.
- `ai-service` has no `.git` history, empty/broken/dead files shipped → poor engineering hygiene; not independently versioned.
- Two overlapping AI assistants (backend RAG vs `ai-service` responder) → unclear ownership/duplication.

**Operational / Deployment:**
- **No CI/CD, no IaC, manual `gcloud`/Vercel deploys.** No automated test gate.
- **In-process crons** started at boot in every instance → duplicate standups/backups/recalcs if the API scales past one instance (Phase 1 §8).
- Railway healthcheck `/health` appears undefined in `index.js`.
- Backup cron exists; **restore/DR never proven [UNVERIFIED]**.

**AI-specific:**
- Vendor concentration on **Groq** (single provider configured in prod) with **no cost metering** in the LLM client and **no fallback chaining**; a Groq outage or price change directly degrades AI features.
- No output guardrails/eval harness; prompt strings inline, unversioned.

**Legal (where visible in code only):**
- **IP/authorship:** 250/252 backend commits from one identity; `ai-service` unversioned — clean assignment must be contractually confirmed.
- **Provenance:** velocity + volume + many same-day self-authored "certification" docs strongly suggest heavy AI-assisted generation — verify true human-owned/understood portion and any license implications.
- GDPR endpoints exist but end-to-end compliance (residency, DPA, sub-processors, deletion) is **[UNVERIFIED]**.

**Maintainability / Knowledge concentration:**
- **Bus factor = 1** across all four repos — the top *non-security* risk. The system's breadth cannot be safely maintained or evolved by the current team-of-one at production quality; the huddle "recovery/remediation" churn is consistent with a single maintainer firefighting.

---

## §9. Acquisition Readiness Score

Scale: 1 (poor) – 10 (excellent). Scores reflect **current, evidence-based state**, not potential.

| Dimension | Score | Justification |
|---|---|---|
| **Architecture** | **6.5** | Clean event bus, strict tenancy, plan-gating, integration framework; offset by inconsistent data layer, no DI/contract, dead code in `ai-service`. |
| **Code Quality** | **5.5** | Thoughtful resilience patterns and naming; but empty/broken shipped files, scattered SQL, emoji/console logging. |
| **Security** | **3.0** | Good fundamentals (prod-secret enforcement in code, RLS, constant-time compares *in backend*) **undermined by plaintext prod secrets, weak default secrets, likely-unguarded internal routes, no CI security gate**. |
| **Maintainability** | **3.5** | Bus factor 1, 121 tables, 4 repos, no CI, hand-run migrations. |
| **AI** | **5.0** | One strong feature (meeting intelligence) + competent wrappers + **empty "cognitive" scaffolding**; prod model is a solid 70B (revised up), but single-vendor, unmetered. |
| **Product** | **7.0** | Genuinely broad, coherent, multi-client; real daily-use core. |
| **Enterprise Readiness** | **3.0** | Feature checkboxes present; no attestation, thin depth, self-authored "certifications." |
| **Scalability** | **4.5** | Stateless API + Redis adapter + Cloud Run autoscale in principle; in-process crons and unproven load undercut it. |
| **Differentiation** | **5.5** | Breadth + meeting-intelligence loop + attendance are real; behind leaders in every single category. |
| **Technical Debt** | **4.0** | High debt: tests (6 files/129k LOC), no CI, dead code, duplicated LLM clients, two AI assistants. |
| **Innovation** | **5.5** | The meeting→task-risk loop and evidence-hashed scoring are genuinely interesting; much of the rest is renamed convention. |
| **Documentation** | **4.0** | Volume high, engineering value low; some docs actively misleading (certification/readiness). |
| **OVERALL** | **≈ 4.7 / 10** | A broad, ambitious, partially-solid early-production platform with real product value, one real AI differentiator, and **serious security + maintainability + concentration risk**. Not enterprise-ready as-is. |

---

## §10. Final Verdict

**Would I recommend acquiring Asystence today?**
**Conditionally, and only as an acqui-hire + product/data acquisition — not as a turnkey enterprise platform.** The defensible value is (1) the integrated product surface and data model, (2) the meeting-intelligence loop, and (3) the single highly-productive builder. It is **not** safe to acquire on the strength of its "enterprise," "certified," or "adaptive intelligence" framing, all of which the code contradicts.

**What would concern me (in priority order):**
1. **Plaintext production secrets + weak default secrets** on disk (§8) — must be rotated and root-caused before anything else; also a signal of security-process immaturity.
2. **Bus factor = 1** across four repos — retention of the founder/author is the deal.
3. **No CI/no tests/no IaC** — nothing can be changed safely until this is built; budget for it.
4. **AI substance gap** — the "cognitive AI service" is largely empty; do not price it as a platform.
5. **Enterprise/compliance claims unbacked** — no SOC2/pen-test; GDPR end-to-end unverified.

**What impressed me:**
- The **breadth actually works** and is consistently multi-tenant — rare for a solo build.
- **Meeting intelligence** and the **evidence-hashed scoring model** are genuinely thoughtful.
- Real **engineering maturity in spots**: silent-refresh API client, event-bus/observer isolation, webhook signature verification, DB stale-connection retry, "AI can never break chat" isolation, permission-gated AI context sharing.

**Which parts should remain untouched (keep & build on):**
- Event bus + observer architecture; multi-tenant enforcement; plan-gating; integration framework; the scoring/evidence engine; the meeting-intelligence pipeline; the frontend API client.

**Which parts require investment (fix/replace):**
- **Immediately:** secrets management + rotation; CI/CD + a real test suite; internal-route auth audit; observability (structured logs, tracing, error tracking); LLM cost metering + provider fallback.
- **Near-term:** consolidate the two AI assistants; retire/rewrite the `ai-service` scaffolding into an honest, small service; distributed cron/scheduler; huddle reliability hardening; repository-pattern consolidation.
- **Before "enterprise" claims:** SOC2/pen-test, SCIM, retention/DLP, real GDPR data-lifecycle proof.

**Strongest asset:** the **integrated, multi-tenant product breadth + its data model + the meeting-intelligence loop** — the one thing that is expensive to reproduce as a coherent whole.

**Weakest asset:** the **`ai-service` "cognitive platform"** (mostly empty/dead code) and the **security/operational posture** (plaintext secrets, no CI, bus factor 1).

**Questions I would ask the founder before closing:**
1. Which env is *actually* deployed, and can you prove the production `JWT_SECRET`/`AI_SERVICE_SECRET` are not the weak values in `envvars-deploy.yaml`? When were these last rotated? Any known exposure?
2. Are `/internal/ai/reply`, `/internal/user-context`, `/internal/association` protected by the service secret in production? Show the middleware.
3. Who else, if anyone, understands each subsystem? What breaks if you're unavailable for a month?
4. How much of these four repos was AI-generated, and is *all* of it cleanly assigned to the company?
5. What is the real Groq (and Deepgram/LiveKit) monthly spend per active workspace, and is there any per-tenant AI metering?
6. What is the actual huddle call-failure/drop rate, and why the volume of recovery/restoration code?
7. Show me one clean end-to-end: create workspace → invite user → run a huddle → generate the meeting digest → see it drive a task-risk recommendation. Does the flagship loop work reliably today?
8. How many paying, retained workspaces exist, on what infra, and can tenants be exported/deleted cleanly across all 121 tables?
9. Has a backup restore / DR drill ever succeeded?
10. Which of the 15+ modules do customers actually use (show `growth/` telemetry) vs. built-but-idle?

---

*End of Phase 2. As instructed: no valuation, no company worth, no pitch/deck/slides. This is an internal, evidence-based technical due-diligence document. Secret values discovered during the audit were deliberately not reproduced here; they are flagged for rotation.*
