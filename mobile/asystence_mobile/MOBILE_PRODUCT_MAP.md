# Mobile Product Map

## Existing Product Surface

The current project has a Node/Express backend and a React/Vite frontend with Capacitor. The backend exposes these major domains:

- Identity: login, MFA, refresh tokens, magic links, Google SSO, password reset
- Workspace: plans, AI settings, members, subscriptions, billing
- Work management: projects, project history, tasks, subtasks, comments, tags, watchers, votes, links, time logs, sprints, statuses
- Collaboration: chat channels/messages, unread counts, huddles, end-to-end crypto helper endpoints
- Attendance: sign in/off, AWS, lunch, available, admin reports/export/recalculation
- Intelligence: workspace/project/task AI query, performance, admin summaries, project health
- Enterprise: SSO, MFA, audit, GDPR, webhooks, API keys, wiki, leave, OKRs, reviews
- Integrations: Asana, YouTrack, Slack migration, Git automation, integration webhooks, migration history
- Operations OS: memory, search, automation rules, digests, AI actions
- Billing: plans, checkout, activation, subscription cancellation, pending users
- Testing agent: settings, task options, runs, report export, browser/CLI/API agent actions
- Superadmin: workspaces, plans, payments, backups, settings

## Mobile Strategy

Flutter is used as a native mobile app, not a web wrapper. The mobile experience
contains only workflows that can be completed safely and comfortably on a phone:

- Bottom tabs: Dashboard, Projects, My Tasks, Chat, Alerts
- More drawer: Profile and Leave
- Dedicated native screens for every retained workflow
- No generic endpoint consoles or desktop-table placeholders

The native app excludes testing agent, migrations, integration setup, billing,
enterprise configuration, superadmin, raw intelligence/report consoles, OKRs,
reviews, and wiki administration. Those remain web-only.

## Non-Regression Rules

- Backend remains the source of truth for workspace access, role gates, and plan gates.
- The app never fabricates workspace IDs. It sends `x-workspace-id` only when the authenticated user/session provides one.
- Refresh token rotation mirrors the React app: retry once on expired JWT, then log out if refresh fails.
- Destructive actions remain explicit and are not hidden behind swipe gestures.
- Desktop-only flows such as exports, billing checkout, SSO, and external OAuth open the platform browser.
