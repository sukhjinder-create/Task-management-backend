# Asystence Adaptive Orchestrator

## End-to-End Behavioural Validation and Enterprise Certification

**Audit date:** 30 June 2026  
**Environment:** Live production  
**Backend revision:** `asystence-api-00288-b4g`  
**Backend commit:** `8892125abfccc777af5291ebc4cef14fc4c79f48`  
**Production workspace:** `apyhub`  
**Primary audit marker:** `enterprise-audit-1782835523383`  
**Auditor verdict:** **Functional Prototype**

---

## 1. Executive conclusion

Asystence has not yet achieved the original vision of a continuously adaptive enterprise operating system.

It has achieved a credible technical foundation:

- immutable operational events;
- a tenant-scoped event queue;
- runtime traces;
- deterministic recommendations;
- an approval/action record;
- capability registration;
- workflow primitives;
- learning and prediction records;
- contextual recommendation cards;
- auditable production execution.

However, the live product currently behaves primarily as:

> An event-backed deterministic task-risk recommendation engine with workflow infrastructure and AI-adjacent product integrations.

It does not yet behave as:

> A continuously observing system that understands rich enterprise context, coordinates multiple platform capabilities, adapts future decisions from outcomes, and autonomously reduces operational work.

The most important behavioural findings are:

1. Production captures events but does not process them autonomously. The adaptive worker is disabled.
2. Seventy-seven realistic scenarios produced only one action type: `notify_supervisors`.
3. Rich scenario context such as dependencies, meetings, leave, historical decisions, customers, and previous outcomes did not influence reasoning.
4. After 119 recommendation rejections, the next 21 scenarios produced recommendations at essentially the same confidence and a slightly higher rate.
5. The learning layer records feedback and predicts likely rejection, but does not materially change recommendation generation or routing.
6. An action marked `approval_required` can be executed directly while still pending, bypassing the approval state.
7. An executive meeting probe generated suggested tasks in the AI feature, but the orchestrator did not update tasks, memory, executive summaries, projects, or additional workflows.
8. The UI is contextually embedded and visually restrained, but it displays static rule confidence as if it represented learned decision confidence.

The direct answer to the audit question is:

> We did not merely build a chatbot. We built a useful event, workflow, approval, and observability foundation. But we also did not yet build the envisioned adaptive enterprise orchestrator. The current behaviour is much closer to a workflow/recommendation engine with AI integrations attached.

---

## 2. Verdict

### Selected verdict: Functional Prototype

| Possible verdict | Assessment |
|---|---|
| Not Ready | Too harsh. Core runtime paths, isolation, auditability, execution, and UI integration work. |
| **Functional Prototype** | **Supported by evidence. The integrated foundation works, but adaptive and enterprise-operating-system behaviour is not yet present.** |
| Advanced Prototype | Not supported because autonomous observation, deep context, multi-capability orchestration, and behavioural adaptation are absent. |
| Enterprise Pilot Ready | Not supported because approval governance can be bypassed and the runtime worker is disabled. |
| Enterprise Production Ready | Not supported for the Adaptive Orchestrator as a product claim. |
| Best-in-Class Enterprise Platform | Not supported. |

This verdict does not reverse the prior production certification of the deployed software release. The platform is deployed and technically operational. This report evaluates whether the Adaptive Orchestrator fulfils its product vision, which is a different and materially higher standard.

---

## 3. Audit method

The audit began with production behaviour, not implementation review.

### 3.1 Production interactions

The audit used authenticated production APIs and a real test workspace to:

- create seven temporary domain projects;
- create and update 77 realistic operational scenarios;
- allow normal HTTP event capture to create immutable events;
- observe the queue before invoking any worker;
- process events through the production adaptive worker endpoint;
- inspect runtime context, reasoning, recommendations, predictions, learning, and capability invocation records;
- reject phase-one recommendations;
- repeat similar patterns in phase two;
- approve a controlled action;
- execute a controlled notification action;
- replay an event twice;
- reverse a learning signal;
- attempt a forged workspace-header override;
- run a direct executive-meeting scenario;
- run bounded concurrent status requests;
- clean all temporary projects, tasks, and pending actions.

### 3.2 Scenario distribution

| Operating domain | Scenarios |
|---|---:|
| Engineering | 11 |
| Product | 11 |
| Operations | 11 |
| HR | 11 |
| Customer Success | 11 |
| Leadership | 11 |
| Enterprise Administration | 11 |
| **Total** | **77** |

The scenarios included:

- release and sprint slippage;
- blocked dependencies;
- production incidents;
- owner leave and attendance concerns;
- security and compliance reviews;
- customer escalations and renewals;
- roadmap and executive-priority conflicts;
- workload imbalance and performance-review delays;
- procurement and vendor outages;
- billing and plan-boundary issues;
- permission and audit-log concerns;
- repeated ownership and manager overrides.

The exact scenario inventory and executable evidence harness are in:

`scripts/adaptive-orchestrator-behavioral-audit.mjs`

### 3.3 Learning phases

| Phase | Scenarios | Purpose |
|---|---:|---|
| Phase 1 | 56 | Establish baseline behaviour and reject generated recommendations. |
| Phase 2 | 21 | Repeat override and ownership patterns after extensive negative feedback. |

### 3.4 Cleanup

Post-audit verification:

| Item | Remaining |
|---|---:|
| Temporary audit tasks | 0 |
| Temporary audit projects | 0 |
| Pending audit actions | 0 |
| Pending queue items after final drain | 0 |

Immutable audit events and runtime traces remain by design.

---

## 4. High-level evidence

### 4.1 Scenario results

| Metric | Phase 1 | Phase 2 |
|---|---:|---:|
| Scenarios | 56 | 21 |
| Runtime task-update runs | 56 | 21 |
| Recommendations | 119 | 49 |
| Recommendations per scenario | 2.13 | 2.33 |
| Average displayed recommendation confidence | 0.932 | 0.930 |
| Distinct action types | 1 | 1 |

The only generated action type was:

`notify_supervisors`

The only invoked capability was:

`notification.send`

### 4.2 Runtime performance

For the audit-correlated event set:

| Metric | Result |
|---|---:|
| Runtime runs | 162 |
| Failed runs | 0 |
| Average runtime duration | 783 ms |
| P50 runtime duration | 258 ms |
| P95 runtime duration | 1,777 ms |
| Maximum runtime duration | 1,807 ms |

Bounded read-only concurrency probe:

| Metric | Result |
|---|---:|
| Requests | 50 |
| Concurrency | 10 |
| Successful | 50 |
| P50 | 438 ms |
| P95 | 1,377 ms |
| Maximum | 1,776 ms |

This is a useful smoke result, not a 100,000-user scalability certification.

---

## 5. Original vision versus current behaviour

### 5.1 Continuous observation

**Original vision**

The system continuously observes work and reacts to operational events.

**Current behaviour**

- Events are captured automatically.
- A newly generated task event remained `pending`, with `attempts=0`, throughout a 12-second observation period.
- Phase-one events required 123 seconds of explicit `/adaptive/worker/run-once` calls.
- Phase-two events required 47 seconds of explicit worker calls.
- Cleanup left 79 queued events until the worker endpoint was manually called twice.
- Production health reported `worker.enabled=false`.
- Deployment configuration explicitly sets `ADAPTIVE_RUNTIME_WORKER_ENABLED=false`.

**Gap**

The event platform is live, but the Adaptive Runtime is not continuously operating.

**Enterprise impact**

Recommendations and workflows do not occur unless an administrator or external scheduler manually invokes the worker. Event backlog can grow silently.

**Recommendation**

Deploy a dedicated, durable worker with queue-lag monitoring, concurrency control, retries, and dead-letter handling.

---

### 5.2 Event platform

**Original vision**

Meaningful operational actions become versioned, ordered, replayable, reliable, and auditable events.

**Current behaviour**

Strengths:

- events are immutable;
- queue records are tenant-scoped;
- queue claims use database locking;
- failed processing has retry/backoff fields;
- action idempotency prevented duplicate recommendations during replay;
- no failed runtime runs occurred during the audit;
- correlation and trace identifiers are recorded.

Observed weaknesses:

- `POST /tasks/:projectId` produced `TASKS_CREATED` with entity type `tasks`, not canonical `TASK_CREATED` with entity type `task`;
- all 77 task-create events therefore produced no task context and no recommendation;
- event replay produced one additional runtime run, although it did not duplicate actions;
- the audit workspace contained no observed `MEETING_ENDED`, `WORKSPACE_SCORE_CHANGED`, `SPRINT_CLOSED`, `LEAVE_APPROVED`, `REVIEW_UPDATED`, or `GOAL_UPDATED` events;
- generic HTTP event naming can produce resource-name drift;
- production health says `available` even when the worker is disabled.

**Gap**

The store and queue are credible, but event contracts are not yet sufficiently canonical or comprehensively proven.

**Enterprise impact**

Incorrect entity types prevent context providers from loading data. Important events can be captured but become behaviourally inert.

**Recommendation**

Replace route-derived event inference with explicit domain event publication from application services. Enforce event schemas in contract tests.

---

### 5.3 Context awareness

**Original vision**

An event gathers project, task, dependencies, meetings, memory, knowledge, attendance, reviews, goals, permissions, preferences, historical behaviour, and prior outcomes.

**Current behaviour**

Across 77 task-update runtime runs:

| Context measure | Result |
|---|---:|
| Task context present | 77/77 |
| Project context present | 0/77 |
| Non-empty workspace memory | 0/77 |
| Reasoning mentioning dependencies | 0/77 |
| Reasoning mentioning leave | 0/77 |
| Reasoning mentioning historical outcomes | 0/77 |
| Reported average context coverage | 1.000 |

The loaded source keys were limited to:

- event;
- task;
- workspace intelligence;
- workspace memory.

The platform reported 100% coverage because every registered applicable provider returned successfully. It did not measure coverage against the information required to make the decision.

The scenario descriptions explicitly contained dependency, customer, leave, previous-outcome, and ownership context. None of it affected reasoning.

**Gap**

Context coverage is technically complete relative to a small provider set, but operationally incomplete relative to the original vision.

**Enterprise impact**

The platform can identify that a task is overdue, but cannot explain its delivery chain, organizational impact, or likely resolution.

**Recommendation**

Build an operational context graph with typed evidence requirements per decision.

---

### 5.4 Reasoning and decision quality

**Original vision**

The orchestrator reasons over enterprise evidence, explains why, estimates impact, and selects meaningful actions.

**Current behaviour**

The 77 task-update scenarios produced only three distinct reasoning summaries:

- one evidence-backed recommendation;
- two evidence-backed recommendations;
- three evidence-backed recommendations.

The actual rules were:

- overdue task;
- blocked task;
- high-priority unassigned task.

Static confidence values were:

- overdue: `0.93`;
- blocked: `0.90`;
- unassigned high priority: `0.96`.

The reasoner correctly avoids hallucinating unsupported facts. That is a genuine strength.

However, it does not:

- identify causal dependencies;
- calculate release impact;
- identify relevant meetings or decisions;
- consider leave or attendance;
- use historical outcomes;
- evaluate manager behaviour;
- compare alternative actions;
- select among multiple platform capabilities;
- produce domain-specific decisions.

**Gap**

The system is performing deterministic risk classification, not enterprise reasoning.

**Enterprise impact**

Recommendations are safe and understandable but too shallow to create substantial operational leverage.

**Recommendation**

Preserve deterministic evidence gates, then add an evidence-constrained planning layer that can compare options and explicitly cite each supporting source.

---

### 5.5 Orchestration

**Original vision**

The runtime coordinates Meeting Intelligence, Workspace Intelligence, Executive Summary, Autopilot, Notifications, Knowledge, Reports, Tasks, Search, Memory, Testing Agent, and future capabilities.

**Current behaviour**

Eight capabilities are registered:

- notification send;
- task creation;
- workspace-memory creation;
- Autopilot analysis;
- Testing Agent task run;
- Executive Summary generation;
- Workspace Intelligence read;
- Huddle action-to-task promotion.

Across the 77-scenario audit:

| Capability behaviour | Result |
|---|---:|
| Capability invocations | 168 |
| Distinct capabilities invoked | 1 |
| Capability | `notification.send` |
| Invocation status | `proposed` |
| Other registered capabilities selected | 0 |

A controlled direct execution successfully:

- changed the action to `executed`;
- recorded an execution timestamp;
- notified one workspace lead;
- created a notification record.

The execution infrastructure works. The planning layer does not use it broadly.

**Gap**

Capabilities are registered, but orchestration is effectively hardcoded to notifications.

**Enterprise impact**

The platform tells people to review work rather than coordinating the work itself.

**Recommendation**

Introduce policy-bound capability planning and outcome-aware multi-step plans.

---

### 5.6 Executive meeting scenario

Production input described:

- a three-day release delay;
- a blocked API integration;
- a dependent mobile launch;
- an owner on leave;
- a required manager reassignment;
- a Customer Success notification;
- a project update;
- a workspace-memory update;
- an Executive Summary refresh.

Observed behaviour:

| Behaviour | Result |
|---|---|
| Meeting-notes endpoint | HTTP 200 |
| Tasks suggested by AI feature | 5 |
| Tasks automatically created | 0 |
| Captured event | `AI_FEATURES_CREATED` |
| Event entity type | `ai_features` |
| Runtime context | event, workspace intelligence, empty workspace memory |
| Selected capabilities | none |
| Recommendations | 0 |
| Memory entries created | 0 |
| Tasks created | 0 |
| Actions created | 0 |
| Executive Summary refresh | not triggered |
| Project update | not triggered |

Runtime explanation:

`No actionable recommendation met the deterministic evidence threshold for AI_FEATURES_CREATED.`

**Conclusion**

Meeting Intelligence and the Adaptive Orchestrator do not yet behave as one integrated product.

---

### 5.7 Approval and execution

**Original vision**

Actions are automatic, approval-required, or manual-only, with enterprise-safe governance.

**Current behaviour**

Positive:

- approval and rejection decisions are recorded;
- approval creates learning and prediction outcomes;
- execution is auditable;
- a controlled notification executed successfully.

Critical issue:

- a pending action with `approval_mode=approval_required` was sent directly to `/execute`;
- it executed successfully without first being approved;
- the result notified a real workspace lead;
- the frontend exposes `Run` and `Approve` side by side.

The execution service rejects only already executed or rejected actions. It does not require `status=approved` for approval-required actions.

**Gap**

Approval is represented in the data model and UI, but not enforced as an execution invariant.

**Enterprise impact**

This is a release-blocking governance issue for any claim of enterprise autonomous execution.

**Recommendation**

Require an approved state and an approved actor before any approval-required capability can execute. Add transactional enforcement and permission tests.

---

### 5.8 Learning and adaptation

**Original vision**

Accept, reject, edit, ignore, and outcome signals measurably improve future decisions.

**Current behaviour**

The learning system successfully records:

- recommendation accepted;
- recommendation rejected;
- recommendation ignored;
- recommendation edited;
- execution succeeded;
- prediction accuracy.

The audit produced:

| Learning measure | Result |
|---|---:|
| Phase-one rejected recommendations | 119 |
| Evaluated predictions associated with audit actions | 120 |
| Phase-two average displayed confidence | 0.930 |
| Phase-one average displayed confidence | 0.932 |
| Phase-two recommendations per scenario | 2.33 |
| Phase-one recommendations per scenario | 2.13 |

After extensive rejection:

- recommendation confidence did not materially fall;
- recommendation frequency did not fall;
- action selection did not change;
- no alternative capability was selected;
- no notification preference was inferred;
- no domain-specific behaviour emerged.

The prediction layer did adapt. It eventually assigned a 5% acceptance probability. That probability was stored in `adaptive_predictions`.

However:

- the UI continued to show approximately 90–96% recommendation confidence;
- the low learned acceptance probability did not suppress or alter the recommendation;
- project-level preference profiles were created but are not selected by the future acceptance-prior function;
- future routing uses a user profile or workspace profile, not the project profile that received the rejection feedback.

Learning reversibility was proven:

- a project-scoped rejection signal was reversed through the production API;
- status changed from `active` to `reversed`;
- the profile sample count changed from 24 to 23.

**Gap**

Learning exists as telemetry and prediction, not as adaptive product behaviour.

**Enterprise impact**

The system can measure that users dislike its recommendations while continuing to generate essentially the same recommendations.

**Recommendation**

Make learned policy an input to generation, ranking, channel selection, timing, approval mode, and capability choice.

---

### 5.9 Continuous evaluation

**Original vision**

Prediction, actual outcome, confidence update, learning update, and future improvement form a closed loop.

**Current behaviour**

The first four stages exist:

- prediction is recorded;
- acceptance or rejection is recorded;
- a Brier score is calculated;
- a learning signal is written.

The final stage is missing:

- future recommendation behaviour did not improve.

The reported average prediction accuracy became high primarily because the system learned that recommendations would be rejected. That is valid statistical evaluation, but not evidence that operational recommendations became better.

**Recommendation**

Separate:

- acceptance prediction;
- recommendation correctness;
- execution success;
- operational outcome improvement;
- user effort saved.

Evaluate all five independently.

---

### 5.10 Personalization and workspace isolation

**Original vision**

Behaviour adapts at user, team, project, department, workspace, and enterprise scopes without cross-tenant leakage.

**Current behaviour**

Positive:

- learning signals are workspace-scoped;
- the audit found zero cross-workspace learning leaks;
- a forged `x-workspace-id` header could not override the JWT workspace;
- project, user, and workspace preference records exist.

Weaknesses:

- team, department, and enterprise behavioural adaptation were not observed;
- project profiles are not consumed by future recommendation priors;
- different domain projects did not develop materially different behaviour;
- workspace-to-workspace adaptation could not be certified with only one authorized test workspace.

**Recommendation**

Implement explicit precedence and conflict resolution:

`user → team → project → department → workspace → enterprise default`

Every decision should record which scoped preference influenced it.

---

### 5.11 Experience and usability

**Original vision**

AI is invisible, contextual, simple, and naturally embedded.

**Current behaviour**

Strengths:

- recommendations appear inside Dashboard and Project views;
- no separate AI dashboard was introduced;
- cards use the existing design system;
- recommendations disappear when empty;
- approve, reject, run, and ignore actions are directly available;
- explanation and evidence are visible.

Weaknesses:

- the UI labels static rule certainty as “confidence” while a separate learned acceptance confidence may be 5%;
- project copy claims recommendations reuse task, sprint, and intelligence data, although sprint context is not loaded and project context was absent from task-event runs;
- `Run` can bypass required approval;
- no workflow builder was found in the frontend;
- no user-facing adaptive settings, runtime history, learning history, reversal, or evaluation experience was found;
- users cannot see that the worker is disabled;
- users may interpret repeated notifications as intelligence rather than deterministic rules.

**Conclusion**

The visual integration is promising. The behavioural truth presented by the UI needs correction.

---

## 6. False intelligence findings

| Finding | Why it appears intelligent | Actual behaviour | Severity |
|---|---|---|---|
| Static confidence displayed as learned confidence | Cards show 90–96% confidence | Values are hardcoded rule confidence; learned acceptance probability reached 5% but was not displayed or applied | High |
| Context coverage of 100% | Runtime reports complete context | It means all four selected providers returned, not that required enterprise context was present | High |
| “Context-aware” project recommendations | UI states task, sprint, and intelligence data are reused | Sprint context was absent; project context was absent from task runs | High |
| Learning profiles | Profiles and versions visibly evolve | Phase-two action type, rate, and confidence remained effectively unchanged | Critical |
| Capability registry | Eight capabilities suggest broad orchestration | Only notification sending was selected in 77 scenarios | High |
| Approval requirement | Action records say approval required | Pending action executed directly without approval | Critical |
| Available health status | `/adaptive/status` reports available | Worker is disabled and events remain pending without manual processing | High |
| Evidence-backed reasoning | Evidence arrays are populated | Evidence is limited to status, due date, priority, and assignment | Medium |
| Workspace memory source | Source is marked available | Memory count was zero in every audited task run | Medium |
| Event completeness | HTTP actions generate events | Task creation used a noncanonical plural event and wrong entity type | High |
| Continuous evaluation | Accuracy metrics improve | Accuracy measures predicted rejection, not improved operational outcomes | High |
| Adaptive enterprise behaviour | Cross-domain scenarios were accepted | All seven domains received the same narrow notification behaviour | Critical |

---

## 7. Enterprise differentiators

### 7.1 What is genuinely differentiated

Asystence has the ingredients for a defensible position:

- tasks, projects, attendance, leave, reviews, goals, Huddles, Meeting Intelligence, Workspace Intelligence, Autopilot, Testing Agent, memory, chat, and executive reporting exist in one product;
- events, actions, predictions, learning, and provenance are tenant-scoped and auditable;
- deterministic evidence gates reduce hallucination risk;
- the UI embeds recommendations in operational surfaces rather than creating a separate chatbot destination;
- the platform can eventually connect human-work signals that competitors often access through separate products.

The potential differentiator is:

> A native operational graph connecting delivery, people, meetings, intelligence, and execution with explainable enterprise controls.

That potential is not yet realized by current orchestration behaviour.

### 7.2 Competitive position

Official product positioning reviewed on 30 June 2026 indicates that major competitors already emphasize combinations of:

- cross-application enterprise grounding;
- agents that use tools and take actions;
- no-code agent or workflow builders;
- centralized agent governance;
- enterprise search and knowledge;
- permission-aware execution;
- multi-agent coordination.

| Competitor | Current market strength | Asystence position |
|---|---|---|
| Microsoft 365 Copilot and Copilot Studio | Agents grounded in Microsoft work data with tools, connectors, actions, and enterprise administration | Asystence is more operationally focused but currently much narrower in context and action planning |
| Atlassian Rovo | Search, chat, and agents grounded across Atlassian and connected SaaS work | Asystence lacks comparable cross-product knowledge retrieval and agent selection |
| Asana AI Studio | No-code AI-powered workflows embedded in work management | Asystence has backend workflow primitives but no comparable user-facing builder |
| monday AI | AI agents and workflow automation integrated into work-management products | Asystence currently generates one operational action type |
| ServiceNow AI Agents and AI Control Tower | Enterprise workflow execution plus centralized governance and monitoring of agents | Asystence lacks a mature governance/control-tower experience |
| ClickUp Brain and Super Agents | Workspace-aware agents, triggers, permissions, tools, and connected productivity context | Asystence has stronger explainable event primitives but substantially less behavioural breadth |

### 7.3 Would an enterprise choose Asystence today?

For broad autonomous enterprise orchestration: **No.**

For a controlled pilot of explainable task-risk recommendations inside an existing Asystence deployment: **Potentially, after the P0 approval and worker issues are fixed.**

For a strategic platform investment: **Possibly**, because the integrated operational data model could become differentiated if the adaptive loop is completed.

---

## 8. Capability scores

| Capability | Score / 100 | Evidence |
|---|---:|---|
| Architecture | 72 | Modular runtime, queues, providers, capabilities, approvals, workflows, learning, evaluation, and observability |
| Adaptive Runtime | 42 | Processes events reliably when invoked; production worker disabled |
| Event Platform | 55 | Immutable and replayable with idempotent actions; event naming/entity drift and incomplete observed coverage |
| Context Builder | 30 | Reliable provider execution but narrow operational graph |
| Capability Registry | 62 | Eight useful registered capabilities; selection remains hardcoded |
| Reasoning | 22 | Safe and explainable deterministic rules, but no enterprise causal reasoning |
| Learning | 28 | Signals, reversal, profiles, and predictions work; future behaviour does not improve |
| Orchestration | 24 | One capability and one action type across 77 scenarios |
| Workflow Quality | 48 | Versioned workflow primitives exist; no user builder or broad behavioural proof |
| Enterprise UX | 52 | Good contextual placement; misleading confidence and missing admin experiences |
| Context Awareness | 25 | Task state is understood; dependencies, people, meetings, history, and knowledge are not |
| Decision Quality | 30 | Correct simple task-risk decisions; little operational leverage |
| Explainability | 55 | Clear evidence for simple rules; incomplete evidence represented as complete coverage |
| Personalization | 18 | Scoped profiles exist but do not materially affect recommendations |
| Observability | 58 | Strong data traceability and APIs; weak health semantics and no complete frontend control plane |
| Security | 52 | Strong tenant isolation; critical approval bypass |
| Scalability | 25 | Bounded read smoke passed; sequential disabled worker and no enterprise load proof |
| Maintainability | 70 | Clear modules and service reuse; reasoner and event mapping are hardcoded |
| Operational Intelligence | 28 | Workspace score is available but does not drive rich coordinated actions |
| **Overall Enterprise Readiness** | **35** | Functional foundation, not yet safe or adaptive enough for enterprise orchestration claims |

---

## 9. Prioritized improvement roadmap

## P0 — Required before an enterprise pilot

| Recommendation | Business value | Enterprise impact | Complexity | Risk | Estimated effort | Expected UX improvement |
|---|---|---|---|---|---|---|
| Enforce approval state before execution | Prevents unauthorized autonomous actions | Restores trust and governance | Low–medium | High if delayed | 2–4 engineering days | “Approve” and “Run” behave predictably |
| Deploy a durable autonomous worker | Makes the product actually observe and react | Eliminates silent queue backlog | Medium | High operational risk | 2–3 engineering weeks | Recommendations arrive without admin intervention |
| Canonicalize event contracts at service boundaries | Ensures every event loads correct context | Prevents inert or misclassified events | Medium | Medium | 1–2 engineering weeks | More consistent and timely recommendations |
| Separate rule confidence, acceptance probability, and outcome confidence | Makes intelligence claims truthful | Reduces executive and user mistrust | Low–medium | Medium | 1 engineering week | Users understand what each score means |
| Correct health semantics and add queue-lag alerts | Makes failures visible | Improves operational ownership | Low | Medium | 3–5 engineering days | Admins can see whether the runtime is actually active |
| Add P0 regression tests for pending-action execution | Prevents governance regression | Required for enterprise controls | Low | Low | 2–3 engineering days | No visible change; major safety improvement |

## P1 — Required to become an advanced prototype

| Recommendation | Business value | Enterprise impact | Complexity | Risk | Estimated effort | Expected UX improvement |
|---|---|---|---|---|---|---|
| Build a typed operational context graph | Enables meaningful decisions instead of alerts | Connects tasks, projects, sprints, dependencies, people, meetings, knowledge, memory, and outcomes | High | Medium | 6–10 weeks, 2–3 engineers | Recommendations explain complete operational impact |
| Apply learned policy to ranking, suppression, timing, and capability choice | Makes feedback visibly improve the system | Reduces alert fatigue and repeated rejection | High | Medium | 4–6 weeks | Users see fewer, more relevant recommendations |
| Add policy-bound multi-capability planning | Converts recommendations into coordinated work | Unlocks task, memory, summary, Autopilot, Testing Agent, and Huddle execution | High | High | 6–10 weeks | One approval can coordinate several existing tools |
| Build the simple WHEN/IF/THEN/WAIT/APPROVAL UI | Makes workflow capability usable | Enables nontechnical administrators | Medium–high | Medium | 6–8 weeks | Workflows become understandable and adoptable |
| Build runtime, learning, approval, and evaluation admin UX | Makes adaptation transparent | Supports enterprise audit and change control | Medium | Low | 5–8 weeks | Admins can inspect, reverse, and tune behaviour |
| Add browser-level scenario automation and a staging workspace | Prevents UX and integration regressions | Enables safe future evolution | Medium | Low | 4–6 weeks | More reliable releases |

## P2 — Required for enterprise pilot readiness

| Recommendation | Business value | Enterprise impact | Complexity | Risk | Estimated effort | Expected UX improvement |
|---|---|---|---|---|---|---|
| Implement meeting-to-execution orchestration | Converts meetings into accountable work | Connects decisions, tasks, memory, projects, and summaries | High | Medium | 6–10 weeks | Meeting outcomes happen naturally |
| Implement sprint, HR, operations, and customer-success reasoning packs | Expands value beyond task alerts | Supports real departments and industries | High | Medium | 8–12 weeks | Domain-specific assistance without AI expertise |
| Evaluate operational outcomes, not only acceptance | Proves business value | Measures delay reduction, risk accuracy, and work saved | High | Medium | 6–8 weeks | Users see why recommendations improve outcomes |
| Move event processing to horizontally scalable queue workers | Supports sustained event volume | Enables concurrency, recovery, and backpressure | High | High | 6–10 weeks | Lower delay under load |
| Add enterprise policy inheritance | Enables business-unit governance | Supports user/team/project/department/workspace scopes | High | Medium | 5–8 weeks | Personalization becomes predictable and controllable |
| Conduct role-based usability studies | Prevents AI clutter and alert fatigue | Validates executive and manager adoption | Medium | Low | 3–5 weeks | Simpler language and better interaction timing |

## P3 — Required for market leadership

| Recommendation | Business value | Enterprise impact | Complexity | Risk | Estimated effort | Expected UX improvement |
|---|---|---|---|---|---|---|
| Create an agent and capability extension framework | Enables ecosystem growth | Allows partners and internal teams to add governed capabilities | High | High | 8–16 weeks | New capabilities appear without redesign |
| Build an enterprise agent control tower | Centralizes policy, risk, cost, quality, and audit | Competes with mature enterprise governance products | Very high | High | 12–20 weeks | Executives and administrators gain unified control |
| Add cross-workspace and business-unit federation with strict policy | Supports large enterprises | Enables shared learning without tenant leakage | Very high | High | 12–20 weeks | Consistent enterprise behaviour with local autonomy |
| Establish industry benchmark suites | Creates defensible proof | Demonstrates measurable superiority | High | Medium | Ongoing | Buyers can evaluate outcomes rather than demos |

---

## 10. Enterprise-pilot exit criteria

The verdict should not advance to Enterprise Pilot Ready until all of the following are proven:

1. Approval-required actions cannot execute from any API or UI path before approval.
2. Production events are processed autonomously with no manual endpoint calls.
3. Queue lag has a defined SLO and alerting.
4. Task creation, update, assignment, status, meeting, sprint, leave, attendance, review, goal, intelligence, and summary events pass contract tests.
5. Task reasoning loads its project, sprint, dependencies, assignee availability, relevant meetings, memory, and previous outcomes.
6. At least four different capability types are selected and executed in realistic scenarios.
7. Meeting completion can update tasks, memory, project state, and Executive Summary through governed approvals.
8. Repeated rejection measurably changes future recommendation frequency, rank, channel, or action.
9. Displayed confidence is calibrated and clearly labelled.
10. Workflow creation and observability are usable by a nontechnical administrator.
11. A multi-workspace test proves scoped personalization and zero leakage.
12. Load and recovery tests prove sustained event processing at the intended enterprise scale.
13. Browser-level accessibility and visual-regression tests pass.
14. Manager and executive usability studies show reduced work rather than increased alert fatigue.

---

## 11. Final answer to the product question

### Did Asystence become the adaptive enterprise orchestrator originally envisioned?

**No, not yet.**

### Did the implementation create a valuable foundation?

**Yes.**

The strongest parts are:

- tenant-safe events;
- traceability;
- deterministic evidence;
- reusable service execution;
- integrated recommendation UX;
- reversible learning records;
- modular extension points.

The missing product loop is:

`Observe continuously → build rich context → reason causally → coordinate capabilities → enforce approval → execute → measure operational outcome → change future behaviour`

Today, the live loop is closer to:

`Capture HTTP event → manually process queue → inspect task status/due date/assignee → propose supervisor notification → record feedback`

That is a functional prototype of the intended architecture, not an enterprise adaptive operating system.

The platform should retain the current foundation and complete the loop rather than replace it. The P0 work is narrow and urgent. The P1 work is where the Adaptive Orchestrator becomes real.

---

## Appendix A — Evidence references

### Production behavioural harness

`scripts/adaptive-orchestrator-behavioral-audit.mjs`

### Key implementation paths inspected after behavioural testing

- `.github/workflows/deploy.yml`
- `adaptive/runtime/adaptiveWorker.service.js`
- `adaptive/runtime/adaptiveRuntime.service.js`
- `adaptive/events/operationalEvent.middleware.js`
- `adaptive/events/eventQueue.repository.js`
- `adaptive/context/defaultContextProviders.js`
- `adaptive/context/contextBuilder.service.js`
- `adaptive/reasoning/reasoningEngine.service.js`
- `adaptive/capabilities/defaultCapabilities.js`
- `adaptive/approvals/approvalEngine.service.js`
- `adaptive/execution/executionEngine.service.js`
- `adaptive/learning/learningEngine.service.js`
- `adaptive/personalization/personalizationEngine.service.js`
- `adaptive/evaluation/evaluationEngine.service.js`
- `routes/adaptive.routes.js`
- `services/operationsAction.service.js`
- `../Task-management/src/components/AdaptiveRecommendations.jsx`
- `../Task-management/src/pages/Dashboard.jsx`
- `../Task-management/src/pages/ProjectTasks.jsx`

### Competitive source basis

Official product materials reviewed on 30 June 2026:

- Microsoft 365 Copilot and Copilot Studio agents;
- Atlassian Rovo agents;
- Asana AI Studio;
- monday AI agents;
- ServiceNow AI Agents, AI Agent Fabric, and AI Control Tower;
- ClickUp Brain and Super Agents.
