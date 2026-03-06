# Strategic Intelligence API - Quick Reference

## 🚀 Quick Start

```bash
# Install any required packages on frontend
npm install axios react-markdown
```

## 📡 Endpoint

```
POST /ai/intelligence-query
```

## 🔐 Authentication

```typescript
headers: {
  'Authorization': 'Bearer YOUR_JWT_TOKEN',
  'Content-Type': 'application/json'
}
```

## 📋 Request Body

```typescript
{
  scope: "workspace" | "project" | "task",
  entityId?: string,  // Required for project/task
  question: string
}
```

## ✅ Success Response (200)

```typescript
{
  success: true,
  answer: string,      // AI-generated response
  aiUser: {
    id: string,
    username: string
  }
}
```

## ❌ Error Responses

| Code | Error | Meaning |
|------|-------|---------|
| 400 | `scope and question required` | Missing required fields |
| 401 | `Unauthorized` | Invalid/missing JWT token |
| 403 | `Access denied` | No workspace permission |
| 500 | `Strategic intelligence failed` | LLM service error |

## 🧪 cURL Examples

### Workspace Query

```bash
curl -X POST http://localhost:3000/ai/intelligence-query \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "scope": "workspace",
    "question": "What are the operational risks?"
  }'
```

### Project Query

```bash
curl -X POST http://localhost:3000/ai/intelligence-query \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "scope": "project",
    "entityId": "project-uuid-here",
    "question": "Why is this project delayed?"
  }'
```

### Task Query

```bash
curl -X POST http://localhost:3000/ai/intelligence-query \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "scope": "task",
    "entityId": "task-uuid-here",
    "question": "Summarize this task history"
  }'
```

## 💻 JavaScript/TypeScript Example

```typescript
import axios from 'axios';

async function queryIntelligence(
  scope: 'workspace' | 'project' | 'task',
  question: string,
  entityId?: string
) {
  try {
    const response = await axios.post(
      '/ai/intelligence-query',
      {
        scope,
        question,
        ...(entityId && { entityId })
      },
      {
        headers: {
          'Authorization': `Bearer ${getToken()}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data;
  } catch (error) {
    console.error('Intelligence query failed:', error);
    throw error;
  }
}

// Usage
const result = await queryIntelligence(
  'workspace',
  'What are the operational risks this month?'
);

console.log(result.answer);
```

## 🎯 Context Data Provided to AI

The AI receives structured context based on scope:

### Workspace Scope
- **Score History**: Last 6 months of performance scores
- **Execution Snapshot**: Total work, completed work, completion rate
- **Forecast**: Trend, momentum, trajectory, risk projection

### Project Scope
- **All Tasks**: Status, due dates, assignments
- **Overdue Count**: Number of overdue tasks
- **Total Tasks**: Total task count

### Task Scope
- **Task Details**: All task fields
- **Activity Logs**: Full history of changes
  - Status changes
  - Assignee changes
  - Priority changes
  - Comments added
  - Descriptions updated

## 📊 Sample Questions by Scope

### Workspace
- "What are the operational risks this month?"
- "How is workspace performance trending?"
- "What is the forecast for next month?"
- "Which teams are underperforming?"
- "What's the overall health status?"

### Project
- "Why is this project delayed?"
- "What are the project risks?"
- "How many tasks are overdue?"
- "What's blocking completion?"
- "Which assignees need support?"

### Task
- "Summarize this task's history"
- "Why was this task reassigned?"
- "What delays occurred?"
- "How many status changes happened?"
- "What's the root cause of delays?"

## ⚡ Performance Notes

- **Average Response Time**: 2-10 seconds (depends on LLM provider)
- **Max Question Length**: 1000 characters
- **Max Context Size**: 50,000 characters (auto-limited)
- **Rate Limits**: Depends on LLM provider
  - Groq (free): 30 req/min
  - HuggingFace (free): ~10 req/min
  - OpenAI (paid): Varies by plan

## 🛠️ Troubleshooting

| Issue | Solution |
|-------|----------|
| "Invalid JSON" | Check request body syntax |
| "Unauthorized" | Verify JWT token is valid |
| "Context too large" | Use more specific scope/question |
| "LLM timeout" | Retry or switch provider |
| "Out of memory" | Backend Ollama issue - use Groq instead |


## 📝 Notes

- Workspace is auto-detected from JWT token
- Do NOT send `workspaceId` in request body
- AI responses are non-deterministic (may vary slightly)
- Responses are limited to ~180 words for conciseness
- All responses use professional executive tone

---

**Backend Version:** 1.0.0
**Last Updated:** March 5, 2026
