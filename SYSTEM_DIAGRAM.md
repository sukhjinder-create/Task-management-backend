# Workforce Intelligence Platform — Complete System Architecture
> Version 2.0 · Last Updated: April 2026 · Confidential

---

## TABLE OF CONTENTS

1. [Product Overview](#1-product-overview)
2. [Infrastructure & Service Architecture](#2-infrastructure--service-architecture)
3. [Role Hierarchy & Permission Matrix](#3-role-hierarchy--permission-matrix)
4. [Authentication & Security](#4-authentication--security)
5. [Workspace & Tenant Management](#5-workspace--tenant-management)
6. [Task & Project Management](#6-task--project-management)
7. [Real-Time Chat System](#7-real-time-chat-system)
8. [Attendance Tracking](#8-attendance-tracking)
9. [Leave Management](#9-leave-management)
10. [Performance Reviews](#10-performance-reviews)
11. [OKR / Goals System](#11-okr--goals-system)
12. [Wiki / Knowledge Base](#12-wiki--knowledge-base)
13. [AI Autopilot Engine](#13-ai-autopilot-engine)
14. [AI Conversational Assistant](#14-ai-conversational-assistant)
15. [Strategic Intelligence](#15-strategic-intelligence)
16. [Notifications System](#16-notifications-system)
17. [Billing & Payments (Razorpay)](#17-billing--payments-razorpay)
18. [Integrations](#18-integrations)
19. [Complete Data Flow Diagrams](#19-complete-data-flow-diagrams)

---

## 1. PRODUCT OVERVIEW

This is a **full-stack, multi-tenant workforce management SaaS platform** built for small-to-medium businesses. It combines task management, team collaboration, HR workflows, and AI-driven automation in a single product.

### Core Value Propositions
- **AI-First Operations**: An Autopilot engine proactively monitors work and takes actions (reassign overdue tasks, flag blockers, generate standups)
- **All-in-One**: Tasks, chat, attendance, leave, reviews, goals, wiki, and video huddles in one product — no tool juggling
- **Every Platform**: Single codebase ships to Web, Windows, macOS, Linux (Electron), iOS, and Android (Capacitor)
- **Self-Serve SaaS**: Workspace signup, plan selection, Razorpay payments, and instant onboarding without admin involvement
- **Real-Time**: WebSocket-powered live updates across all features

### Technology Stack
| Layer | Technology |
|---|---|
| Backend API | Node.js (ES Modules), Express.js |
| Database | PostgreSQL (pg pool, raw SQL) |
| Real-Time | Socket.IO |
| Web App | React 18, Vite, Tailwind CSS |
| Desktop App | Electron 41 (Windows NSIS/Portable, macOS DMG x64+arm64, Linux AppImage/deb) |
| Mobile App | Capacitor 8 wrapping React (iOS + Android, app ID: com.proxima.app) |
| Video / Voice | WebRTC (built-in Huddle feature) |
| AI Service | Node.js microservice, port 5005 |
| LLM | Ollama (local, default) / OpenAI (fallback) |
| Payments | Razorpay (UPI AutoPay, Cards, NACH) |
| File Storage | AWS S3 (multer-s3), AES-256 encrypted |
| Scheduling | node-cron (3 cron jobs) |
| Auth | JWT + Refresh token (httpOnly cookie) + SAML (enterprise SSO) |

---

## 2. INFRASTRUCTURE & SERVICE ARCHITECTURE

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                     CLIENT LAYER  — App Name: Proxima                        │
│                                                                               │
│   Single React 18 + Vite codebase · ships to 6 platforms:                   │
│                                                                               │
│   ┌─────────────────┐  ┌────────────────────────┐  ┌──────────────────────┐ │
│   │  WEB BROWSER    │  │  DESKTOP (Electron 41) │  │  MOBILE (Capacitor 8)│ │
│   │                 │  │                        │  │                      │ │
│   │  CDN / Nginx    │  │  Windows (NSIS/.exe)   │  │  iOS (Xcode / App    │ │
│   │  Any browser    │  │  macOS (DMG, x64+arm64)│  │       Store)         │ │
│   │                 │  │  Linux (AppImage/.deb) │  │  Android (Gradle /   │ │
│   │                 │  │                        │  │       Play Store)    │ │
│   │                 │  │  System tray · native  │  │  Push notifications  │ │
│   │                 │  │  menus · window state  │  │  Haptics · Status bar│ │
│   └────────┬────────┘  └───────────┬────────────┘  └──────────┬───────────┘ │
│            │                       │                           │             │
│            └───────────────────────┼───────────────────────────┘             │
│                                    │ HTTPS + WSS                             │
└────────────────────────────────────┼─────────────────────────────────────────┘
                             │
┌────────────────────────────▼──────────────────────────────────────────────────┐
│                       BACKEND API  (Port 3000)                                │
│                                                                               │
│   ┌──────────────────────────────────────────────────────────────────────┐   │
│   │  Express.js Server (index.js)                                        │   │
│   │                                                                      │   │
│   │  Middleware Chain:                                                   │   │
│   │  cors → helmet → express-rate-limit → express.json                  │   │
│   │    → authenticateToken (JWT)                                        │   │
│   │    → attachWorkspace (resolve workspace_id)                         │   │
│   │    → requirePlanFeature (plan gating)  [route-level]                │   │
│   │    → requireRole (RBAC)  [route-level]                              │   │
│   └──────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
│   ┌──────────────────────────────────────────────────────────────────────┐   │
│   │  54 Route Groups (routes/)                                           │   │
│   │                                                                      │   │
│   │  auth · users · tasks · projects · chat · attendance                │   │
│   │  leave · notifications · autopilot · reviews · goals                │   │
│   │  wiki · billing · analytics · reports · integrations                │   │
│   │  files · search · internal · superadmin · ...and more              │   │
│   └──────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
│   ┌──────────────────────────────────────────────────────────────────────┐   │
│   │  Scheduled Jobs (node-cron)                                          │   │
│   │                                                                      │   │
│   │  Every 4h  → Autopilot Analysis (all workspaces)                   │   │
│   │  11:00 AM  → Daily Standup Generation (working days only)          │   │
│   │  Every 15m → Process Auto-Approvals                                 │   │
│   └──────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
│   ┌──────────────────────────────────────────────────────────────────────┐   │
│   │  Socket.IO Server                                                    │   │
│   │                                                                      │   │
│   │  Rooms: workspace:{id} · user:{id} · project:{id}                  │   │
│   │  Events: notification · chat_message · task_update · typing        │   │
│   │          autopilot_action · attendance_update                       │   │
│   └──────────────────────────────────────────────────────────────────────┘   │
│                            │                                                  │
└────────────────────────────┼──────────────────────────────────────────────────┘
                             │
          ┌──────────────────┼──────────────────────┐
          │                  │                       │
          ▼                  ▼                       ▼
┌──────────────────┐  ┌──────────────┐  ┌────────────────────────────────────┐
│  PostgreSQL DB   │  │  AWS S3      │  │  AI Microservice  (Port 5005)      │
│                  │  │  File Store  │  │                                    │
│  40+ Tables      │  │  AES-256     │  │  /analyze        → Autopilot AI   │
│  Multi-tenant    │  │  encrypted   │  │  /chat-reply     → Chat AI        │
│  Row-level       │  │  multer-s3   │  │  /standup        → Standup gen.   │
│  workspace_id    │  │              │  │  /intelligence   → Strategic Q&A  │
│  isolation       │  │              │  │                                    │
└──────────────────┘  └──────────────┘  │  LLM: Ollama (local default)      │
                                         │       OpenAI (fallback)           │
                                         └────────────────────────────────────┘
```

### Database Tables (40+)
```
CORE           : users, workspaces, workspace_members
AUTH           : refresh_tokens, api_keys
TASKS          : tasks, task_attachments, task_comments, task_activity_logs
PROJECTS       : projects, project_members
CHAT           : chat_channels, chat_messages, channel_members
ATTENDANCE     : attendance_events, attendance_daily, attendance_settings
LEAVE          : leave_policies, leave_balances, leave_requests, leave_approvals
REVIEWS        : review_cycles, review_assignments, review_responses, review_scores
GOALS (OKR)    : goals, key_results, goal_updates
WIKI           : wiki_pages, wiki_versions, wiki_access
NOTIFICATIONS  : notifications
AUTOPILOT      : autopilot_settings, autopilot_actions, autopilot_logs
AI             : chat_ai_logs, system_users, ai_conversation_context
BILLING        : billing_plans, workspace_subscriptions, payment_transactions
                 razorpay_mandates, razorpay_orders
INTEGRATIONS   : slack_configs, github_configs, webhook_configs
SCHEDULE       : workspace_work_schedule, workspace_holidays
ANALYTICS      : workspace_monthly_scores, workspace_analytics
```

---

## 3. ROLE HIERARCHY & PERMISSION MATRIX

### Two Completely Separate Systems

> **SUPERADMIN and workspace roles (Admin/Manager/User) operate in entirely separate systems.**
> Superadmin has no visibility into workspace content — no tasks, no projects, no chat, no attendance, no leave, no reviews. Their scope is limited to platform administration only.

---

### SUPERADMIN — Platform Administration Only

Superadmin logs in at a separate URL (`/superadmin`). They never enter a workspace. Their only tools are:

| Superadmin Capability | Details |
|---|---|
| Create workspace | Provisions a new workspace + assigns its first admin user |
| List all workspaces | See workspace name, plan, status, member count |
| View workspace details | Basic info: name, plan, status, created date |
| Activate / Suspend / Delete workspace | Change workspace status |
| Assign / change workspace plan | Switch which billing plan a workspace is on |
| List users in a workspace | Only sees: id, username, email, role, created_at |
| Edit user's username / email / role | Basic user info only — no workspace content |
| Delete user from workspace | Remove a user entirely |
| Reset user password | Set a new password for any user in any workspace |
| Create billing plans | Define plan name, price, features, limits, trial days |
| Edit billing plans | Update plan price, features, limits |
| Delete billing plans | Only if no workspace is currently on that plan |
| Sync plan to Razorpay | Push plan to Razorpay for recurring billing |
| View platform stats | Total workspaces, total users — aggregate numbers only |

**Superadmin CANNOT see:** tasks, projects, chat messages, attendance records, leave requests, performance reviews, goals, wiki pages, autopilot actions, or any workspace operational data.

---

### Workspace Roles — Admin / Manager / User

These roles exist inside a workspace. None of them can create workspaces or configure billing plans.

### Permission Matrix

| Feature | ADMIN | MANAGER | USER |
|---|:---:|:---:|:---:|
| **WORKSPACE** | | | |
| Edit workspace settings (name, logo, etc.) | ✅ | ❌ | ❌ |
| Manage work schedule & holidays | ✅ | ❌ | ❌ |
| **USERS** | | | |
| Invite members | ✅ | ✅ | ❌ |
| Remove members | ✅ | ❌ | ❌ |
| Change member roles | ✅ | ❌ | ❌ |
| View member profiles | ✅ | ✅ | Own only |
| **TASKS** | | | |
| Create tasks | ✅ | ✅ | ❌ |
| Assign tasks to others | ✅ | ✅ | ❌ |
| Edit any task (full) | ✅ | ✅ | ❌ |
| Update own task status only | ✅ | ✅ | ✅ |
| Delete tasks | ✅ | ✅ | ❌ |
| View all workspace tasks | ✅ | ✅ | Assigned only |
| **PROJECTS** | | | |
| Create projects | ✅ | ✅ | ❌ |
| Edit projects | ✅ | ✅ | ❌ |
| Delete projects | ✅ | ❌ | ❌ |
| Add members to project | ✅ | ✅ | ❌ |
| View project details | ✅ | Assigned projects | If member |
| **CHAT** | | | |
| Create channels | ✅ | ✅ | ✅ |
| Send messages | ✅ | ✅ | ✅ |
| Delete channel (must be channel admin) | ✅ | ✅ | ✅ |
| Create DMs | ✅ | ✅ | ✅ |
| Start video / voice huddle | ✅ | ✅ | ✅ |
| **ATTENDANCE** | | | |
| Sign in / Sign off | ✅ | ✅ | ✅ |
| View own attendance | ✅ | ✅ | ✅ |
| View all attendance (workspace-wide) | ✅ | ❌ | ❌ |
| Edit / recalculate attendance records | ✅ | ❌ | ❌ |
| Export attendance | ✅ | ❌ | ❌ |
| Configure attendance settings | ✅ | ❌ | ❌ |
| **LEAVE** | | | |
| Request leave | ✅ | ✅ | ✅ |
| Approve / reject leave | ✅ | ❌ | ❌ |
| Create / edit leave policies | ✅ | ❌ | ❌ |
| View all leave requests | ✅ | ❌ | Own only |
| Manage leave balances | ✅ | ❌ | ❌ |
| **PERFORMANCE REVIEWS** | | | |
| Create review cycles | ✅ | ❌ | ❌ |
| Assign reviewers | ✅ | ❌ | ❌ |
| Submit reviews | ✅ | ✅ | ✅ |
| View all review results | ✅ | ❌ | Own only |
| Manage review templates | ✅ | ❌ | ❌ |
| View team review progress | ✅ | ✅ | ❌ |
| **GOALS / OKR** | | | |
| Create / edit / delete goals | ✅ | ✅ | ❌ |
| Create personal goals | ✅ | ✅ | ✅ |
| Update key results | ✅ | ✅ | Own only |
| View workspace goal health | ✅ | ✅ | ❌ |
| View all goals | ✅ | ✅ | Own + public |
| **WIKI** | | | |
| Create pages | ✅ | ✅ | ✅ |
| Edit pages | ✅ | ✅ | ✅ |
| Delete wiki space | ✅ | ❌ | ❌ |
| Delete pages | ✅ | ✅ | ✅ |
| **AUTOPILOT / AI** | | | |
| Enable / configure autopilot settings | ✅ | ✅ | ❌ |
| View autopilot actions | ✅ | ✅ | ❌ |
| Approve / reject actions | ✅ | ✅ | ❌ |
| Manually trigger autopilot run | ✅ | ✅ | ❌ |
| View AI standup | ✅ | ✅ | ✅ |
| Use AI chat assistant | ✅ | ✅ | ✅ |
| Strategic Intelligence queries | ✅ | ✅ | ❌ |
| **BILLING (workspace subscription)** | | | |
| Subscribe to / change plan | ✅ | ❌ | ❌ |
| View workspace invoices | ✅ | ❌ | ❌ |
| **INTEGRATIONS** | | | |
| Connect / disconnect integrations | ✅ | ✅ | ✅ |
| Configure SAML / SSO | ✅ | ❌ | ❌ |
| Import from Asana / Slack | ✅ | ❌ | ❌ |
| **ANALYTICS / REPORTS** | | | |
| Workspace / project reports | ✅ | ✅ | ❌ |
| Own individual report | ✅ | ✅ | ✅ |
| Export reports | ✅ | ✅ | ❌ |

---

### SYSTEM (AI) — Internal Only

```
role = 'system', is_system = true
Cannot log in. Created automatically per workspace by ensureSystemUser().
Posts standup messages, AI chat replies, and attendance notifications
as the "Autopilot" identity inside chat channels.
```

---

## 4. AUTHENTICATION & SECURITY

### Authentication Flow
```
1. REGISTRATION
   ─────────────
   POST /auth/signup
   Body: { email, password, username, workspaceName? }

   → Password hashed (bcrypt, rounds=12)
   → Workspace created (if new)
   → System AI user provisioned for workspace
   → JWT access token issued (15 min expiry)
   → Refresh token stored in DB + httpOnly cookie (7 days)
   → Welcome notification sent

2. LOGIN
   ──────
   POST /auth/login
   Body: { email, password }

   → Password compared (bcrypt.compare)
   → On success:
       • access_token: JWT (15 min) returned in response body
       • refresh_token: opaque token stored in DB + httpOnly cookie

3. TOKEN REFRESH
   ──────────────
   POST /auth/refresh
   (Cookie: refresh_token)

   → Token looked up in refresh_tokens table
   → If valid and not expired: new access_token issued
   → If expired: 401 — user must re-login

4. AUTHENTICATED REQUEST FLOW
   ────────────────────────────
   Any protected route:

   Request → authenticateToken middleware
           → Reads Authorization: Bearer <jwt>
           → Verifies signature + expiry
           → Attaches { user_id, workspace_id, role } to req.user
           → attachWorkspace: confirms workspace exists in DB
           → Route handler runs

5. LOGOUT
   ───────
   POST /auth/logout
   → refresh_token deleted from DB
   → Cookie cleared
```

### Security Layers
```
• Rate limiting: express-rate-limit on all routes
• Helmet: sets security headers (CSP, HSTS, X-Frame-Options, etc.)
• CORS: origin whitelist, credentials: true
• Input validation: Joi schema validation on critical routes
• SQL injection: parameterized queries throughout (no string concatenation)
• File upload: AES-256 encryption, MIME type whitelist, size limits
• Workspace isolation: every DB query scoped by workspace_id
• Plan gating: requirePlanFeature() middleware on premium features
```

---

## 5. WORKSPACE & TENANT MANAGEMENT

### Workspace Lifecycle
```
WORKSPACE CREATION — SUPERADMIN ONLY
  │
  Superadmin logs in → POST /superadmin/workspaces
  Body: { name, plan, ownerEmail, ownerPassword, ownerName }
  │
  ├─ New workspace created (UUID, slug)
  ├─ Plan assigned from configured billing_plans
  ├─ Admin user created with hashed password → assigned to workspace
  ├─ Default channels created: #general, #announcements
  ├─ ensureSystemUser() → AI identity provisioned for workspace
  ├─ Default leave policies provisioned
  ├─ Default work schedule provisioned (Mon–Fri)
  └─ Admin can now log in and start using the workspace

INVITE FLOW
  Admin/Manager: POST /users/invite
  │
  ├─ Invite record created with token (24h expiry)
  ├─ Invited role: user | manager | admin
  ├─ Invitation email sent (via configured SMTP)
  └─ Invitee registers using token → auto-joined to workspace

USER-WORKSPACE RELATIONSHIP
  • One user belongs to exactly ONE workspace — enforced by:
      1. workspace_id column directly on the users table
      2. UNIQUE INDEX on workspace_users(user_id) in the DB
  • A user cannot be in two workspaces simultaneously
  • workspace_id is embedded in the JWT at login
  • To access a different workspace, a separate account is required
```

### Work Schedule & Holiday System
```
workspace_work_schedule:
  work_days: [1,2,3,4,5]  (JS day-of-week: 0=Sun…6=Sat)
  work_start: "09:00"
  work_end:   "18:00"

workspace_holidays:
  date:  "2026-08-15"  (Independence Day)
  name:  "Independence Day"

Used by:
  • Attendance system (expected hours calculation)
  • Autopilot standup cron (skip non-working days)
  • Leave management (business-days calculation)
```

---

## 6. TASK & PROJECT MANAGEMENT

### Task States
```
todo  →  in_progress  →  review  →  done
  ↑                                   │
  └───────────── (reopen) ────────────┘

Priority levels: low · medium · high · urgent
```

### Task Creation Flow
```
POST /tasks
Body: {
  title, description,
  project_id,          (required — tasks must belong to a project)
  assigned_to,         (user UUID, must be workspace member)
  priority,
  due_date,
  attachments[]
}

Backend:
  1. Validate workspace_id present (never NULL)
  2. assertProjectInWorkspace(project_id, workspace_id) — cross-tenant guard
  3. Validate assigned_to is member of workspace
  4. INSERT task
  5. Log to task_activity_logs (action: TASK_CREATED)
  6. Notify assigned user (type: task_assigned)
  7. Emit Socket.IO event to project room
  8. Autopilot re-analysis triggered (async, non-blocking)
```

### Project Structure
```
Workspace
  └── Projects (1:many)
        └── Tasks (1:many)
              ├── Comments (with @mentions)
              ├── Attachments (encrypted files)
              └── Activity Log (full audit trail)

Projects have:
  • Members (subset of workspace members)
  • Status: active | archived | completed
  • Budget / timeline fields
  • Linked to GitHub repo (optional)
  • AI analysis channel (one per project)
```

### Task Activity Logging
Every task mutation is logged:
```
Action Types:
  TASK_CREATED       · TASK_DELETED
  STATUS_CHANGED     · PRIORITY_CHANGED
  ASSIGNEE_CHANGED   · DUE_DATE_CHANGED
  DESCRIPTION_UPDATED
  COMMENT_ADDED      · ATTACHMENT_ADDED
  LABEL_ADDED        · LABEL_REMOVED
```
This feed powers:
- AI Autopilot analysis
- Strategic Intelligence queries
- Complete audit trail
- Standup generation

---

## 7. REAL-TIME CHAT SYSTEM

### Channel Types
```
#general           → Workspace-wide (auto-created)
#announcements     → Broadcast (admin only can post)
#project-{name}    → Auto-created per project
DM                 → Direct message between 2 members
GROUP DM           → Group conversation
AI_ANALYSIS        → Per-project AI channel (autopilot posts here)
STANDUP            → Workspace standup channel
```

### Video & Voice (Huddle)
Built-in WebRTC-based video/voice conferencing:
- Initiated from any channel or DM
- Peer-to-peer and multi-party calls
- No third-party dependency (Zoom, Meet, etc.)
- Works across Web, Desktop, and Mobile platforms

### Message Flow
```
User sends message
  │
  ▼
POST /chat/channels/:channelId/messages
  │
  ├─ Validate user is channel member
  ├─ Parse @mentions → send mention notifications
  ├─ Save to chat_messages (with temp_id for deduplication)
  ├─ Emit via Socket.IO to all channel members
  │
  └─ If channel is an AI channel (is_ai_channel = true):
       └─ Trigger AI auto-reply pipeline:
            ├─ Check if sender is system user → skip (no AI replying to AI)
            ├─ ensureSystemUser(workspaceId) → get AI identity
            ├─ POST to AI microservice /chat-reply
            │     Body: { message, channelId, workspaceId, projectId, history }
            ├─ AI microservice:
            │     • Fetches project context (tasks, members, recent activity)
            │     • Calls LLM with system prompt + context + conversation history
            │     • Returns response text
            └─ Backend posts response as system user
                  → saved to chat_messages
                  → emitted via Socket.IO
```

### AI Chat Context Window
The AI assistant in project channels is context-aware:
- Last 20 messages of conversation history
- Current project tasks (open, overdue)
- Team members and their workload
- Recent activity (last 7 days)
- Project description and goal

---

## 8. ATTENDANCE TRACKING

### Event Model
```
Raw Events (attendance_events):
  SIGN_IN    → User starts their workday
  SIGN_OFF   → User ends their workday
  AWS_START  → Automated work session start (future)
  BREAK_START / BREAK_END → Break tracking

Daily Aggregation (attendance_daily):
  user_id, date, workspace_id
  first_sign_in, last_sign_off
  total_time_seconds
  status: present | absent | half_day | late
```

### Sign-In Flow
```
POST /attendance/sign-in
  │
  ├─ Check for open session (getOpenSessionId)
  │    If open session exists → return 409 (already signed in)
  │
  ├─ INSERT attendance_events (type: SIGN_IN)
  ├─ Recalculate attendance_daily for today
  │
  ├─ Fire-and-forget: sendAttendanceSlack()
  │    ├─ POST to Slack webhook (if configured) → async, always fires
  │    └─ Chat message via ensureSystemUser() + createChatMessage()
  │         [was broken Mar 23 – Apr 2026 due to system_users INSERT bug]
  │         [now fixed: only inserts workspace_id + user_id]
  │
  └─ Return { session_id, sign_in_time }

Sign-Off Flow: POST /attendance/sign-off
  ├─ Find open session (getOpenSessionId) → 404 if none
  ├─ INSERT attendance_events (type: SIGN_OFF)
  ├─ Recalculate daily totals
  ├─ Fire-and-forget: sendAttendanceSlack()
  └─ Return { duration, total_today }
```

### Attendance Configuration (Admin)
```
• Expected hours per day
• Grace period (minutes before "late" flag)
• Overtime threshold
• Whether to require sign-in on working days
• Slack notification settings
```

### Reports & Export
- Daily/weekly/monthly summaries per user
- Workspace-wide attendance matrix
- CSV export (admin/manager only)
- Late arrival frequency, overtime tracking

---

## 9. LEAVE MANAGEMENT

### Leave Policy Structure
```
Leave Types (Admin-configurable):
  • Annual Leave (e.g. 18 days/year)
  • Sick Leave (e.g. 12 days/year)
  • Casual Leave (e.g. 6 days/year)
  • Unpaid Leave
  • Custom types

Per policy:
  • accrual_type: annual | monthly | upfront
  • carry_forward: true/false (and max carry-forward days)
  • requires_approval: true/false
  • min_notice_days: int
  • max_consecutive_days: int
```

### Leave Request Flow
```
User: POST /leave/request
Body: { type, start_date, end_date, reason }

  ├─ Calculate business days (respects work schedule + holidays)
  ├─ Check leave balance sufficient
  ├─ Check notice period
  ├─ Create leave_request (status: pending)
  ├─ Notify managers/admins (type: leave_request)
  └─ Socket.IO event to admin room

Manager/Admin: POST /leave/:id/approve  OR  /leave/:id/reject
  ├─ Update leave_request status
  ├─ If approved: deduct from leave_balance
  ├─ Notify requester (type: leave_status)
  └─ Slack notification (if configured)

Cancellation: User can cancel pending requests
  └─ Approved leaves require admin override
```

### Leave Balance Management
```
Balances tracked per user per type per year:
  • Opening balance
  • Accrued (auto-updated monthly if accrual_type = monthly)
  • Used (updated on approval)
  • Carry-forward from previous year

Admin can manually adjust balances
```

---

## 10. PERFORMANCE REVIEWS

### Review Cycle Flow
```
ADMIN creates Review Cycle:
  POST /reviews/cycles
  Body: { name, start_date, end_date, type, template_id }

  Types:
  • SELF         → Employee reviews themselves
  • PEER         → Colleagues review each other
  • MANAGER      → Manager reviews direct reports
  • 360          → All of the above combined

ADMIN/MANAGER assigns reviewers:
  POST /reviews/cycles/:id/assign
  Body: { reviewee_id, reviewer_ids[] }

Review opens (status: active)

REVIEWER submits:
  POST /reviews/responses
  Body: {
    cycle_id, reviewee_id,
    responses: [
      { question_id, rating: 1-5, comment: "..." },
      ...
    ]
  }

  ├─ Responses saved
  ├─ Completion tracked per assignment
  └─ Reminders sent if approaching deadline

CYCLE closes (admin action or auto-close on end_date)
  ├─ Aggregated scores calculated
  ├─ Scores stored in review_scores
  └─ Notifications sent to all reviewees

Results visible to:
  • Reviewee: their own results
  • Manager: their direct reports' results
  • Admin: all results
```

### Review Templates
- Question banks managed by admin
- Rating scale: 1–5 with custom labels
- Free-text questions
- Competency groupings

---

## 11. OKR / GOALS SYSTEM

### Goal Hierarchy
```
WORKSPACE GOALS (admin/manager)
  └── Team goals cascade from workspace goals
        └── Individual goals cascade from team goals
              └── Key Results (measurable milestones)
                    └── Regular progress updates
```

### Goal States
```
on_track  →  at_risk  →  off_track  →  completed
                                   →  abandoned
```

### Key Result Updates
```
User: POST /goals/key-results/:id/update
Body: { current_value, note }

  ├─ Update key_result.current_value
  ├─ Recalculate progress %  (current / target * 100)
  ├─ Recalculate parent goal progress (avg of key results)
  ├─ Auto-update status if threshold crossed
  └─ Log update in goal_updates (audit trail)
```

### Visibility Rules
- Workspace-level goals: visible to all
- Team goals: visible to team + managers + admins
- Personal goals: visible to owner + managers + admins
- Admins can see everything

---

## 12. WIKI / KNOWLEDGE BASE

### Page Structure
```
Wiki (per workspace)
  └── Pages (hierarchical: parent_id references)
        └── Version history (every save creates a version)
```

### Permissions
```
Page access levels:
  • public (all workspace members can view)
  • members (specific members listed in wiki_access)
  • private (author only)

Editor: rich text (Quill/TipTap integration)
Full version history with diff capability
```

### Wiki Features
- Nested page hierarchy
- Full-text search across wiki
- @mention users in pages
- Embed images/files (encrypted storage)
- Version restore

---

## 13. AI AUTOPILOT ENGINE

### Overview
The Autopilot is an autonomous AI agent that monitors workspace activity and proactively takes or suggests actions. It runs without any human trigger.

### Architecture
```
┌────────────────────────────────────────────────────────────────┐
│                    AUTOPILOT ENGINE                            │
│               (autopilot/autopilot.engine.js)                  │
│                                                                │
│  Input: { workspaceId, projectId?, skipStandup, since, period }│
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  1. GATHER DATA                                          │ │
│  │     • All open tasks (overdue, at-risk, unassigned)      │ │
│  │     • Team workload (tasks per member)                   │ │
│  │     • Recent activity (status changes, comments)         │ │
│  │     • Workspace health score                             │ │
│  └──────────────────────────────────────────────────────────┘ │
│                           │                                    │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  2. SEND TO AI MICROSERVICE (:5005/analyze)              │ │
│  │     POST with full context JSON                          │ │
│  │     AI analyzes and returns: actions[]                   │ │
│  └──────────────────────────────────────────────────────────┘ │
│                           │                                    │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  3. PROCESS EACH ACTION                                  │ │
│  │     For each action returned by AI:                      │ │
│  │                                                          │ │
│  │     a) Determine approval mode:                          │ │
│  │        • auto_approve = true  → execute immediately     │ │
│  │        • auto_approve = false → save as pending         │ │
│  │        • Has approval_window_hours → timer starts       │ │
│  │                                                          │ │
│  │     b) Save to autopilot_actions table                   │ │
│  │                                                          │ │
│  │     c) If approved/auto-approved → execute:             │ │
│  │        • REASSIGN_TASK: change assigned_to              │ │
│  │        • UPDATE_PRIORITY: change priority               │ │
│  │        • POST_MESSAGE: send to AI channel               │ │
│  │        • CREATE_TASK: create sub-task                   │ │
│  │        • CLOSE_TASK: mark done                          │ │
│  │        • SEND_STANDUP: post standup summary             │ │
│  │        • NOTIFY_USER: send notification                 │ │
│  └──────────────────────────────────────────────────────────┘ │
│                           │                                    │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  4. RETURN SUMMARY                                       │ │
│  │     { actionsCreated, pendingApproval, autoApproved }    │ │
│  └──────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
```

### Autopilot Settings (Admin-configurable)
```
autopilot_settings:
  enabled:                 true/false
  auto_approve:            true/false (execute without asking)
  approval_window_hours:   int (how long admin has to reject before auto-exec)
  analysis_scope:          workspace | project | both
  action_types_enabled:    string[] (which action types are allowed)
  auto_generate_standup:   true/false (daily standup)
  standup_channel_id:      UUID (where to post standups)
  notification_threshold:  int (min actions before notifying admin)
```

### Cron Schedule
```
Every 4 hours   → runAutopilotAnalysis({ skipStandup: true })
                   Analyzes all workspaces for issues, creates actions

11:00 AM daily  → Standup generation (working days only)
  ├─ Checks isWorkingDayForWorkspace (work_days array + holidays)
  ├─ Calculates dynamic lookback window via getStandupLookbackSince
  │     Monday  → covers since Friday 11 AM
  │     Tuesday → covers since yesterday 11 AM
  │     After holiday → covers since last working day 11 AM
  └─ runAutopilotAnalysis({ skipStandup: false, sinceTimestamp, periodLabel })

Every 15 min    → processAutoApprovals()
                   Executes pending actions whose window has expired
```

### Standup Generation
```
generateStandupSummary(workspaceId, projectId, settings, sinceTimestamp, periodLabel)

Queries (all scoped to sinceTimestamp::timestamptz):
  • Projects with recent activity
  • Status changes since last standup
  • Newly created tasks
  • Blocked/overdue tasks

Sends to AI: formatted prompt with all data
AI returns: formatted standup markdown

Posts to standup channel as system user (Autopilot)
Also notifies admins: "Autopilot ran: N actions generated"
```

### Manual Trigger (Admin)
```
POST /autopilot/run
  → Same engine, same logic
  → Returns immediately with summary
  → Actions visible in autopilot dashboard

Admin can:
  ✅ Approve action  → executed immediately
  ❌ Reject action   → marked rejected, not executed
  👁️ View rationale  → AI's reasoning for the action
  📊 View history    → all past actions with outcomes
```

---

## 14. AI CONVERSATIONAL ASSISTANT

### How It Works
Each project has a dedicated AI analysis channel. When a workspace member sends a message there, the AI (appearing as "Autopilot") replies automatically.

```
Member: "Which tasks are at risk of missing the deadline?"
  │
  ▼
Backend receives message
  ├─ Detects channel is_ai_channel = true
  ├─ Sender is NOT the system user (prevent loops)
  │
  ▼
POST :5005/chat-reply
Body: {
  message:    "Which tasks are at risk...",
  channelId:  "uuid",
  workspaceId:"uuid",
  projectId:  "uuid",
  history:    [ last 20 messages ],
  context: {
    project:   { name, description, status },
    tasks:     [ open tasks with assignee, due_date, priority ],
    members:   [ { name, role, taskCount } ],
    overdue:   [ overdue tasks ],
    recentLogs:[ activity last 7 days ]
  }
}

AI Microservice:
  ├─ Builds system prompt with project context
  ├─ Calls LLM (Ollama / OpenAI)
  ├─ Returns { reply: "Based on current data, 3 tasks are at risk..." }

Backend:
  └─ Posts reply as system user in channel
     → saved to chat_messages
     → emitted via Socket.IO to all channel members
```

### Conversation History
- Last 20 messages included in every request
- AI maintains conversational context within the window
- Context is NOT persisted across sessions (stateless between requests)

---

## 15. STRATEGIC INTELLIGENCE

### Overview
Strategic Intelligence is an on-demand analytical Q&A tool available to admins and managers. It allows natural language queries across workspace, project, or task scope.

### Query Flow
```
User: "What are the biggest operational risks this month?"
Scope: workspace

  ▼
POST /ai/intelligence-query
Body: { scope: "workspace", question: "..." }

Backend:
  ├─ buildAIContext(scope, entityId, workspaceId)
  │     Workspace scope:
  │       • workspace_monthly_scores (last 6 months trend)
  │       • getExecutionSnapshot() → completion rates, velocity
  │       • advancedForecast() → trend direction, confidence
  │     Project scope:
  │       • All project tasks (status breakdown)
  │       • Overdue count, blocker flags
  │       • Member workload
  │     Task scope:
  │       • Task details
  │       • Full activity log history
  │
  ├─ Build LLM prompt with context
  └─ Call LLM → return analysis

Response: Markdown-formatted executive analysis
```

### Access Levels
- SUPERADMIN / ADMIN / MANAGER: workspace + project + task scope
- USER: cannot access Strategic Intelligence
- Available: any time, on-demand, unlimited queries

---

## 16. NOTIFICATIONS SYSTEM

### Notification Types
| Type | Trigger | Recipients |
|---|---|---|
| `task_assigned` | Task assigned to user | Assignee |
| `task_updated` | Task fields changed | Assignee + watchers |
| `task_deleted` | Task deleted | Assignee |
| `project_assigned` | Added to project | New member |
| `comment_added` | New comment on task | Assignee + mentions |
| `comment_reply` | Reply to comment | Original commenter |
| `comment_mention` | @mention in comment | Mentioned user |
| `leave_request` | Leave submitted | Managers + admins |
| `leave_status` | Leave approved/rejected | Requester |
| `autopilot_summary` | Autopilot ran | Admins only |
| `workspace_warning` | System alert | Admins |
| `review_assigned` | Reviewer assigned | Reviewer |
| `review_reminder` | Deadline approaching | Reviewer |
| `review_missed` | Review not submitted | Admin |
| `review_cycle_complete` | Cycle ended | All participants |
| `manager_review_unlocked` | Manager review phase open | Managers |

### Delivery Channels
```
1. In-App (always):
   • Stored in notifications table
   • Served via GET /notifications
   • Real-time delivery via Socket.IO 'notification' event
   • Unread count badge in nav
   • Mark-one-read / mark-all-read

2. Slack (if configured):
   • Attendance events → Slack webhook
   • Leave requests/approvals → Slack
   • Autopilot summaries → Slack (optional)

3. Email (SMTP, if configured):
   • Leave approvals
   • Review assignments
   • Welcome / invite emails
```

### Frontend Notification Center
- Filter by: All / Unread / Type (role-appropriate chips)
- Role-based filter visibility:
  - Users: task, comment, leave, mentions
  - Managers: + projects
  - Admins: + autopilot, workspace warnings
- Click-to-navigate: each notification routes to relevant page
- Live dot indicator (green = socket connected, gray = offline)

---

## 17. BILLING & PAYMENTS (RAZORPAY)

### Plan Structure
```
billing_plans table:
  name:     "Free" | "Starter" | "Growth" | "Enterprise"
  price:    Monthly INR
  features: JSON array of feature keys

Feature keys (used by requirePlanFeature middleware):
  "autopilot"     → AI Autopilot engine
  "reviews"       → Performance Reviews module
  "goals"         → OKR / Goals module
  "analytics"     → Advanced Analytics
  "wiki"          → Knowledge Base
  "integrations"  → Slack, GitHub, Webhooks
  "unlimited_members" → No member cap
```

### Payment Methods Supported
```
1. UPI AutoPay (Recurring)
   • ₹1 authorization to verify UPI ID
   • Mandate created in Razorpay
   • Auto-debit on billing date

2. Cards (Recurring)
   • Card tokenization via Razorpay
   • Stored for recurring billing

3. NACH (Bank Mandate)
   • Bank direct debit
   • For enterprise customers
```

### Subscription Lifecycle
```
TRIAL
  ├─ Duration: configurable per plan (e.g. 14 days)
  ├─ Full features accessible
  └─ Reminder notifications before expiry

ACTIVE
  ├─ Payment collected on billing_date
  ├─ Success → subscription extended
  └─ Failure → grace period begins

GRACE PERIOD
  ├─ Duration: configurable (e.g. 3 days)
  ├─ Access continues
  ├─ Daily reminders sent
  └─ After grace → SUSPENDED

SUSPENDED
  ├─ Read-only access
  ├─ Can reactivate via new payment
  └─ Data retained for 30 days

CANCELLED
  └─ Data retained for 30 days, then purged
```

### Payment Flow
```
Admin: Select plan → Choose payment method

POST /billing/create-order
  └─ Razorpay order created
  └─ Returns order_id + amount

Frontend: Razorpay checkout opens
  └─ User completes payment

Razorpay: Webhook POST /billing/webhook
  ├─ Verify HMAC signature (razorpay-signature header)
  ├─ payment.captured → activate subscription
  ├─ subscription.charged → extend by 1 month
  ├─ subscription.halted → enter grace period
  └─ mandate.confirmed → UPI/NACH mandate active

Stored: payment_transactions (full audit trail)
```

---

## 18. INTEGRATIONS

### Slack
```
Configuration: Admin sets Slack webhook URL per channel

Used for:
  • Attendance sign-in / sign-off messages
  • Leave request notifications to managers
  • Autopilot summaries
  • Custom workspace alerts

Setup: POST /integrations/slack
  Body: { webhook_url, channel_name, events: ["attendance", "leave", ...] }
```

### GitHub
```
Configuration: Admin links GitHub repo to project

Features:
  • Webhook receives push events
  • Commit messages parsed for task references (#task-id)
  • Linked commits shown on task detail
  • Autopilot can trigger code review actions

Setup: POST /integrations/github
  Body: { repo_url, webhook_secret, project_id }
```

### Webhooks (Outbound)
```
Admins can configure custom webhooks for any event type:
  POST /integrations/webhooks
  Body: {
    url:    "https://your-system.com/hook",
    events: ["task.created", "task.updated", "leave.approved"],
    secret: "hmac-secret"
  }

Payload signed with HMAC-SHA256 before delivery
Retry logic: 3 attempts with exponential backoff
```

### SAML / Enterprise SSO
```
• SAML 2.0 support for enterprise workspaces
• Admin configures Identity Provider (IdP) metadata
• SP-initiated SSO flow
• User provisioning on first SAML login
• Gated behind Enterprise plan
```

### Data Migration Tools
```
• Asana Import: migrate projects, tasks, assignees from Asana
• Slack Migration: import Slack channel history and members
• Both accessible from admin settings
• Preserves original timestamps and user attribution
```

### Time Tracking
```
• Per-task time tracking panel
• Start / stop timer on any task
• Manual time entry
• Time logs visible on task detail
• Aggregate reports per project / user
```

### SLA Management
```
• Define SLA policies per project or task type
• Breach detection and alerting
• SLA status shown on task cards
• Reports on SLA compliance rate
```

---

## 19. COMPLETE DATA FLOW DIAGRAMS

### End-to-End: User Signs In → AI Chat Response
```
[Mobile/Browser]
  │
  │  POST /attendance/sign-in
  │  Authorization: Bearer <jwt>
  ▼
[Backend: authenticateToken]
  │  Decode JWT → { user_id, workspace_id, role }
  │  attachWorkspace → confirm workspace active
  ▼
[attendance.service.js: markSignIn]
  │  getOpenSessionId → check no open session (idempotency guard)
  │  INSERT attendance_events (SIGN_IN)
  │  Recalculate attendance_daily
  ▼
[sendAttendanceSlack] (fire-and-forget, non-blocking)
  │
  ├─ Slack webhook → POST to slack.com (async)
  │
  └─ Chat message path:
       ensureSystemUser(workspaceId)
         → SELECT users WHERE email = 'ai+{workspaceId}@example.com'
         → If not exists: INSERT user (role=system, is_system=true)
         → INSERT system_users (workspace_id, user_id)  ← FIXED Apr 2026
       createChatMessage(channelId, systemUserId, "John signed in at 9:00 AM")
         → INSERT chat_messages
         → Emit Socket.IO 'chat_message' to channel room
         → Check if AI channel → AI auto-reply pipeline starts

[Socket.IO]
  └─ All channel members receive real-time 'chat_message' event
  └─ Frontend React updates chat UI instantly
```

### End-to-End: Autopilot Daily Standup
```
11:00 AM (server time)
  │
  ▼
[node-cron: "0 11 * * *"]
  │
  │  Query: SELECT workspace_id FROM autopilot_settings
  │         WHERE enabled=true AND auto_generate_standup=true
  ▼
For each workspace:
  │
  │  isWorkingDayForWorkspace(workspaceId, today)
  │    → Query workspace_work_schedule (work_days array)
  │    → Check today's DOW is in work_days
  │    → Query workspace_holidays for today
  │    → If non-working → SKIP
  │
  │  getStandupLookbackSince(workspaceId, standupHour=11)
  │    → Walk backward day by day (max 14 days)
  │    → Find last working day
  │    → Return since: {lastWorkingDay at 11:00 AM}
  │    → Return label: "since yesterday" | "since Friday (Apr 3)"
  ▼
runAutopilotAnalysis({ workspaceId, skipStandup: false, sinceTimestamp, periodLabel })
  │
  ▼
generateStandupSummary(workspaceId, projectId, settings, sinceTimestamp, periodLabel)
  │
  │  Query: projects with activity since sinceTimestamp::timestamptz
  │  Query: status changes since sinceTimestamp::timestamptz
  │  Query: new tasks since sinceTimestamp::timestamptz
  │  Query: blocked/overdue tasks (current state, no time filter)
  ▼
POST :5005/standup
Body: { workspaceData, projectData, period: "since Friday (Apr 3)" }
  │
  ▼
[AI Microservice]
  │  Build standup prompt with period label
  │  Call LLM
  │  Return standup markdown
  ▼
[Backend]
  │  Post standup as Autopilot system user to standup channel
  │  INSERT chat_messages
  │  Emit Socket.IO
  │  notifyAdminsOfAutopilotRun (if actionsCreated > 0)
  ▼
[All workspace members see standup in chat]
```

### End-to-End: Leave Request → Approval
```
[User]
  │  POST /leave/request
  │  Body: { type: "annual", start_date: "2026-05-01", end_date: "2026-05-03" }
  ▼
[leave.controller.js]
  │  Calculate business days (3 requested, 2 after holiday filter = 2 days)
  │  Check leave_balances: user has 8 annual days → sufficient
  │  Check leave_policy: min_notice_days = 3 → today+3 ≤ May 1 → OK
  │  INSERT leave_requests (status: pending)
  ▼
[notification.service.js]
  │  notifyUser(manager_id, type: "leave_request", message: "John requested 2 days annual leave")
  │  Socket.IO emit to manager's room
  │  (Optional) Slack notification to manager channel
  ▼
[Manager sees notification → navigates to Leave > Admin tab]
  │
  │  POST /leave/:id/approve
  │  Body: { comment: "Approved" }
  ▼
[leave.controller.js]
  │  UPDATE leave_requests SET status = 'approved'
  │  UPDATE leave_balances SET used = used + 2 WHERE user_id = ? AND type = 'annual'
  │  notifyUser(user_id, type: "leave_status", message: "Your leave was approved")
  └─ User sees notification → navigates to Leave > My Leave tab
```

---

## 20. CODEBASE VALUATION

> This section is for internal reference only.

---

### What Is Actually Built (Full Inventory)

| Platform | Status |
|---|---|
| Web app (browser) | ✅ Complete |
| Desktop — Windows (NSIS installer + Portable .exe) | ✅ Complete |
| Desktop — macOS (DMG, Intel x64 + Apple Silicon arm64) | ✅ Complete |
| Desktop — Linux (AppImage + .deb) | ✅ Complete |
| Mobile — iOS (Capacitor, Xcode project) | ✅ Complete |
| Mobile — Android (Capacitor, Gradle project) | ✅ Complete |
| Backend API (54 route groups) | ✅ Complete |
| AI Microservice (autopilot, chat, standup, intelligence) | ✅ Complete |
| Real-time (Socket.IO across all features) | ✅ Complete |
| Video / Voice — built-in WebRTC huddle | ✅ Complete |
| Razorpay billing (UPI AutoPay, Cards, NACH, mandates) | ✅ Complete |
| AWS S3 file storage | ✅ Complete |
| SAML / Enterprise SSO | ✅ Complete |
| Asana import + Slack migration tools | ✅ Complete |
| Time tracking per task | ✅ Complete |
| SLA management | ✅ Complete |
| Automated test suite | ❌ None |

---

### Honest Valuation — April 2026

**Context: AI can write code now. Raw lines of code have no value. What has value:**
- The 6-platform distribution (Web + 3 desktop + 2 mobile) from one codebase — hard to architect even with AI
- WebRTC video/voice built in — no Zoom/Meet dependency
- AI features that are native to real workflows, not a chatbot bolted on
- Razorpay with recurring mandates, grace periods, and webhook HMAC — always messy to get right
- SAML/SSO — unlocks enterprise sales
- The complete HR stack (leave, reviews, OKR, attendance) alongside task management
- The data model and multi-tenant discipline across 40+ tables

**The one number that determines everything: Monthly Recurring Revenue (MRR)**

---

### Valuation by Scenario

**TODAY — 0 customers**
```
You have: a fully built, 6-platform, AI-native workforce product
You don't have: proof anyone will pay for it

As-is value:  ₹20–35 lakhs

Why not more: AI coding means someone could rebuild this in 3–4 months.
              No customers = no proof of market fit.
Why not less:  Mobile + desktop + WebRTC + billing + SAML already done.
               That's genuinely 3–4 months even with AI.
               Replacing all that with nothing is not free.
```

**5–10 paying customers (~₹50,000–1,00,000/month MRR)**
```
ARR ≈ ₹6–12 lakhs
Standard early-stage India SaaS multiple: 15–25x ARR

Value: ₹50 lakhs – ₹1.2 crore

The jump from 0 to 10 customers is the biggest value multiplier
in the entire life of this product.
```

**20–30 paying customers (~₹2–3 lakh/month MRR)**
```
ARR ≈ ₹24–36 lakhs
Multiple: 15–30x

Value: ₹1.5 – ₹3.5 crore

At this point it is fundable (angel / pre-seed) or
acquirable by a mid-size HR or SaaS company.
```

**Strategic acquirer — Keka, Zoho, Freshworks, etc.**
```
They are buying:
  • AI-native product they do not have
  • 6-platform distribution from a single codebase
  • A team that built and maintains it
  • Indian market positioning

Could pay: ₹5–15 crore
Condition: product must be live with real users and credible traction.
```

---

### What Changes the Number Most

| Factor | Impact |
|---|---|
| First 10 paying customers | Single biggest jump — from ₹35L to ₹1 crore+ |
| Add automated test suite | Removes the #1 technical red flag for investors |
| Switch default LLM to OpenAI/Anthropic | Makes it production-deployable immediately |
| 30 customers + ₹2L MRR | Fundable / acquirable territory |
| Real case studies with named clients | Unlocks enterprise pipeline |

---

### The One Real Gap

The only significant technical weakness is **no automated tests**. Every other gap that was listed earlier (no mobile app, local disk storage, no mobile, no SSO) does not apply — those are all built. The absence of tests means every future code change carries silent regression risk. With AI this is fixable in 1–2 weeks but it has to actually be done.

---

*Document prepared: April 2026 · Architecture Version: 2.0*
*Covers: Task-management-be (Backend) · Task-management / Proxima (Web + Desktop + Mobile) · ai-task (AI Microservice)*
