// ai-platform/shadow/wave2.golden.js
//
// Representative golden set for the Epic B remainder. Each entry captures the
// legacy call-arg shape (input) and a deterministic representative legacy output.
// Used by the shadow harness for golden parity. Real-provider outputs are
// captured in staging; these hermetic goldens prove the machinery + structural
// (same-provider → same-output) parity. Pure data.

export const WAVE2_GOLDEN = Object.freeze([
  {
    capability: "meeting_intelligence",
    caseId: "case-1",
    input: { prompt: "Transcript: team agreed to ship v2 Friday; Sam owns QA. Produce decisions + action items.", maxTokens: 900, json: true },
    output: '{"decisions":["Ship v2 on Friday"],"actionItems":[{"owner":"Sam","task":"Own QA sign-off"}]}',
  },
  {
    capability: "huddle_topic_segmentation",
    caseId: "case-1",
    input: { prompt: "Segment this transcript into topics.", options: { num_predict: 400 }, json: true },
    output: '{"segments":[{"topic":"Release planning","start":0},{"topic":"QA ownership","start":120}]}',
  },
  {
    capability: "huddle_risk_blocker_extraction",
    caseId: "case-1",
    input: { prompt: "Extract risks and blockers from the transcript.", options: { num_predict: 400 }, json: true },
    output: '{"risks":["QA capacity"],"blockers":["staging env unstable"]}',
  },
  {
    capability: "huddle_language_normalization",
    caseId: "case-1",
    input: { prompt: "Normalize the transcript language.", options: { num_predict: 300 } },
    output: "Normalized transcript with consistent terminology and resolved speaker labels.",
  },
  {
    capability: "huddle_copilot",
    caseId: "case-1",
    input: { prompt: "What did the team decide about the release?", maxTokens: 400 },
    output: "The team decided to ship v2 on Friday, with Sam owning QA sign-off.",
  },
  {
    capability: "workspace_assistant",
    caseId: "case-1",
    input: { prompt: "Is Amrinder available right now, and what are they working on?", maxTokens: 300 },
    output: "Amrinder is currently signed in and available, working on the login-bug fix and two open review tasks.",
  },
  {
    capability: "ai_features",
    caseId: "case-1",
    input: { prompt: "Suggest a concise title for a task about fixing the OAuth redirect.", maxTokens: 200 },
    output: "Fix OAuth redirect on login callback",
  },
  {
    capability: "nl_task_creation",
    caseId: "case-1",
    input: { prompt: "Create a task: fix login bug by Friday, assign to Sam, high priority.", maxTokens: 2000, json: true },
    output: '{"title":"Fix login bug","assignee":"Sam","dueDate":"Friday","priority":"high"}',
  },
  {
    capability: "autopilot_standup",
    caseId: "case-1",
    input: { prompt: "Generate a standup summary for project Phoenix for 2026-07-05.", maxTokens: 900 },
    output: "Phoenix standup: 6 tasks completed, 2 in progress, 1 blocker (staging env). On track for Friday release.",
  },
  {
    capability: "browser_agent",
    caseId: "case-1",
    input: { prompt: "Given the current page, decide the next browser action to reach the settings page.", maxTokens: 150 },
    output: 'Click the navigation menu, then select "Settings".',
  },
  {
    capability: "testing_agent",
    caseId: "case-1",
    input: { prompt: "Generate a Playwright test that verifies successful login.", maxTokens: 2500 },
    output: "test('login succeeds', async ({ page }) => { await page.goto('/login'); /* ... */ });",
  },
  {
    capability: "smart_browser_test",
    caseId: "case-1",
    input: { prompt: "Assert that the login page shows an email and password field.", maxTokens: 1600 },
    output: "PASS: email and password fields are present on the login page.",
  },
]);
