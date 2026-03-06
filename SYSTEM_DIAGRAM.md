# Strategic Intelligence System - Visual Architecture

## 🏗️ Complete System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           FRONTEND (React)                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │  Strategic Intelligence Tab                                          │  │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐                     │  │
│  │  │ Workspace  │  │  Project   │  │    Task    │  ← Scope Selector  │  │
│  │  └────────────┘  └────────────┘  └────────────┘                     │  │
│  │                                                                       │  │
│  │  ┌─────────────────────────────────────────────┐                     │  │
│  │  │ Select Project/Task (if needed)             │                     │  │
│  │  └─────────────────────────────────────────────┘                     │  │
│  │                                                                       │  │
│  │  ┌─────────────────────────────────────────────┐                     │  │
│  │  │ Question Input                              │                     │  │
│  │  │ "What are the operational risks?"           │                     │  │
│  │  └─────────────────────────────────────────────┘                     │  │
│  │                                                                       │  │
│  │  [🧠 Analyze Button]                                                 │  │
│  │                                                                       │  │
│  │  ┌─────────────────────────────────────────────┐                     │  │
│  │  │ 💬 AI Response                              │                     │  │
│  │  │ ─────────────────────────────────────────── │                     │  │
│  │  │                                             │                     │  │
│  │  │ Based on workspace data, three risks        │                     │  │
│  │  │ identified:                                 │                     │  │
│  │  │                                             │                     │  │
│  │  │ • Declining performance trend               │                     │  │
│  │  │ • Low completion rate (45%)                 │                     │  │
│  │  │ • Negative forecast                         │                     │  │
│  │  │                                             │                     │  │
│  │  └─────────────────────────────────────────────┘                     │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
└──────────────────────────────────────┬───────────────────────────────────────┘
                                       │
                                       │ HTTP POST /ai/intelligence-query
                                       │ Authorization: Bearer JWT_TOKEN
                                       │ Body: { scope, entityId?, question }
                                       │
                                       ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│                           BACKEND (Node.js)                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────┐    │
│  │  Express Server (index.js)                                         │    │
│  └────────────────────────┬───────────────────────────────────────────┘    │
│                           │                                                 │
│                           ↓                                                 │
│  ┌────────────────────────────────────────────────────────────────────┐    │
│  │  Middleware Stack                                                  │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐            │    │
│  │  │ Auth         │→ │ Workspace    │→ │ Route        │            │    │
│  │  │ Middleware   │  │ Middleware   │  │ Handler      │            │    │
│  │  └──────────────┘  └──────────────┘  └──────────────┘            │    │
│  │       ↓                    ↓                 ↓                      │    │
│  │  Validate JWT     Resolve workspaceId   ai.routes.js              │    │
│  └────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│                           ↓                                                 │
│  ┌────────────────────────────────────────────────────────────────────┐    │
│  │  AI Routes (ai/ai.routes.js)                                       │    │
│  │  POST /intelligence-query                                          │    │
│  └────────────────────────┬───────────────────────────────────────────┘    │
│                           │                                                 │
│                           ↓                                                 │
│  ┌────────────────────────────────────────────────────────────────────┐    │
│  │  AI Intelligence Service (ai/ai.intelligence.service.js)           │    │
│  │                                                                     │    │
│  │  runAIIntelligenceQuery()                                          │    │
│  │    1. Build context                                                │    │
│  │    2. Construct prompt                                             │    │
│  │    3. Call LLM                                                     │    │
│  │    4. Return answer                                                │    │
│  └────────────────────────┬───────────────────────────────────────────┘    │
│                           │                                                 │
│                           ├──────────────┐                                  │
│                           │              │                                  │
│                           ↓              ↓                                  │
│  ┌─────────────────────────────┐  ┌──────────────────────────────────┐    │
│  │  AI Context Builder         │  │  LLM Client                      │    │
│  │  (ai.context.builder.js)    │  │  (intelligence/llm/llmClient.js) │    │
│  │                             │  │                                  │    │
│  │  buildAIContext()           │  │  generateText()                  │    │
│  │                             │  │                                  │    │
│  │  Scope-based data:          │  │  Multi-provider support:         │    │
│  │  ┌────────────────────┐    │  │  ┌────────────────────┐          │    │
│  │  │ WORKSPACE          │    │  │  │ • Ollama (local)   │          │    │
│  │  │ - Score history    │    │  │  │ • Groq (cloud)     │          │    │
│  │  │ - Execution data   │    │  │  │ • HuggingFace      │          │    │
│  │  │ - Forecast         │    │  │  │ • OpenAI           │          │    │
│  │  └────────────────────┘    │  │  │ • Grok/xAI         │          │    │
│  │                             │  │  └────────────────────┘          │    │
│  │  ┌────────────────────┐    │  │                                  │    │
│  │  │ PROJECT            │    │  └────────────┬─────────────────────┘    │
│  │  │ - All tasks        │    │               │                          │
│  │  │ - Overdue count    │    │               │                          │
│  │  │ - Task stats       │    │               │                          │
│  │  └────────────────────┘    │               ↓                          │
│  │                             │  ┌──────────────────────────────────┐    │
│  │  ┌────────────────────┐    │  │  LLM Provider (External)         │    │
│  │  │ TASK               │    │  │                                  │    │
│  │  │ - Task details     │    │  │  Ollama: http://localhost:11434  │    │
│  │  │ - Activity logs    │    │  │  Groq:   api.groq.com            │    │
│  │  └────────────────────┘    │  │  Others: api.openai.com, etc.    │    │
│  └──────────┬──────────────────┘  └──────────────────────────────────┘    │
│             │                                                               │
│             ↓                                                               │
│  ┌────────────────────────────────────────────────────────────────────┐    │
│  │  PostgreSQL Database                                               │    │
│  │                                                                     │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐    │    │
│  │  │ tasks        │  │ projects     │  │ task_activity_logs   │    │    │
│  │  ├──────────────┤  ├──────────────┤  ├──────────────────────┤    │    │
│  │  │ id           │  │ id           │  │ id                   │    │    │
│  │  │ project_id   │  │ name         │  │ task_id              │    │    │
│  │  │ status       │  │ workspace_id │  │ workspace_id         │    │    │
│  │  │ assigned_to  │  │ ...          │  │ actor_id             │    │    │
│  │  │ due_date     │  └──────────────┘  │ action_type          │    │    │
│  │  │ ...          │                    │ old_value (JSONB)    │    │    │
│  │  └──────────────┘                    │ new_value (JSONB)    │    │    │
│  │                                      │ created_at           │    │    │
│  │  ┌──────────────────────────────┐   └──────────────────────┘    │    │
│  │  │ workspace_monthly_scores     │                               │    │
│  │  ├──────────────────────────────┤                               │    │
│  │  │ workspace_id                 │   Action Types:               │    │
│  │  │ user_id                      │   • TASK_CREATED              │    │
│  │  │ month                        │   • STATUS_CHANGED            │    │
│  │  │ score                        │   • ASSIGNEE_CHANGED          │    │
│  │  │ reasoning (JSONB)            │   • PRIORITY_CHANGED          │    │
│  │  │ ...                          │   • DESCRIPTION_UPDATED       │    │
│  │  └──────────────────────────────┘   • COMMENT_ADDED            │    │
│  │                                      • TASK_DELETED             │    │
│  └────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 📊 Data Flow Diagram

### Workspace Query Flow

```
User: "What are the operational risks?"
  │
  ├─ Scope: workspace
  │
  ↓
[Context Builder]
  │
  ├─ Query: workspace_monthly_scores
  │    └─> Returns: [75, 72, 70, 68, 65, 62] (last 6 months)
  │
  ├─ Query: getExecutionSnapshot()
  │    └─> Returns: { totalWork: 520, completedWork: 234, completionRate: 0.45 }
  │
  ├─ Compute: advancedForecast()
  │    └─> Returns: { trend: "declining", confidence: 0.68, trajectory: -0.12 }
  │
  ↓
[Prompt Construction]
  │
  ├─ System: "You are Strategic Intelligence..."
  ├─ Question: "What are the operational risks?"
  ├─ Context: { scoreHistory, execution, forecast }
  ├─ Instructions: "Be precise, identify risks, executive tone..."
  │
  ↓
[LLM Provider (Groq)]
  │
  ├─ Process prompt
  ├─ Generate analysis
  │
  ↓
[Response]
  │
  └─> "Based on workspace data, three primary risks identified:
       1. Declining performance trend (75→62)
       2. Low completion rate (45%)
       3. Negative forecast (-12% trajectory)

       Recommended: Immediate review, workload rebalancing..."
```

### Project Query Flow

```
User: "Why is project X delayed?"
  │
  ├─ Scope: project
  ├─ EntityId: "project-uuid-123"
  │
  ↓
[Context Builder]
  │
  ├─ Query: SELECT * FROM tasks WHERE project_id = 'project-uuid-123'
  │    └─> Returns: 24 tasks
  │         - 4 completed
  │         - 12 in_progress
  │         - 8 overdue
  │
  ↓
[AI Analysis]
  │
  └─> "Project delay root cause:
       - 33% tasks overdue (8/24)
       - 50% stuck in progress (12/24)
       - Only 16.7% completion rate

       Immediate intervention required."
```

### Task Query Flow

```
User: "Summarize task history"
  │
  ├─ Scope: task
  ├─ EntityId: "task-uuid-456"
  │
  ↓
[Context Builder]
  │
  ├─ Query: SELECT * FROM tasks WHERE id = 'task-uuid-456'
  │    └─> Returns: { id, title, status, priority, ... }
  │
  ├─ Query: SELECT * FROM task_activity_logs WHERE task_id = 'task-uuid-456'
  │    └─> Returns: [
  │         { action: "TASK_CREATED", date: "2026-01-15" },
  │         { action: "ASSIGNEE_CHANGED", old: "John", new: "Sarah" },
  │         { action: "PRIORITY_CHANGED", old: "medium", new: "high" },
  │         { action: "STATUS_CHANGED", old: "todo", new: "in_progress" },
  │         { action: "ASSIGNEE_CHANGED", old: "Sarah", new: "Mike" },
  │         { action: "STATUS_CHANGED", old: "in_progress", new: "completed" }
  │       ]
  │
  ↓
[AI Analysis]
  │
  └─> "Task lifecycle:
       - Created Jan 15
       - Reassigned twice (John→Sarah→Mike)
       - Priority escalated (medium→high)
       - Completed Jan 25

       Concern: Multiple reassignments suggest unclear initial scoping."
```

## 🔄 Activity Logging Flow

```
User Action (e.g., change task status)
  │
  ↓
[Task Service]
  │
  ├─ Update task record
  │   UPDATE tasks SET status = 'completed'
  │
  ├─ Log activity
  │   INSERT INTO task_activity_logs
  │   (task_id, workspace_id, actor_id, action_type, old_value, new_value)
  │   VALUES (...)
  │
  ↓
[Database]
  │
  └─> Activity log stored for future AI analysis
```

## 🎯 Integration Points

### 1. Existing Systems Used

```
Strategic Intelligence
  │
  ├─ Uses: intelligence/forecast/forecast.engine.js
  │   └─> advancedForecast() - existing forecast system
  │
  ├─ Uses: intelligence/executionSnapshot.service.js
  │   └─> getExecutionSnapshot() - existing metrics
  │
  ├─ Uses: services/ai.system.service.js
  │   └─> ensureSystemUser() - existing AI user management
  │
  └─ Uses: services/notification.service.js (future)
      └─> notifyUser() - for proactive alerts
```

### 2. New Systems Created

```
Strategic Intelligence
  │
  ├─ NEW: ai/ai.intelligence.service.js
  │   └─> Query processing
  │
  ├─ NEW: ai/ai.context.builder.js
  │   └─> Data aggregation
  │
  ├─ NEW: task_activity_logs table
  │   └─> Complete audit trail
  │
  └─ ENHANCED: intelligence/llm/llmClient.js
      └─> Multi-provider support (5 providers)
```

## 📱 User Journey

```
1. User opens Dashboard
   │
   ├─> Navigates to "Strategic Intelligence" tab
   │
   ↓
2. Selects scope (Workspace/Project/Task)
   │
   ├─> If Project/Task: Selects entity from dropdown
   │
   ↓
3. Types question or clicks quick question
   │
   ↓
4. Clicks "🧠 Analyze" button
   │
   ├─> Loading indicator shown
   │
   ↓
5. Backend processes request
   │
   ├─> 2-10 seconds (depending on LLM provider)
   │
   ↓
6. Response displayed
   │
   ├─> Markdown formatted
   ├─> Key insights highlighted
   ├─> AI attribution shown
   │
   ↓
7. User can:
   │
   ├─> Ask follow-up question
   ├─> Change scope
   ├─> Copy response
   └─> Export/share (future feature)
```

---

**Architecture Version:** 1.0.0
**Last Updated:** March 5, 2026
