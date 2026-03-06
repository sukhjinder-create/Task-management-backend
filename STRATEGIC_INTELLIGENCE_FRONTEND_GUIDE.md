# Strategic Intelligence - Frontend Implementation Guide

## 📋 Table of Contents

1. [Overview](#overview)
2. [API Specification](#api-specification)
3. [Authentication](#authentication)
4. [Request/Response Examples](#requestresponse-examples)
5. [Frontend Architecture](#frontend-architecture)
6. [UI/UX Recommendations](#uiux-recommendations)
7. [React Component Example](#react-component-example)
8. [Error Handling](#error-handling)
9. [Testing](#testing)
10. [LLM Provider Options](#llm-provider-options)

---

## Overview

**Strategic Intelligence** is an AI-powered operational analytics feature that provides executive-level insights based on workspace data.

### Key Differences from Chat AI

| Feature | Chat AI | Strategic Intelligence |
|---------|---------|----------------------|
| **Purpose** | Collaboration, quick help | Decision support, analytics |
| **Scope** | Channel-based | Workspace/Project/Task |
| **Data** | Chat history | Structured operational data |
| **Output** | Conversational | Executive summaries |
| **Location** | Chat channels | Dedicated Intelligence tab |

---

## API Specification

### Endpoint

```
POST /ai/intelligence-query
```

### Headers

```http
Authorization: Bearer {JWT_TOKEN}
Content-Type: application/json
```

**Note:** The workspace is automatically extracted from the JWT token via middleware.

### Request Body

```typescript
interface IntelligenceQueryRequest {
  scope: "workspace" | "project" | "task";
  entityId?: string;  // Required for project/task scope
  question: string;
}
```

### Response

```typescript
interface IntelligenceQueryResponse {
  success: boolean;
  answer: string;
  aiUser: {
    id: string;
    username: string;
  };
}
```

### Error Response

```typescript
interface ErrorResponse {
  error: string;
  details?: string;
  hint?: string;
}
```

---

## Authentication

### Requirements

- Valid JWT token in `Authorization` header
- User must have access to the workspace
- No special permissions required (all workspace members can use)

### How Workspace is Resolved

The backend automatically extracts `workspaceId` from the authenticated user's session via the `requireWorkspaceForUser` middleware. **Do NOT send workspaceId in the request body.**

---

## Request/Response Examples

### Example 1: Workspace-Level Query

**Request:**
```http
POST /ai/intelligence-query
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
Content-Type: application/json

{
  "scope": "workspace",
  "question": "What are the operational risks this month?"
}
```

**Response:**
```json
{
  "success": true,
  "answer": "Based on workspace performance data, three primary operational risks are identified:\n\n1. **Declining Performance Trend**: Average workspace score decreased from 78 to 72 over the past 3 months, indicating systematic execution issues.\n\n2. **Low Completion Rate**: Current execution snapshot shows 45% completion rate (234/520 tasks), below healthy threshold of 70%.\n\n3. **Negative Forecast**: Predictive models indicate continued decline with 68% confidence unless corrective action is taken.\n\n**Recommended Actions**: Immediate performance review, workload rebalancing, and enhanced coaching interventions for underperforming team members.",
  "aiUser": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "username": "AI Assistant"
  }
}
```

### Example 2: Project-Level Query

**Request:**
```http
POST /ai/intelligence-query
Authorization: Bearer {token}
Content-Type: application/json

{
  "scope": "project",
  "entityId": "886da598-6ae9-4c6a-950a-dca35d7a0b65",
  "question": "Why is this project delayed?"
}
```

**Response:**
```json
{
  "success": true,
  "answer": "Project delay root cause analysis:\n\n**Primary Issue**: 8 of 24 tasks (33%) are overdue.\n\n**Contributing Factors**:\n- 12 tasks still in 'in_progress' status for extended periods\n- Only 4 tasks completed out of 24 total\n- No clear assignee pattern suggests resource allocation issues\n\n**Leadership Concern**: Completion rate of 16.7% indicates this project requires immediate intervention. Recommend project health review and potential sprint reset.",
  "aiUser": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "username": "AI Assistant"
  }
}
```

### Example 3: Task-Level Query

**Request:**
```http
POST /ai/intelligence-query
Authorization: Bearer {token}
Content-Type: application/json

{
  "scope": "task",
  "entityId": "a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d",
  "question": "Summarize the history of this task"
}
```

**Response:**
```json
{
  "success": true,
  "answer": "Task Activity Summary:\n\n**Created**: January 15, 2026\n**Status Changes**: 3 transitions (todo → in_progress → completed)\n**Assignee Changes**: Reassigned twice (John → Sarah → Mike)\n**Priority**: Escalated from 'medium' to 'high' on Jan 20\n\n**Key Events**:\n- Jan 15: Task created\n- Jan 18: Reassigned to Sarah due to workload\n- Jan 20: Priority increased after stakeholder feedback\n- Jan 22: Reassigned to Mike for domain expertise\n- Jan 25: Completed\n\n**Concern**: Multiple reassignments suggest unclear initial scoping or resource planning issues.",
  "aiUser": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "username": "AI Assistant"
  }
}
```

### Example 4: Error Response

**Request:**
```http
POST /ai/intelligence-query
Authorization: Bearer {token}
Content-Type: application/json

{
  "scope": "project"
  // Missing: entityId and question
}
```

**Response (400 Bad Request):**
```json
{
  "error": "scope and question required"
}
```

---

## Frontend Architecture

### Recommended UI Structure

```
App
└── Dashboard
    └── Strategic Intelligence Tab
        ├── Scope Selector (Workspace/Project/Task)
        ├── Entity Selector (when scope = project/task)
        ├── Question Input
        ├── Submit Button
        └── Response Display Area
            ├── Loading State
            ├── Answer Display (Markdown formatted)
            ├── AI Attribution
            └── Error Display
```

### State Management

```typescript
interface IntelligenceState {
  scope: "workspace" | "project" | "task";
  selectedEntityId: string | null;
  question: string;
  isLoading: boolean;
  answer: string | null;
  error: string | null;
  aiUser: { id: string; username: string } | null;
}
```

---

## UI/UX Recommendations

### Layout Design

```
┌─────────────────────────────────────────────────────────┐
│  Strategic Intelligence                            [?]   │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  Scope:  [Workspace ▾] [Project ▾] [Task ▾]            │
│                                                          │
│  Entity: [Select Project...        ▾]                   │
│          (Only shown for Project/Task scope)            │
│                                                          │
│  ┌────────────────────────────────────────────────────┐ │
│  │ Ask a question...                                  │ │
│  │                                                    │ │
│  │ Example: "What are the operational risks?"        │ │
│  └────────────────────────────────────────────────────┘ │
│                                                          │
│                                         [Analyze] 🧠     │
│                                                          │
│  ┌────────────────────────────────────────────────────┐ │
│  │ 💬 AI Response                                     │ │
│  │────────────────────────────────────────────────────│ │
│  │                                                    │ │
│  │ Based on workspace performance data...            │ │
│  │                                                    │ │
│  │ • Declining performance trend                     │ │
│  │ • Low completion rate (45%)                       │ │
│  │ • Negative forecast trajectory                    │ │
│  │                                                    │ │
│  │ Recommended Actions:                              │ │
│  │ - Immediate performance review                    │ │
│  │ - Workload rebalancing                           │ │
│  │                                                    │ │
│  │ ─────────────────────────────────────────────────  │ │
│  │ Generated by AI Assistant                         │ │
│  └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### Suggested Question Prompts (Quick Actions)

Based on scope, show example questions:

**Workspace Scope:**
- "What are the operational risks this month?"
- "How is workspace performance trending?"
- "Which areas need immediate attention?"
- "What is the forecast for next month?"

**Project Scope:**
- "Why is this project delayed?"
- "What are the project risks?"
- "How many tasks are overdue?"
- "What's blocking completion?"

**Task Scope:**
- "Summarize this task's history"
- "Why was this task reassigned?"
- "What delays occurred?"
- "What are the activity patterns?"

### Visual Design

**Color Coding:**
- 🔴 High Risk → Red highlights
- 🟡 Medium Risk → Yellow/Orange
- 🟢 Low Risk → Green
- 🔵 Informational → Blue

**Typography:**
- Use markdown rendering for AI responses
- Bold for key insights
- Bullet points for lists
- Monospace for metrics

---

## React Component Example

### Full Implementation

```typescript
import React, { useState } from 'react';
import axios from 'axios';
import ReactMarkdown from 'react-markdown';

const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:3000';

interface IntelligenceQueryRequest {
  scope: 'workspace' | 'project' | 'task';
  entityId?: string;
  question: string;
}

interface IntelligenceQueryResponse {
  success: boolean;
  answer: string;
  aiUser: {
    id: string;
    username: string;
  };
}

const StrategicIntelligence: React.FC = () => {
  const [scope, setScope] = useState<'workspace' | 'project' | 'task'>('workspace');
  const [entityId, setEntityId] = useState<string>('');
  const [question, setQuestion] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [response, setResponse] = useState<IntelligenceQueryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Get JWT token from your auth system
  const getAuthToken = () => {
    return localStorage.getItem('jwt_token'); // Adjust based on your auth system
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!question.trim()) {
      setError('Please enter a question');
      return;
    }

    if ((scope === 'project' || scope === 'task') && !entityId) {
      setError(`Please select a ${scope}`);
      return;
    }

    setIsLoading(true);
    setError(null);
    setResponse(null);

    try {
      const payload: IntelligenceQueryRequest = {
        scope,
        question,
      };

      if (scope !== 'workspace') {
        payload.entityId = entityId;
      }

      const result = await axios.post<IntelligenceQueryResponse>(
        `${API_BASE_URL}/ai/intelligence-query`,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${getAuthToken()}`,
            'Content-Type': 'application/json',
          },
        }
      );

      setResponse(result.data);
    } catch (err: any) {
      setError(
        err.response?.data?.error ||
        err.message ||
        'Failed to get AI response'
      );
    } finally {
      setIsLoading(false);
    }
  };

  const quickQuestions = {
    workspace: [
      "What are the operational risks this month?",
      "How is workspace performance trending?",
      "What is the forecast for next month?",
    ],
    project: [
      "Why is this project delayed?",
      "What are the project risks?",
      "How many tasks are overdue?",
    ],
    task: [
      "Summarize this task's history",
      "What delays occurred?",
      "Why was this task reassigned?",
    ],
  };

  return (
    <div className="strategic-intelligence-container">
      <div className="header">
        <h2>🧠 Strategic Intelligence</h2>
        <p className="subtitle">
          AI-powered operational analytics and decision support
        </p>
      </div>

      <form onSubmit={handleSubmit} className="query-form">
        {/* Scope Selector */}
        <div className="form-group">
          <label>Scope</label>
          <div className="scope-selector">
            <button
              type="button"
              className={scope === 'workspace' ? 'active' : ''}
              onClick={() => {
                setScope('workspace');
                setEntityId('');
              }}
            >
              🏢 Workspace
            </button>
            <button
              type="button"
              className={scope === 'project' ? 'active' : ''}
              onClick={() => setScope('project')}
            >
              📁 Project
            </button>
            <button
              type="button"
              className={scope === 'task' ? 'active' : ''}
              onClick={() => setScope('task')}
            >
              ✅ Task
            </button>
          </div>
        </div>

        {/* Entity Selector (for project/task) */}
        {scope !== 'workspace' && (
          <div className="form-group">
            <label>Select {scope}</label>
            <select
              value={entityId}
              onChange={(e) => setEntityId(e.target.value)}
              required
            >
              <option value="">Select {scope}...</option>
              {/* Populate from your project/task list */}
              <option value="project-uuid-1">Project Alpha</option>
              <option value="project-uuid-2">Project Beta</option>
            </select>
          </div>
        )}

        {/* Question Input */}
        <div className="form-group">
          <label>Ask a question</label>
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="What would you like to know?"
            rows={3}
            required
          />
        </div>

        {/* Quick Questions */}
        <div className="quick-questions">
          <small>Quick questions:</small>
          {quickQuestions[scope].map((q, idx) => (
            <button
              key={idx}
              type="button"
              className="quick-question-btn"
              onClick={() => setQuestion(q)}
            >
              {q}
            </button>
          ))}
        </div>

        {/* Submit Button */}
        <button
          type="submit"
          className="submit-btn"
          disabled={isLoading}
        >
          {isLoading ? '🔄 Analyzing...' : '🧠 Analyze'}
        </button>
      </form>

      {/* Loading State */}
      {isLoading && (
        <div className="loading-state">
          <div className="spinner"></div>
          <p>AI is analyzing your workspace data...</p>
        </div>
      )}

      {/* Error Display */}
      {error && (
        <div className="error-display">
          <strong>⚠️ Error</strong>
          <p>{error}</p>
        </div>
      )}

      {/* Response Display */}
      {response && (
        <div className="response-display">
          <div className="response-header">
            <span className="ai-badge">💬 AI Response</span>
            <span className="ai-attribution">
              by {response.aiUser.username}
            </span>
          </div>
          <div className="response-content">
            <ReactMarkdown>{response.answer}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
};

export default StrategicIntelligence;
```

### Suggested CSS

```css
.strategic-intelligence-container {
  max-width: 900px;
  margin: 0 auto;
  padding: 24px;
}

.header {
  margin-bottom: 32px;
}

.header h2 {
  font-size: 28px;
  font-weight: 600;
  margin-bottom: 8px;
}

.subtitle {
  color: #666;
  font-size: 14px;
}

.query-form {
  background: #f8f9fa;
  border-radius: 12px;
  padding: 24px;
  margin-bottom: 24px;
}

.form-group {
  margin-bottom: 20px;
}

.form-group label {
  display: block;
  font-weight: 500;
  margin-bottom: 8px;
  font-size: 14px;
}

.scope-selector {
  display: flex;
  gap: 8px;
}

.scope-selector button {
  flex: 1;
  padding: 12px;
  border: 2px solid #e0e0e0;
  background: white;
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
  transition: all 0.2s;
}

.scope-selector button.active {
  border-color: #4CAF50;
  background: #E8F5E9;
  font-weight: 600;
}

select,
textarea {
  width: 100%;
  padding: 12px;
  border: 1px solid #ddd;
  border-radius: 8px;
  font-size: 14px;
  font-family: inherit;
}

textarea {
  resize: vertical;
}

.quick-questions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}

.quick-question-btn {
  padding: 6px 12px;
  background: #E3F2FD;
  border: 1px solid #2196F3;
  border-radius: 16px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}

.quick-question-btn:hover {
  background: #2196F3;
  color: white;
}

.submit-btn {
  width: 100%;
  padding: 14px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  transition: transform 0.2s;
}

.submit-btn:hover:not(:disabled) {
  transform: translateY(-2px);
}

.submit-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.loading-state {
  text-align: center;
  padding: 40px;
  background: #f8f9fa;
  border-radius: 12px;
}

.spinner {
  width: 40px;
  height: 40px;
  border: 4px solid #f3f3f3;
  border-top: 4px solid #667eea;
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin: 0 auto 16px;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.error-display {
  background: #FFEBEE;
  border: 1px solid #EF5350;
  border-radius: 8px;
  padding: 16px;
  color: #C62828;
}

.response-display {
  background: white;
  border: 1px solid #e0e0e0;
  border-radius: 12px;
  padding: 24px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
}

.response-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid #e0e0e0;
}

.ai-badge {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  padding: 6px 12px;
  border-radius: 16px;
  font-size: 12px;
  font-weight: 600;
}

.ai-attribution {
  font-size: 12px;
  color: #666;
}

.response-content {
  line-height: 1.6;
  color: #333;
}

.response-content strong {
  color: #EF5350;
  font-weight: 600;
}

.response-content ul {
  margin-left: 20px;
}

.response-content li {
  margin-bottom: 8px;
}
```

---

## Error Handling

### Common Errors and Solutions

| Error | Cause | Solution |
|-------|-------|----------|
| `401 Unauthorized` | Missing/invalid JWT | Check token in localStorage |
| `403 Forbidden` | No workspace access | Verify user workspace permissions |
| `400 Bad Request: scope and question required` | Missing fields | Ensure scope and question are provided |
| `500 Strategic intelligence failed` | LLM error | Check backend logs, retry |
| `Network Error` | Backend down | Check API connection |

### Error Handling Best Practices

```typescript
try {
  const result = await axios.post(...);
  setResponse(result.data);
} catch (err: any) {
  if (err.response) {
    // Backend returned error
    switch (err.response.status) {
      case 400:
        setError('Invalid request. Please check your input.');
        break;
      case 401:
        setError('Session expired. Please login again.');
        // Redirect to login
        break;
      case 403:
        setError('Access denied to this workspace.');
        break;
      case 500:
        setError('AI service unavailable. Please try again later.');
        break;
      default:
        setError(err.response.data?.error || 'Something went wrong');
    }
  } else if (err.request) {
    // Network error
    setError('Cannot connect to server. Check your internet connection.');
  } else {
    setError('An unexpected error occurred.');
  }
}
```

---

## Testing

### Manual Testing Checklist

- [ ] Workspace scope query works
- [ ] Project scope query works (with entity selection)
- [ ] Task scope query works (with entity selection)
- [ ] Error handling for missing question
- [ ] Error handling for missing entityId (project/task scope)
- [ ] Error handling for invalid token
- [ ] Loading state displays correctly
- [ ] Response formatting (markdown) works
- [ ] Quick question buttons populate input
- [ ] Scope switching clears entityId

### Example Test Queries

**Workspace:**
```
"What are the operational risks this month?"
"How is workspace performance trending?"
"What is the completion rate?"
```

**Project:**
```
"Why is this project delayed?"
"How many tasks are overdue?"
"What are the project risks?"
```

**Task:**
```
"Summarize this task's history"
"What delays occurred?"
"How many times was this reassigned?"
```

---

## LLM Provider Options

The backend supports multiple LLM providers. Configuration is done via `.env` file on the backend.

### Current Providers

| Provider | Free? | Speed | Quality | Setup |
|----------|-------|-------|---------|-------|
| **Ollama** (Local) | ✅ Yes | Medium | Good | Complex |
| **Groq** | ✅ Yes (limits) | ⚡ Very Fast | Excellent | Easy |
| **HuggingFace** | ✅ Yes (limits) | Slow | Good | Easy |
| **OpenAI** | ❌ Paid | Fast | Excellent | Easy |
| **Grok (xAI)** | ❌ Paid | Fast | Excellent | Easy |

**Recommended for Production:** Groq (free, fast, reliable)

---

## Next Steps

1. **Implement UI Component**
   - Use the React component example above
   - Adjust styling to match your design system
   - Add project/task dropdowns populated from your data

2. **Add Navigation**
   - Create "Strategic Intelligence" tab in dashboard
   - Add icon/badge in sidebar

3. **Enhance UX**
   - Add query history (store recent questions)
   - Add "Copy response" button
   - Add "Export as PDF" feature
   - Add response rating system

4. **Add Analytics**
   - Track which questions are most common
   - Track response quality feedback
   - Monitor API usage

5. **Advanced Features (Future)**
   - Save favorite questions as templates
   - Schedule automated intelligence reports
   - Email summaries to managers
   - Multi-language support

---

## Support

**Backend API:** `POST /ai/intelligence-query`
**Authentication:** JWT Bearer token
**Workspace:** Auto-detected from user session

For issues or questions, contact the backend team or refer to the main architecture document.

---

**Last Updated:** March 5, 2026
**Version:** 1.0.0
**Author:** Strategic Intelligence Team
