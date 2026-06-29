# Asystence Growth Intelligence — Implementation and Functioning Report

**Report date:** 29 June 2026
**Audience:** Product owner, platform operations, and engineering
**Surface:** Super Admin → Growth Intelligence

## 1. Executive summary

Growth Intelligence is implemented as a privacy-minimized, platform-wide analytics system inside Asystence. It records a controlled set of website and successful product events, aggregates them in PostgreSQL, and shows the results only through dedicated Super Admin authentication.

The delivered system currently provides:

- website page views, sessions, traffic sources, landing pages, referrers, devices, browsers, and coarse country codes;
- signup, workspace creation, login attempt, and successful-login signals;
- first project, task, team member, chat, Huddle, AI, and attendance activity;
- active-user, active-workspace, returning-user, feature-adoption, activation-funnel, and weekly-retention views;
- recent privacy-safe journey signals and rule-based operational insights;
- an API contract ready for a future AI insight provider without changing the dashboard UI.

Telemetry starts when the implementation is deployed. It does not reconstruct activity that happened before collection began.

## 2. Architecture

The data path is intentionally small and asynchronous:

```text
Browser navigation ──> POST /growth/events ──┐
                                             ├─> normalize + allowlist
Successful API action ─> response middleware ┤        │
Auth and Huddle milestones ─> server emit ───┘        v
                                               bounded async queue
                                                      │
                                                      v
                                              growth_events table
                                                      │
                                                      v
                                  GET /superadmin/growth/dashboard
                                                      │
                                                      v
                                      Super Admin dashboard tabs
```

There is no third-party analytics dependency and no product request waits for an analytics insert to complete.

## 3. Collection that is functioning

### 3.1 Website acquisition

The React `GrowthTelemetry` component runs on route changes outside `/superadmin`. It creates:

- a durable anonymous browser ID in `localStorage`;
- a per-tab session ID in `sessionStorage`;
- one `website.session_started` event per session;
- one deduplicated `website.page_view` event per navigation;
- the first landing path, referrer hostname, and UTM source/medium/campaign;
- viewport dimensions.

The browser sends no more than 25 events in one request. The public endpoint has a 64 KB request limit and a rate limit of 120 requests per IP per minute. Public clients can submit only `website.page_view` and `website.session_started`; they cannot forge product milestones.

### 3.2 Authentication and onboarding

Trusted server code records:

- `product.signup_completed` after a successful workspace signup;
- `product.workspace_created` after the workspace exists;
- `product.login_attempt` for email, MFA, and Google paths;
- `product.login_succeeded` only when authentication succeeds.

Signup and workspace milestones use deterministic event IDs. A retry therefore cannot inflate the same business milestone.

### 3.3 Successful product actions

Global response middleware observes only successful HTTP responses (status 200–399). It currently maps:

| Product action | Event | Dashboard feature |
|---|---|---|
| Create project | `product.project_created` | Projects |
| Create task | `product.task_created` | Tasks |
| Add user | `product.team_member_added` | Team |
| Create team | `product.team_created` | Team |
| Send chat message | `product.chat_message_sent` | Chat |
| Attendance sign in/out | `product.attendance_signed_in/out` | Attendance |
| Successful AI route action | `product.ai_used` | AI |

Natural-language and read-only task routes are excluded from task-creation counts. Failed and rejected product requests are not counted as adoption.

### 3.4 Huddle activity

Realtime server code records `product.huddle_created` after a Huddle is created. Its deterministic ID combines the workspace and Huddle/session identity so a repeated socket delivery cannot double-count it.

## 4. Storage and reliability

`growth_events` is an append-only event table. Each row can hold event/category/source, anonymous or authenticated identity, workspace, session, entity identifiers, page and acquisition dimensions, device/browser/coarse country, allowlisted properties, occurrence time, and receipt time.

Reliability controls:

- UUID event primary keys and `ON CONFLICT (id) DO NOTHING` provide idempotency;
- the in-process queue is bounded at 5,000 events;
- writes flush every second or at 100 queued events;
- batches contain at most 100 records;
- write failures are rate-limited in logs and never fail the user’s product action;
- event time is constrained to within 24 hours of server time;
- date queries are limited to 366 days;
- indexes cover event/time, actor/time, workspace/time, session/time, and JSON properties;
- Row Level Security is enabled so browser database roles cannot query the table directly.

The queue is deliberately best-effort. A process crash can lose events still in memory; this is an accepted tradeoff to keep product requests independent from analytics. A durable queue can be introduced later without changing the event or dashboard contract.

## 5. Dashboard calculations

### Growth Overview

- **Page views:** number of `website.page_view` events in the selected range.
- **Sessions:** distinct session IDs attached to page views.
- **Signups:** successful signup events.
- **Active users:** distinct authenticated users with measured events.
- **Active workspaces:** distinct workspaces with product events.
- **Returning users:** active users who also have measured activity before the selected range.
- **Growth percentages:** current selected period compared with the immediately preceding period of equal length.

### Acquisition

Ranks traffic sources, top pages, landing pages, referrer hostnames, device classes, browsers, and coarse countries. Up to ten values are returned per dimension.

### Activation

The funnel shows distinct identities reaching:

1. Visitor
2. Signup
3. Workspace Created
4. First Project
5. First Task
6. First Team Member
7. First Chat
8. First Huddle
9. AI Usage
10. Activation

An activated workspace is one that has recorded all three core milestones: project created, task created, and team member added. Step conversion is calculated against the preceding displayed stage and capped at 100% because different stages can use different identity scopes.

### Engagement

Feature adoption groups engagement events by their allowlisted `feature_name`. It returns total uses, distinct authenticated users, and distinct workspaces, with a maximum of 20 feature rows.

### Retention

Weekly active users are distinct authenticated users with measured activity in each calendar week. Returning-user percentage means active during the selected range and seen at least once before that range; it is not a cohort survival calculation.

### User Journey

Shows the latest 60 operational signals: event name, truncated identity in the UI, workspace, page path or feature name, and time. It contains no message bodies, prompts, passwords, or private content.

### Operational insights

The current `rules_v1` generator reports:

- leading and lowest-adoption features;
- largest measured funnel drop;
- returning-user percentage;
- direction of the latest daily active-user change.

Each insight has a stable ID, severity, title, detail, and generator. The API also returns `ai_extension_ready: true`, allowing future AI-generated insights to use the same response shape.

## 6. Privacy and security

- Only named property keys are accepted: feature name, method, outcome, status/route metadata, viewport dimensions, returning-session flag, and provider.
- Passwords, tokens, message content, AI prompts, free-form text, and private conversations are discarded by the normalizer.
- Query strings and URL fragments are removed from page paths.
- Referrers are reduced to hostnames.
- Growth events do not store IP addresses.
- Country appears only when the hosting edge supplies an accepted country-code header; otherwise it is `Unknown`.
- Public telemetry cannot create trusted product events.
- Dashboard and health endpoints require a dedicated Super Admin token. Normal workspace JWTs are rejected.
- Super Admin auth uses its own short-lived access tokens and server-side hashed refresh sessions.
- Every protected request verifies the server-side session, making password-reset revocation immediate even for an access token that has not yet expired.

## 7. Super Admin password recovery delivered with this report

Password recovery remains separate from workspace-user recovery:

- **Authenticated change:** Settings → Security requires the current password and a new strong password.
- **Email recovery:** Login → Forgot password creates a one-hour, single-use random token; only its SHA-256 hash is stored.
- **Reset completion:** a valid token changes the bcrypt password, marks the token used, and revokes every Super Admin session.
- **Enumeration resistance:** forgot-password returns the same message for known and unknown emails, pads response timing, and is rate-limited.
- **Emergency recovery:** the guarded CLI reset remains available and never prints or accepts the password as a command-line argument.

Strong Super Admin passwords require at least 12 characters with uppercase, lowercase, number, and symbol. Production email delivery requires `SMTP_HOST`, `SMTP_USER`, and `SMTP_PASS`; authenticated password change and guarded CLI recovery do not depend on SMTP.

## 8. Validation evidence

The automated validation suite covers:

- public event sanitization and rejection of forged product events;
- deterministic event IDs and acquisition/device/browser classification;
- successful-response-only product matching;
- bounded dashboard date ranges;
- rejection of normal user JWTs by Super Admin verification;
- strong Super Admin password policy;
- migration security fields and indexes;
- real PostgreSQL login, refresh, logout, reset-token single use, password replacement, and all-session revocation;
- real PostgreSQL overview, funnel, adoption, retention, journey, and insight response contracts;
- focused frontend lint and a complete Vite production build.

The database integration test runs inside a transaction and always rolls back. It uses an isolated future telemetry range so real production events cannot alter expected counts.

## 9. Operations and limitations

- Dashboard API: `GET /superadmin/growth/dashboard?from=YYYY-MM-DD&to=YYYY-MM-DD`
- Queue health: `GET /superadmin/growth/health`
- Browser ingestion: `POST /growth/events`
- Growth migration: `npm run migrate:superadmin-growth`
- Password-recovery migration: `npm run migrate:superadmin-password-recovery`
- Unit contract: `npm run test:growth-intelligence`
- Transactional DB contract: `npm run test:growth-intelligence:db`

Known interpretation boundaries:

- values are measured events, not historical reconstruction;
- browser telemetry can be blocked by privacy tools or network failure;
- country is unavailable when an edge country header is absent;
- the process-local queue favors product stability over guaranteed delivery;
- returning users are prior-activity users, not a formal cohort-retention curve;
- rule-generated insights are deterministic operational guidance, not predictive AI claims.

## 10. Rollback

Both database changes are additive. Reverting the application releases disables collection, dashboards, or password-recovery UI without modifying normal user auth or existing business tables. The new tables may remain dormant during rollback. They should be dropped only after deciding that retained telemetry, sessions, and unused recovery tokens are no longer needed.
