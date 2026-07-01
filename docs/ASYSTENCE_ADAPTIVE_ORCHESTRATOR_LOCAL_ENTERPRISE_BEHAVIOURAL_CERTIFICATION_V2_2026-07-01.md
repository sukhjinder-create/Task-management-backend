# Asystence Adaptive Orchestrator Local Enterprise Behavioural Certification V2

**Audit date:** 1 July 2026
**Environment:** Isolated local development only
**Backend:** `http://localhost:5000`
**Frontend:** `http://localhost:5173`
**AI service:** `http://localhost:5005`
**Database:** `postgresql://localhost:5432/asystence_dev`
**Evidence marker:** `enterprise-audit-1782900352901`
**Source commit at audit start:** `fc63f9c7a95b887f14e2fd09f785ffc11f7a1a3f`
**Final verdict:** **Advanced Prototype**

## 1. Executive summary

Asystence now has a credible adaptive-orchestration foundation and behaves materially beyond a static chatbot or an isolated AI feature.

The audited system successfully:

- captured immutable tenant-scoped events;
- assembled task, project, dependency, leave, attendance, memory, meeting, goal, review, knowledge, workload, historical-outcome, and permission context;
- generated evidence-backed recommendations;
- converted a completed meeting into an ordered four-step execution plan;
- executed memory creation, task creation, executive-summary generation, and notification through registered capabilities and existing services;
- enforced role, tenant, approval, and step-dependency boundaries;
- learned from accepted, rejected, edited, and ignored recommendations;
- reduced repeated low-value recommendations after negative feedback;
- processed 2,000 queued events with no failures;
- recovered an expired worker lease and retried a dead letter;
- exposed traceable runtime, plan, capability, prediction, learning, workflow, and worker records.

The platform does not yet behave like a fully adaptive enterprise operating system. Its principal task reasoning remains deterministic and narrow. Most rich context is loaded but does not affect action selection. Learning changes one class of behaviourâ€”non-critical notificationsâ€”but does not yet change workflow selection, capability selection, notification timing, approval policy, or broader business reasoning. The AI service reports ready and authenticates locally, but its context-preview flow calls backend routes that do not exist and fails at the service boundary.

The evidence therefore supports **Advanced Prototype**, not enterprise pilot or production readiness for the Adaptive Orchestrator product claim.

## 2. Audit integrity and method

### 2.1 Production exclusion

No production endpoint or production data was used.

The executable harness refuses to start unless both the API and database resolve to `localhost`, `127.0.0.1`, or `::1`. The successful run recorded:

```text
API: http://localhost:5000
Database host: localhost
Database: asystence_dev
Local-only safety gate: passed
```

### 2.2 Reproducible command

```powershell
$env:API_URL='http://localhost:5000'
node --env-file=.env scripts/adaptive-orchestrator-behavioral-audit.mjs
```

### 2.3 Audit remediation performed

The first run exposed a real P0 ordering defect: a new operations action referenced `execution_plan_id` before the plan existed, violating `operations_ai_actions_execution_plan_fk`. The plan header is now persisted before action creation, and the action-backed step is persisted afterward.

The local compose database was also missing the current huddle and enterprise-intelligence migration chain. The compose definition now initializes all required additive schemas. The AI service's local backend URL was corrected from port `3000` to port `5000`, and its internal secret was aligned with the local backend process.

These remediations were necessary to evaluate current behaviour rather than environmental drift. The original defect and its correction remain part of this audit evidence.

## 3. Environment validation

| Gate | Evidence | Result |
|---|---|---|
| Local database isolation | `localhost:5432/asystence_dev`; production-host safety guard active | Pass |
| Database reproducibility | Fresh Docker volume initialized to 164 public tables from repository schema and additive migrations | Pass |
| Backend | `/version` returned HTTP 200 | Pass |
| Frontend | Local Vite page returned HTTP 200 | Pass |
| Frontend build | 2,975 modules transformed; production build completed in 17.13 seconds | Pass |
| AI health | `/health` HTTP 200 | Pass |
| AI readiness | `/ready` HTTP 200; configuration checks true | Partial: readiness does not validate downstream calls |
| Internal AI authentication | Invalid token 403; valid shared secret 200 | Pass |
| AI context assembly | `/ai/chat/preview` failed because expected backend context routes are absent | Fail |
| CORS | Local frontend preflight HTTP 204 with exact allowed origin | Pass |
| Realtime transport | Socket.IO polling handshake HTTP 200 with WebSocket upgrade advertised | Pass |
| Adaptive tests | 10/10 passed | Pass |
| Backend dependency gate | 0 high, 0 critical; 8 moderate Firebase/UUID transitive advisories | Pass with recorded risk |
| Frontend dependency gate | 0 high, 0 critical; 2 moderate Quill advisories | Pass with recorded risk |
| AI dependency gate | 0 vulnerabilities | Pass |

The local stack was adequate for adaptive-runtime evaluation. It was not adequate for a successful AI conversation/context flow because the AI service expects `GET /internal/chat/context`, `GET /internal/tasks/context`, and `GET /internal/attendance/summary`, while the backend does not expose those contracts.

## 4. Realistic enterprise organization

The audit created and later cleaned a medium-sized test organization:

| Entity | Count |
|---|---:|
| People | 24 |
| Executives | 4 |
| Managers | 10 |
| Individual contributors | 10 |
| Departments/functions | 11 |
| Approved leave records | 4 |
| Attendance-day records | 336 |
| Performance reviews | 10 |
| Goals/OKRs | 6 |
| Knowledge articles | 8 |
| Historical decisions/memory entries | 10 |
| Executive digest records | 3 |
| Completed meetings with intelligence digests | 3 |

Functions represented Leadership, Engineering, Operations, Finance, Product, Customer Success, HR, Sales, Support, Quality, and Design. Roles included executives, engineering/product/operations/people/finance/sales/support/customer-success managers, developers, QA engineers, designers, sales, and support personnel.

Post-audit cleanup confirmed zero temporary scenario tasks, zero temporary projects, and zero pending temporary actions. Immutable event and runtime evidence remains locally by design.

## 5. Enterprise scenario results

### 5.1 Distribution

| Domain | Scenarios |
|---|---:|
| Engineering | 15 |
| Product | 15 |
| Operations | 15 |
| HR | 15 |
| Customer Success | 15 |
| Leadership | 15 |
| Enterprise Administration | 15 |
| **Total** | **105** |

The scenario inventory covered release slippage, production incidents, migration risk, customer escalation, sprint risk, leave overlap, access delays, security and compliance, vendor outages, business continuity, roadmap conflicts, executive priorities, renewals, workforce planning, forecast variance, billing, permissions, integration ownership, and data retention.

The majority of scenarios were represented as realistic project/task risks so the same business themes could be repeated consistently before and after learning. A separate completed-meeting event exercised Meeting Intelligence and multi-capability planning. This design provides controlled comparative evidence, but it does not replace future native scenario suites for every leave, attendance, review, goal, sprint, incident, and customer event contract.

### 5.2 Behaviour by phase

| Metric | Phase 1 | Phase 2 |
|---|---:|---:|
| Scenarios | 56 | 49 |
| Captured task events | 126 | 110 |
| Runtime runs | 126 | 110 |
| Recommendations | 112 | 42 |
| Recommendations per scenario | 2.000 | 0.857 |
| Average displayed rule confidence | 0.533 | 0.670 |
| Distinct task action types | 2 | 2 |

After 112 phase-one rejections, recommendation frequency fell by approximately 57% per scenario. The confidence of remaining recommendations increased because the policy suppressed low-acceptance non-critical notifications and retained stronger/riskier recommendations. This is observable behavioural adaptation, not merely signal storage.

## 6. Observe â†’ Context â†’ Reason â†’ Plan â†’ Approve â†’ Execute â†’ Learn

| Stage | Observed evidence | Assessment |
|---|---|---|
| Observe | 105 task-created, 105 task-assigned, 26 task-updated, 7 project-created, one meeting-ended, and adaptive decision events | Works; event breadth remains incomplete |
| Context | 237 task runs; average task context coverage 0.698; project and memory context in all 237 | Materially context-aware |
| Reason | 223/237 task runs contained evidence; 131 used dependency evidence; 16 used approved-leave evidence | Evidence-backed but rule-limited |
| Plan | Meeting created a four-step dependency-ordered plan | Works |
| Approval | Pending direct execution returned 400; non-privileged settings/worker returned 403 | Strong |
| Execute | Memory, task, executive summary, and notification executed through capabilities/services | Works after ordering remediation |
| Outcome | 238 prediction-accuracy signals retained for audited events | Works at basic level |
| Learning | Accepted/rejected/edited/ignored signals persisted and profiles versioned | Works |
| Adapt | Repeated rejection suppressed future notifications | Real but narrow |
| Future decisions | Recommendation rate changed; capability/workflow/timing policy did not | Partial |

## 7. Context evaluation

### 7.1 Measured context use

| Evidence | Task runs |
|---|---:|
| Project context identified | 237/237 |
| Workspace memory present | 237/237 |
| Actionable evidence present | 223/237 |
| Dependency evidence used | 131 |
| Approved-leave evidence used | 16 |
| Previous-outcome context present | 111 |

All five registered providers used for task eventsâ€”event, task, operational graph, workspace intelligence, and workspace memoryâ€”were available in the definitive run.

### 7.2 Context loaded but not decisional

The operational graph loads meetings, goals, reviews, knowledge, workload, attendance, policies, and historical events. The principal task reasoner directly uses task state, due date, dependencies, and approved leave. Goals, reviews, knowledge, workload, meeting history, and executive digest content generally do not alter the task action selected.

There is also schema drift in executive context. `operationalContextGraph.service.js` queries `workspace_digest_runs(period_start, period_end, digest, generated_at)`, while the active local schema contains `summary`, `content`, `status`, and `created_at`. The provider suppresses undefined-column errors as optional-schema absence, making this context silently empty.

**Context verdict:** broad acquisition, narrower relevance and use.

## 8. Reasoning evaluation

### Strengths

- Recommendations cite concrete task status, dates, dependency links, leave windows, or meeting digest provenance.
- No unsupported narrative or fabricated entity was observed.
- Idempotency keys are derived from stable work state.
- Explanation text distinguishes verified facts from unrecorded causes.
- Meeting planning uses the persisted Meeting Intelligence digest.

### Limitations

- Task reasoning consists primarily of overdue, blocked, and unassigned-high-priority rules.
- A workspace score-drop rule and meeting templates are the other principal reasoning branches.
- Only five distinct task reasoning summaries appeared across 237 task runs; eight distinct summaries appeared when load and meeting events were included.
- The label `evidence_constrained_operational_planner_v2` is technically accurate as a planner identifier but must not be interpreted as open-ended AI reasoning.
- Business narratives in scenario descriptions did not materially change action selection when task state was equivalent.

**Reasoning verdict:** trustworthy deterministic decision support, not general enterprise reasoning.

## 9. Planning and orchestration evaluation

The completed-meeting scenario produced this governed plan:

1. `workspace_memory.create` â€” preserve verified meeting outcome.
2. `task.create` â€” create accountable follow-up work.
3. `executive_summary.generate` â€” refresh executive context.
4. `notification.send` â€” notify stakeholders.

Each step depended on the previous step. Execution in dependency order returned HTTP 200 for all four capabilities and produced:

- a new workspace memory entry;
- a follow-up task with a workspace display ID;
- a generated executive summary based on current local work;
- a notification after the prerequisite steps completed.

Task-risk scenarios coordinated two capabilities: notification and Autopilot analysis. The registry is real and extensible, but selection is still encoded in the planner rather than dynamically inferred from registered capability descriptions.

**Orchestration verdict:** genuine for the implemented meeting and task-risk paths; not yet general-purpose.

## 10. Learning and adaptation evaluation

The definitive evidence retained:

| Learning signal | Count |
|---|---:|
| `recommendation.rejected` | 152 |
| `recommendation.accepted` | 6 |
| `recommendation.edited` | 1 |
| `recommendation.ignored` | 1 |
| `execution.succeeded` | 4 |
| `prediction.accuracy` | 238 |

User preference profiles updated their sample count, confidence, version, explanation, and acceptance rate. Signals are tenant scoped and reversible by schema/API design. No cross-workspace signal leak was found.

The actual adaptive policy uses the most specific sufficiently sampled profile and suppresses non-critical `notification.send` recommendations after at least three signals when acceptance probability is at or below 20%. This explains the measured reduction from 2.000 to 0.857 recommendations per scenario.

What did not change:

- capability selection;
- workflow selection;
- notification delivery time;
- approval mode;
- task assignment;
- reasoning rule selection;
- team, department, enterprise, or manager-specific operating behaviour.

The hierarchy supports user, team, project, department, workspace, and enterprise lookups, but the observed feedback path predominantly produced user profiles plus workspace prediction signals. A declared hierarchy is not equivalent to demonstrated adaptation at every scope.

**Learning verdict:** real feedback-driven suppression and prediction evaluation; narrow behavioural effect.

## 11. Workflow engine evaluation

A real active workflow was created with:

```text
WHEN WORKFLOW_TEST_SIGNAL
IF event.metadata.severity equals high
APPROVAL required
THEN notification.send
END
```

Observed step results:

| Step | Status |
|---|---|
| WHEN | succeeded |
| IF | succeeded |
| APPROVAL | succeeded |
| THEN | approval_pending |

The workflow run remained `approval_pending` with a tenant-scoped pending notification action, which is correct. The engine supports waits, resumability, idempotency, versioned definitions, and capability validation. The current UI exposes internal event and capability keys, so it is more suitable for technical administrators than ordinary managers.

## 12. Governance and security review

| Test | Evidence | Result |
|---|---|---|
| Non-privileged runtime settings | HTTP 403 | Pass |
| Non-privileged worker invocation | HTTP 403 | Pass |
| Execute approval-required action before approval | HTTP 400 | Pass |
| Cross-workspace project read | HTTP 404 | Pass |
| Forged workspace header | JWT workspace remained authoritative | Pass |
| Cross-workspace learning leak | 0 records | Pass |
| Invalid AI internal token | HTTP 403 | Pass |
| Valid AI internal token | HTTP 200 | Pass |
| CORS local allowlist | Exact origin returned | Pass |
| Action/plan dependency order | Later step blocked until prerequisite execution | Pass |
| High/critical dependency audit | 0 high, 0 critical in all three Node services | Pass |

The first audit run proved that the execution-plan foreign key was enforced, but also exposed incorrect creation order. The remediation preserves the invariant rather than weakening it.

Security limitations not certified here include penetration testing, SSO/MFA flows, external-provider OAuth, secrets-at-rest inspection, multi-region isolation, and adversarial prompt/tool-injection testing.

## 13. Reliability, recovery, and performance

### 13.1 Load result

| Metric | Result |
|---|---:|
| Enqueued events | 2,000 |
| Completed | 2,000 |
| Failed | 0 |
| Pending after drain | 0 |
| Worker calls | 40 |
| Elapsed | 25.909 seconds |
| Throughput | 77.19 events/second |
| Average queue latency | 13.105 seconds |
| Maximum queue latency | 26.043 seconds |

The latency reflects controlled sequential batch draining rather than a tuned production deployment. It proves correctness and bounded local throughput, not cloud capacity.

### 13.2 Recovery result

- An expired `processing` lease was reclaimed and completed on attempt 2.
- A simulated exhausted dead letter was explicitly retried and completed.
- Latest worker heartbeat was healthy.
- Worker diagnostics recorded one recovered lease and zero failures.

### 13.3 Autonomous observation

The main comparative harness deliberately used bounded manual drains. A separate local run restarted the backend with `ADAPTIVE_RUNTIME_WORKER_ENABLED=true`, created a blocked overdue task, and made zero manual worker calls. The queue item and runtime run completed automatically on attempt 1 and produced four recommendation candidates.

Not certified: multi-node contention, process-kill recovery during capability execution, 24-hour soak, database failover, queue partitioning, or cloud autoscaling.

## 14. UX evaluation

### Strengths

- Recommendations are embedded in Dashboard and Project Tasks rather than requiring a new primary dashboard.
- Empty and unavailable recommendation sections disappear instead of adding dead UI.
- Cards show risk, explanation, evidence, action type, project/task context, and approve/reject/ignore controls.
- Existing card, badge, button, skeleton, spacing, and theme primitives are reused.
- The simple workflow builder uses WHEN/IF/APPROVAL/THEN/END.

### Trust and usability risks

- Each card can display rule confidence, outcome confidence, and acceptance probability simultaneously; this is technically transparent but cognitively heavy.
- The runtime control panel exposes event constants, JSON-style context paths, and capability keys.
- The product still has prominent AI Hub, AI Features, AI Autopilot, Workspace AI, and many â€œAI Insightâ€ labels. This conflicts with the stated goal that intelligence should feel mostly invisible.
- No moderated executive, manager, or developer usability study was performed. Source review and successful build cannot prove human trust.
- The workflow panel contains mojibake separators (`Ã‚Â·`) in source text and needs encoding cleanup.

**UX verdict:** visually integrated and restrained at the recommendation surface; still too technical and AI-branded at the platform level.

## 15. False intelligence findings

| Finding | Observed evidence | Impact | Priority |
|---|---|---|---|
| Deterministic planner presented as broad intelligence | Three principal task rules plus workspace-score and meeting templates | Equivalent task states produce equivalent actions regardless of rich business narrative | P1 |
| Static rule confidence | Base values such as 0.93, 0.90, and 0.96 are hardcoded | Users may read confidence as model calibration | P1 |
| Loaded context is often unused | Goals, reviews, knowledge, workload, and much history are fetched but do not affect task decisions | Cost and appearance of context-awareness exceed actual decision influence | P1 |
| Capability registry does not drive dynamic selection | Planner hardcodes notification, Autopilot, meeting-memory/task/summary/notification paths | New capabilities self-register but are not automatically considered | P2 |
| Learning breadth is overstated | Real adaptation is notification suppression based on acceptance rate | â€œContinuously learning OSâ€ claim exceeds observed behaviour | P1 |
| Ready is configuration-only | AI `/ready` was green while local backend URL and secret were mismatched; context call still fails after correction because contracts are absent | Operators can receive a false green signal | P0 |
| Executive context silently disappears | Digest query uses columns not present in active schema; optional-provider error handling swallows undefined-column errors | Reasoning lacks expected executive context without visible degradation | P0 |
| AI context contract is fictional in current integration | AI calls three absent backend endpoints | AI context/conversation path is not end-to-end ready | P0 |
| AI-centric UX remains | Dedicated AI hubs/pages and repeated AI labels remain | Product philosophy and actual experience diverge | P2 |

## 16. Architecture assessment

### Strong foundations

- clean modular separation between events, context, capabilities, runtime, reasoning, planning, approvals, execution, learning, evaluation, workflows, observability, and UX;
- additive and tenant-scoped schema;
- immutable events and durable queue;
- stable idempotency for actions;
- registered capabilities execute through existing services;
- explicit approval modes and role boundaries;
- reversible learning signals and versioned preference profiles;
- traceable plans, steps, invocations, predictions, outcomes, and heartbeats;
- graceful optional-provider handling across installations.

### Architectural risks

- optional-provider handling suppresses schema errors that should degrade health visibly;
- runtime, action, plan, prediction, invocation, and workflow writes are not one atomic unit;
- task reasoning and plan expansion are coupled to hardcoded capability keys;
- profile selection is simple threshold/rate logic without decay, recency weighting, manager correction semantics, or causal evaluation;
- readiness is not transitive across backend, AI, database, and provider boundaries;
- the evidence suite has broad task scenarios but limited native event-contract scenarios;
- no production-like multi-worker or distributed queue test was performed.

## 17. Competitive position

This comparison uses Asystence's observed local behaviour. Competitor statements are capability descriptions from current official vendor documentation, not independent benchmark results.

| Platform | Officially described position | Asystence observed position |
|---|---|---|
| Microsoft Copilot Studio | Generative orchestration can select tools, topics, and agents from events; agent flows add deterministic workflows and approvals. [Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-copilot-studio/faqs-generative-orchestration) | Stronger transparency in this audited task/people graph; materially weaker dynamic planning and connector ecosystem |
| Atlassian Rovo | Agents use Jira/Confluence and connected knowledge, edit work items/pages, and can run from automation triggers. [Atlassian Support](https://support.atlassian.com/rovo/docs/agents/) | Comparable native work embedding; weaker enterprise search breadth and agent customisation; stronger native attendance/leave context potential |
| ServiceNow | AI Agent Orchestrator, control tower, unified workflow/data, and autonomous cross-department execution are described as core platform capabilities. [ServiceNow](https://www.servicenow.com/uk/platform.html) | Far behind operational maturity, control-tower breadth, connectors, and proven scale |
| Salesforce Agentforce | Hybrid reasoning, Data 360 context, Flow/MuleSoft orchestration, MCP/A2A, governance, and observability. [Salesforce](https://www.salesforce.com/platform/agentforce-platform) | More inspectable and product-specific locally; far behind data fabric, ecosystem, multi-agent, and enterprise deployment maturity |
| ClickUp Brain | Brain and Super Agents are described as workspace-contextual, multi-step, memory-backed, and improving from interaction. [ClickUp Help](https://help.clickup.com/hc/en-us/articles/12578085238039-What-is-ClickUp-Brain-AI) | Similar contextual-work ambition; weaker conversational/agent breadth and proven learning; stronger auditable deterministic action evidence in this test |
| Asana AI | AI Studio and Smart Workflows are positioned as no-code coordination for human-agent work. [Asana](https://investors.asana.com/node/12041/pdf) | Similar workflow direction; current Asystence builder is more technical and its adaptive scope is narrower |
| monday AI | Agents are described as continuously monitoring work, making contextual decisions, executing end-to-end, and exposing reasoning logs within permissions. [monday Support](https://support.monday.com/hc/en-us/articles/33347027353746-AI-Agents-on-monday-com) | Similar governance intent; observed Asystence remains deterministic and less autonomous/dynamic |

### Relative strengths

- unusually direct combination of delivery data with attendance, leave, reviews, goals, meetings, memory, and executive intelligence;
- strong evidence provenance and inspectable SQL-backed execution history;
- clear tenant scope and human approval model;
- capability execution reuses the existing work platform instead of creating a parallel agent database;
- architecture can evolve without replacing existing product modules.

### Relative weaknesses

- no demonstrated generative/dynamic capability planning;
- smaller capability and connector ecosystem;
- no mature multi-agent delegation or control tower;
- narrow observed learning effect;
- incomplete AI/backend service contract;
- no independent enterprise-scale, compliance, or availability evidence.

### Potential differentiation

Asystence's strongest defensible direction is not â€œanother general agent builder.â€ It is a transparent operational intelligence layer that combines work execution and people-availability evidence, then proposes governed actions inside the same product. That is differentiated only if the currently loaded people, knowledge, outcome, and executive context begins to influence decisions measurably.

## 18. Enterprise readiness scorecard

| Dimension | Score / 100 | Evidence-based assessment |
|---|---:|---|
| Reliability | 76 | Clean scenario run, retries, lease recovery; no soak/HA evidence |
| Scalability | 70 | 77.19 events/s locally; no distributed/cloud capacity evidence |
| Security | 78 | Tenant, role, CORS, internal auth, dependency gates pass; no penetration test |
| Governance | 86 | Approval, role, tenant, dependency order, audit history all enforced |
| Context awareness | 69 | Broad graph and 0.698 task coverage; several sources unused or silently empty |
| Operational intelligence | 61 | Useful task and meeting actions; narrow business interpretation |
| Decision quality | 64 | Evidence-based and safe; limited action variety |
| Reasoning quality | 55 | Explainable deterministic rules, not adaptive enterprise reasoning |
| Learning quality | 63 | Real versioned feedback and prediction records; simple acceptance model |
| Adaptation | 60 | Measured 57% recommendation-rate reduction; narrow suppression only |
| Workflow quality | 74 | Versioned DSL and real approval-pending run; technical UX and limited test breadth |
| Observability | 84 | Runs, plans, steps, invocations, predictions, signals, queue, heartbeats |
| Maintainability | 72 | Modular design; schema drift and non-atomic write chain are risks |
| Extensibility | 80 | Registries and additive layers are strong; planner selection remains hardcoded |
| User trust | 69 | Evidence and approvals help; confidence clutter and false-ready issue hurt |
| Executive trust | 61 | Executive summary executes; executive context provider is schema-drifted |
| Manager experience | 68 | Contextual cards work; workflow setup is too technical |
| Developer experience | 74 | Reproducible local stack and harness; many schemas/contracts require coordination |
| **Overall enterprise readiness** | **69** | **Advanced Prototype** |

## 19. Gap analysis

| Original vision | Current behaviour | Evidence | Gap / impact | Recommendation | Priority |
|---|---|---|---|---|---|
| Every meaningful action becomes an event | Strong task/project capture; one meeting event; limited native scenario breadth | Event coverage table | Leave/review/goal/incident behaviour not proven | Add contract-level behavioural suites and event emitters for every declared domain event | P1 |
| Rich enterprise context drives decisions | Context graph is broad | 237 task runs; project/memory 237; dependency 131; leave 16 | Much loaded context is not decisional | Add evidence-to-decision tests for goals, reviews, knowledge, workload, meetings, outcomes, and executive summaries | P1 |
| Capability registry enables extensible orchestration | Registry and service execution work | Four meeting capabilities executed | Planner hardcodes choices | Introduce constrained capability scoring/planning with allowlists, contracts, and evaluation | P2 |
| Learning changes future behaviour broadly | Notification suppression is real | 2.000 â†’ 0.857 recommendations/scenario | No timing/workflow/capability/approval adaptation | Add explicit policy adapters and counterfactual evaluation per behaviour class | P1 |
| Personalization across all scopes | Hierarchy exists | User profiles observed; zero leaks | Team/department/enterprise behaviour not demonstrated | Generate scope-specific signals and enforce precedence/decay tests | P1 |
| AI service is first-class | Health/auth work | Health 200, auth 200 | Context-preview backend contracts absent | Implement/version internal context contracts or change AI to supported endpoints; add transitive readiness | P0 |
| Explainable confidence | Three confidence dimensions exposed | Recommendation UI | Hardcoded rule confidence may be misread as calibrated probability | Rename rule confidence to rule strength; calibrate prediction/outcome confidence against outcomes | P1 |
| Invisible intelligence | Recommendations are contextual | Dashboard/project embedding | AI hubs and technical runtime controls add clutter | Move runtime controls to admin settings and reduce AI branding in daily navigation | P2 |
| Enterprise-safe operations | Governance and queue recovery work | 403/400/404, 2,000/2,000, retry recovery | No distributed/soak evidence | Run multi-worker, kill/retry, 24-hour soak, and cloud canary certification | P1 |

## 20. P0-P3 improvement roadmap

### P0 â€” correctness and truthful readiness

1. Implement or replace the AI service's missing backend context contracts.
2. Make `/ready` perform authenticated backend, database, and provider probes with bounded timeouts.
3. Correct the `workspace_digest_runs` executive-context query and surface provider schema failures in adaptive health.
4. Add a database integration test proving plan-header â†’ action â†’ plan-step creation order.
5. Add a release gate that fails when any declared context provider is unavailable due to schema mismatch.

### P1 â€” enterprise pilot prerequisites

1. Add native behavioural scenarios for leave, attendance, goals, reviews, sprints, incidents, knowledge, notifications, customer escalation, and score changes.
2. Make goals, reviews, knowledge, workload, previous outcomes, and executive context affect decisions with explicit evidence.
3. Expand adaptation beyond suppression to ranking, timing, capability choice, approval recommendations, and workflow selection.
4. Demonstrate user/team/project/department/workspace/enterprise isolation and precedence with controlled feedback cohorts.
5. Calibrate prediction confidence from measured outcomes and apply recency/decay.
6. Run multi-worker contention, crash recovery during execution, 24-hour soak, and cloud-like load tests.
7. Conduct moderated executive, manager, and contributor trust/usability studies.

### P2 â€” adaptive orchestration maturity

1. Add constrained dynamic planning over registered capabilities without bypassing contracts or approvals.
2. Introduce plan-level transactions/compensation for partial multi-step failures.
3. Add causal outcome evaluation rather than acceptance-only optimisation.
4. Replace technical event/path/capability fields in the workflow UI with business-language templates.
5. Consolidate AI navigation and move intelligence into contextual surfaces.
6. Add richer connector and external knowledge support with explicit tenant controls.

### P3 â€” best-in-class direction

1. Add governed multi-agent delegation with a control-plane view.
2. Build versioned enterprise evaluation datasets and regression scorecards per domain.
3. Support organisation-specific policies, simulation, dry-run impact analysis, and reversible policy rollout.
4. Publish independent security, availability, scale, and model-risk evidence.

## 21. Final verdict

**Advanced Prototype**

Asystence has crossed the line from a basic workflow prototype into a real, observable, governed adaptive-orchestration foundation. It can observe local work, assemble meaningful context, plan and execute a cross-capability meeting outcome, learn from feedback, suppress repeated low-value recommendations, enforce tenant and approval boundaries, and recover queued work under load.

It has not crossed the line into an enterprise pilot-ready adaptive operating system because the AI service context path is broken, rich context is only partially used, reasoning remains narrow and deterministic, adaptation affects too few decisions, and distributed reliability and human trust have not been certified.

The next engineering pass should begin with the P0 contract/readiness/schema issues, then prove broader context-to-decision influence and scoped adaptation before making an enterprise-pilot claim.
