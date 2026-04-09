import pool from "../db.js";
import { listWorkspaceMemoryEntries } from "./workspaceMemory.service.js";
import { columnExists, stripHtml, tableExists } from "./operationsShared.service.js";

const SEARCH_HISTORY_DEDUPE_WINDOW_SECONDS = 30;
const ALL_ROLES = ["admin", "manager", "user"];

function normalizeSearchToken(value) {
  const token = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");

  if (!token) return "";
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 3) return token.slice(0, -1);
  return token;
}

function tokenizeSearchText(value) {
  return [...new Set(
    String(value || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .map(normalizeSearchToken)
      .filter(Boolean)
  )];
}

function rankByMatch(text, q) {
  const haystack = String(text || "").toLowerCase();
  const needle = String(q || "").toLowerCase();
  if (!haystack || !needle) return 0;
  if (haystack === needle) return 120;
  if (haystack.startsWith(needle)) return 100;
  if (haystack.includes(needle)) return 80;

  const hayTokens = tokenizeSearchText(haystack);
  const queryTokens = tokenizeSearchText(needle);
  if (!queryTokens.length) return 0;

  const exactMatches = queryTokens.filter((token) => hayTokens.includes(token)).length;
  const prefixMatches = queryTokens.filter((token) => hayTokens.some((hayToken) => hayToken.startsWith(token) || token.startsWith(hayToken))).length;
  const substringMatches = queryTokens.filter((token) => haystack.includes(token)).length;

  if (exactMatches === queryTokens.length) return 72 + Math.min(queryTokens.length, 5) * 4;
  if (prefixMatches === queryTokens.length) return 60 + Math.min(queryTokens.length, 5) * 3;
  if (exactMatches > 0) return 36 + exactMatches * 6 + Math.max(0, substringMatches - exactMatches) * 2;
  if (substringMatches > 0) return 20 + substringMatches * 4;
  return 0;
}

function buildResult({ type, id, title, snippet, rank, meta = {} }) {
  return {
    type,
    id,
    title,
    snippet,
    rank,
    meta,
  };
}

function hasPlanFeature(planFeatures, key) {
  return Array.isArray(planFeatures) && planFeatures.includes(key);
}

function normalizeSearchQuery(value) {
  return String(value || "").trim().toLowerCase();
}

function isRoleAllowed(role, allowedRoles = ALL_ROLES) {
  return Array.isArray(allowedRoles) && allowedRoles.includes(role);
}

function isFeatureAllowed(featureKey, planFeatures) {
  if (!featureKey) return true;
  return hasPlanFeature(planFeatures, featureKey);
}

const NAVIGATION_CATALOG = [
  { id: "nav-dashboard", title: "Dashboard", snippet: "Workspace overview and execution summary.", path: "/dashboard", roles: ALL_ROLES, keywords: ["home", "overview", "dashboard"] },
  { id: "nav-projects", title: "Projects", snippet: "Browse workspace projects and drill into project tasks.", path: "/projects", roles: ALL_ROLES, keywords: ["project list", "project management"] },
  { id: "nav-my-tasks", title: "My Tasks", snippet: "Personal task queue and execution board.", path: "/my-tasks", roles: ALL_ROLES, keywords: ["tasks", "assigned work", "my work"] },
  { id: "nav-notifications", title: "Notifications", snippet: "Workspace alerts, mentions, and updates.", path: "/notifications", roles: ALL_ROLES, keywords: ["alerts", "mentions", "notification center"] },
  { id: "nav-profile", title: "My Profile", snippet: "Personal profile, presence, and password settings.", path: "/profile", roles: ALL_ROLES, keywords: ["account", "profile", "me"] },
  { id: "nav-chat", title: "Team Chat", snippet: "Workspace channels, direct messages, and chat threads.", path: "/chat", roles: ALL_ROLES, featureKey: "team_chat", keywords: ["chat", "messages", "channels", "dm"] },
  { id: "nav-wiki", title: "Wiki / Docs", snippet: "Workspace knowledge base and documentation.", path: "/wiki", roles: ALL_ROLES, featureKey: "wiki_docs", keywords: ["wiki", "docs", "documentation", "knowledge"] },
  { id: "nav-leave", title: "Leave Management", snippet: "Leave requests, balance, team calendar, and holidays.", path: "/leave", roles: ALL_ROLES, featureKey: "leave_management", keywords: ["leave", "holiday", "time off", "calendar"] },
  { id: "nav-leave-my", title: "Leave • My Leaves", snippet: "Your own leave requests and balances.", path: "/leave?tab=my", roles: ALL_ROLES, featureKey: "leave_management", keywords: ["my leave", "leave requests", "vacation"] },
  { id: "nav-leave-calendar", title: "Leave • Team Calendar", snippet: "Team leave calendar and visibility across the workspace.", path: "/leave?tab=calendar", roles: ALL_ROLES, featureKey: "leave_management", keywords: ["team calendar", "leave calendar"] },
  { id: "nav-leave-holidays", title: "Leave • Holidays", snippet: "Workspace holiday calendar for admins.", path: "/leave?tab=holidays", roles: ["admin"], featureKey: "leave_management", keywords: ["holidays", "holiday calendar"] },
  { id: "nav-leave-admin", title: "Leave • Admin Review", snippet: "Approve or reject leave requests.", path: "/leave?tab=admin", roles: ["admin"], featureKey: "leave_management", keywords: ["leave admin", "approve leave", "reject leave"] },
  { id: "nav-goals", title: "Goals / OKR", snippet: "Workspace goals and objective tracking.", path: "/okr", roles: ["admin"], featureKey: "okr_goals", keywords: ["goals", "okr", "objectives"] },
  { id: "nav-reviews", title: "Performance Reviews", snippet: "Review cycles, self reviews, and manager reviews.", path: "/reviews", roles: ALL_ROLES, featureKey: "performance_reviews", keywords: ["reviews", "performance", "review cycle"] },
  { id: "nav-reviews-pending", title: "Reviews • To Review", snippet: "Pending reviews assigned to you.", path: "/reviews?tab=pending", roles: ALL_ROLES, featureKey: "performance_reviews", keywords: ["pending reviews", "to review"] },
  { id: "nav-reviews-aboutme", title: "Reviews • About Me", snippet: "Your own submitted and received reviews.", path: "/reviews?tab=aboutme", roles: ALL_ROLES, featureKey: "performance_reviews", keywords: ["about me reviews", "self review"] },
  { id: "nav-reviews-myteam", title: "Reviews • My Team", snippet: "Progress tracking for direct reports.", path: "/reviews?tab=myteam", roles: ["admin", "manager"], featureKey: "performance_reviews", keywords: ["team reviews", "my team reviews"] },
  { id: "nav-reviews-cycles", title: "Reviews • Cycles", snippet: "Admin cycle setup and review rounds.", path: "/reviews?tab=cycles", roles: ["admin"], featureKey: "performance_reviews", keywords: ["review cycles", "cycle setup"] },
  { id: "nav-reviews-team", title: "Reviews • Team Mapping", snippet: "Manager assignment and team review mapping.", path: "/reviews?tab=team", roles: ["admin"], featureKey: "performance_reviews", keywords: ["team mapping", "manager assignments"] },
  { id: "nav-reports", title: "Reports", snippet: "Task and sprint reporting for admins and managers.", path: "/reports", roles: ["admin", "manager"], featureKey: "basic_reporting", keywords: ["reports", "analytics", "task report"] },
  { id: "nav-ai-hub", title: "AI Hub", snippet: "Central home for AI workflows and launch cards.", path: "/ai", roles: ["admin", "manager"], featureKey: "ai_hub", keywords: ["ai hub", "artificial intelligence", "hub"] },
  { id: "nav-dashboard-performance", title: "Dashboard - Performance", snippet: "Personal performance trend and intelligence view.", path: "/dashboard/performance", roles: ALL_ROLES, keywords: ["performance dashboard", "user performance", "monthly performance"] },
  { id: "nav-ai-features", title: "AI Productivity Tools", snippet: "Meeting notes, risks, smart digest, AI reports, and smart parsing.", path: "/ai-features", roles: ALL_ROLES, featureKey: "ai_hub", keywords: ["ai productivity", "ai features", "meeting to tasks", "smart parse"] },
  { id: "nav-ai-features-notes", title: "AI Features • Meeting to Tasks", snippet: "Convert meeting notes into structured tasks.", path: "/ai-features?tab=notes", roles: ALL_ROLES, featureKey: "ai_hub", keywords: ["meeting notes", "notes to tasks", "minutes to tasks"] },
  { id: "nav-ai-features-risk", title: "AI Features • Risk Heatmap", snippet: "Find deadline and execution risk across tasks.", path: "/ai-features?tab=risk", roles: ALL_ROLES, featureKey: "ai_hub", keywords: ["risk heatmap", "task risk"] },
  { id: "nav-ai-features-digest", title: "AI Features • Smart Digest", snippet: "Daily AI digest of notifications and signals.", path: "/ai-features?tab=digest", roles: ALL_ROLES, featureKey: "ai_hub", keywords: ["smart digest", "digest", "ai digest"] },
  { id: "nav-ai-features-report", title: "AI Features • AI Report", snippet: "Generate AI-backed weekly, monthly, and project reports.", path: "/ai-features?tab=report", roles: ALL_ROLES, featureKey: "ai_hub", keywords: ["ai report", "generate report"] },
  { id: "nav-ai-features-parse", title: "AI Features • Smart Task Parse", snippet: "Turn natural language into structured tasks.", path: "/ai-features?tab=parse", roles: ALL_ROLES, featureKey: "ai_hub", keywords: ["smart parse", "parse task", "natural language task"] },
  { id: "nav-intelligence", title: "Strategic Intelligence", snippet: "Workspace health, team signals, project signals, and Ask AI.", path: "/intelligence", roles: ["admin", "manager"], featureKey: "advanced_analytics", keywords: ["strategic intelligence", "workspace analytics"] },
  { id: "nav-intelligence-dashboard", title: "Strategic Intelligence • Dashboard", snippet: "Workspace intelligence dashboard and top-level signals.", path: "/intelligence?tab=dashboard", roles: ["admin"], featureKey: "advanced_analytics", keywords: ["intelligence dashboard"] },
  { id: "nav-intelligence-team", title: "Strategic Intelligence • Team", snippet: "Team analytics and performance signals.", path: "/intelligence?tab=team", roles: ["admin"], featureKey: "advanced_analytics", keywords: ["team intelligence", "team analytics"] },
  { id: "nav-intelligence-projects", title: "Strategic Intelligence • Projects", snippet: "Project risk and execution intelligence.", path: "/intelligence?tab=projects", roles: ["admin"], featureKey: "advanced_analytics", keywords: ["project intelligence", "project analytics"] },
  { id: "nav-intelligence-ask", title: "Strategic Intelligence • Ask AI", snippet: "Ask the intelligence layer questions in natural language.", path: "/intelligence?tab=ask", roles: ["admin", "manager"], featureKey: "advanced_analytics", keywords: ["ask ai", "ai answers"] },
  { id: "nav-autopilot", title: "AI Autopilot", snippet: "Automated assignments, escalations, approvals, and scheduling.", path: "/autopilot", roles: ["admin"], featureKey: "ai_autopilot", keywords: ["autopilot", "automation", "ai autopilot"] },
  { id: "nav-autopilot-pending", title: "AI Autopilot • Pending", snippet: "Pending AI actions waiting for attention.", path: "/autopilot?tab=pending", roles: ["admin"], featureKey: "ai_autopilot", keywords: ["pending ai actions", "pending autopilot"] },
  { id: "nav-autopilot-history", title: "AI Autopilot • History", snippet: "Autopilot execution history and past decisions.", path: "/autopilot?tab=history", roles: ["admin"], featureKey: "ai_autopilot", keywords: ["autopilot history", "automation history"] },
  { id: "nav-autopilot-settings", title: "AI Autopilot • Settings", snippet: "Autopilot rules and controls.", path: "/autopilot?tab=settings", roles: ["admin"], featureKey: "ai_autopilot", keywords: ["autopilot settings", "automation settings"] },
  { id: "nav-testing-agent", title: "AI Testing Agent", snippet: "Evidence-first browser and repository testing.", path: "/testing-agent", roles: ["admin", "manager"], featureKey: "ai_testing_agent", keywords: ["testing agent", "ai testing", "qa"] },
  { id: "nav-testing-agent-auto", title: "Testing Agent • Recon and Smoke", snippet: "Grounded smoke run based on live page recon.", path: "/testing-agent?mode=auto", roles: ["admin", "manager"], featureKey: "ai_testing_agent", keywords: ["recon", "smoke test"] },
  { id: "nav-testing-agent-guided", title: "Testing Agent • Scenario Run", snippet: "Run a defined guided scenario.", path: "/testing-agent?mode=guided", roles: ["admin", "manager"], featureKey: "ai_testing_agent", keywords: ["scenario run", "guided test"] },
  { id: "nav-testing-agent-deep", title: "Testing Agent • Product Audit", snippet: "Deep authenticated audit across the product.", path: "/testing-agent?mode=deep", roles: ["admin", "manager"], featureKey: "ai_testing_agent", keywords: ["product audit", "deep audit"] },
  { id: "nav-testing-agent-multi", title: "Testing Agent • Coverage Sweep", snippet: "Wide coverage across happy path, edge cases, and failures.", path: "/testing-agent?mode=multi", roles: ["admin", "manager"], featureKey: "ai_testing_agent", keywords: ["coverage sweep", "broad testing"] },
  { id: "nav-testing-agent-cli", title: "Testing Agent • Repository Run", snippet: "Execute repository commands and attach evidence.", path: "/testing-agent?mode=cli", roles: ["admin", "manager"], featureKey: "ai_testing_agent", keywords: ["repository run", "cli tests"] },
  { id: "nav-testing-agent-settings", title: "Testing Agent - Settings", snippet: "Automation controls, runtime limits, and default test commands.", path: "/testing-agent?section=settings", roles: ["admin", "manager"], featureKey: "ai_testing_agent", keywords: ["testing settings", "automation settings", "test commands"] },
  { id: "nav-testing-agent-history", title: "Testing Agent - Run History", snippet: "Previous runs, reports, and searchable testing evidence.", path: "/testing-agent?section=history", roles: ["admin", "manager"], featureKey: "ai_testing_agent", keywords: ["test history", "run history", "reports", "past runs"] },
  { id: "nav-testing-agent-profiles", title: "Testing Agent - Project Profiles", snippet: "Repository paths, frameworks, and execution profiles for projects.", path: "/testing-agent?section=profiles", roles: ["admin", "manager"], featureKey: "ai_testing_agent", keywords: ["project profiles", "execution profiles", "repository path", "repo path", "framework"] },
  { id: "nav-enterprise", title: "Enterprise", snippet: "Enterprise controls, governance, and operational visibility.", path: "/enterprise", roles: ["admin"], featureKey: "custom_branding", keywords: ["enterprise", "governance"] },
  { id: "nav-enterprise-intel", title: "Workspace Intelligence", snippet: "Advanced organisational analytics for admins.", path: "/enterprise-intel", roles: ["admin"], featureKey: "workspace_intelligence", keywords: ["workspace intelligence", "enterprise intelligence"] },
  { id: "nav-enterprise-intel-oracle", title: "Workspace Intelligence • Profitability Oracle", snippet: "Predict cost and risk before project start.", path: "/enterprise-intel?tab=oracle", roles: ["admin"], featureKey: "workspace_intelligence", keywords: ["profitability oracle", "project profitability"] },
  { id: "nav-enterprise-intel-radar", title: "Workspace Intelligence • Resignation Radar", snippet: "Early warning signals for potential resignations.", path: "/enterprise-intel?tab=radar", roles: ["admin"], featureKey: "workspace_intelligence", keywords: ["resignation radar", "attrition risk"] },
  { id: "nav-enterprise-intel-ghost", title: "Workspace Intelligence • Ghost Work", snippet: "Detect inflated or fake productivity patterns.", path: "/enterprise-intel?tab=ghost", roles: ["admin"], featureKey: "workspace_intelligence", keywords: ["ghost work", "fake productivity"] },
  { id: "nav-enterprise-intel-orgmap", title: "Workspace Intelligence • Org Truth Map", snippet: "Reveal actual value drivers and hidden organisational risk.", path: "/enterprise-intel?tab=orgmap", roles: ["admin"], featureKey: "workspace_intelligence", keywords: ["org truth map", "org map"] },
  { id: "nav-attendance", title: "Attendance", snippet: "Attendance records, scoring, and recalculation.", path: "/admin/attendance", roles: ["admin"], featureKey: "attendance", keywords: ["attendance", "sign in", "availability"] },
  { id: "nav-admin-users", title: "Admin Panel", snippet: "Manage workspace users and AI settings.", path: "/admin/users", roles: ["admin"], keywords: ["users", "admin panel", "manage users"] },
  { id: "nav-workspace-search", title: "Workspace Search + Memory", snippet: "Admin search across workspace entities and shared memory.", path: "/admin/workspace-search", roles: ["admin"], featureKey: "workspace_search_memory", keywords: ["workspace search", "unified search", "memory"] },
  { id: "nav-workspace-search-search", title: "Workspace Search • Search", snippet: "Unified workspace search results and navigation.", path: "/admin/workspace-search?tab=search", roles: ["admin"], featureKey: "workspace_search_memory", keywords: ["search tab", "workspace search results"] },
  { id: "nav-workspace-search-memory", title: "Workspace Search • Memory", snippet: "Saved workspace memory entries and knowledge capture.", path: "/admin/workspace-search?tab=memory", roles: ["admin"], featureKey: "workspace_search_memory", keywords: ["workspace memory", "search memory"] },
  { id: "nav-admin-intelligence", title: "Admin Intelligence", snippet: "Monthly scoring, admin insights, and workspace intelligence summaries.", path: "/admin/intelligence", roles: ["admin"], keywords: ["admin intelligence", "monthly scoring", "admin insights"] },
  { id: "nav-executive-summary", title: "Executive Summary", snippet: "Executive-ready monthly summary from live workspace signals.", path: "/admin/executive-summary", roles: ["admin"], keywords: ["executive summary", "monthly summary", "leadership summary"] },
  { id: "nav-billing", title: "Billing", snippet: "Workspace billing, members, and payment management.", path: "/admin/billing", roles: ["admin"], keywords: ["billing", "payments", "subscription"] },
  { id: "nav-migrations", title: "Migrations", snippet: "Migration tools and import workflows.", path: "/admin/migrations", roles: ["admin"], featureKey: "slack_migration", keywords: ["migrations", "import", "slack migration"] },
];

function searchNavigationCatalog({ q, role, planFeatures }) {
  const term = normalizeSearchQuery(q);
  if (!term) return [];

  return NAVIGATION_CATALOG
    .filter((entry) => isRoleAllowed(role, entry.roles) && isFeatureAllowed(entry.featureKey, planFeatures))
    .map((entry) => {
      const searchable = [entry.title, entry.snippet, ...(entry.keywords || [])].join(" ");
      const rank = Math.max(
        rankByMatch(entry.title, term),
        rankByMatch(searchable, term)
      );

      return {
        entry,
        rank,
      };
    })
    .filter(({ rank }) => rank > 0)
    .map(({ entry, rank }) => buildResult({
      type: "navigation",
      id: entry.id,
      title: entry.title,
      snippet: entry.snippet,
      rank: rank + 5,
      meta: {
        path: entry.path,
        category: "navigation",
      },
    }))
    .slice(0, 24);
}

async function searchUsers(workspaceId, q) {
  const { rows } = await pool.query(
    `
    SELECT
      u.id,
      u.username,
      u.email,
      u.role
    FROM users u
    JOIN workspace_users wu
      ON wu.user_id = u.id
     AND wu.workspace_id = $1
    WHERE wu.billing_status != 'pending'
      AND (u.is_system IS NULL OR u.is_system = FALSE)
      AND u.role != 'system'
      AND (u.username ILIKE $2 OR COALESCE(u.email, '') ILIKE $2)
    ORDER BY u.username ASC
    LIMIT 8
    `,
    [workspaceId, `%${q}%`]
  );

  return rows.map((row) => buildResult({
    type: "user",
    id: row.id,
    title: row.username || row.email || "Workspace user",
    snippet: [row.email, row.role].filter(Boolean).join(" • "),
    rank: Math.max(rankByMatch(row.username, q), rankByMatch(row.email, q)),
    meta: {
      role: row.role,
      email: row.email,
      path: `/users/${encodeURIComponent(row.id)}/profile`,
    },
  }));
}

async function searchTasks(workspaceId, q) {
  const { rows } = await pool.query(
    `
    SELECT t.id, t.task, t.description, t.status, t.priority, t.project_id, p.name AS project_name
    FROM tasks t
    LEFT JOIN projects p ON p.id = t.project_id
    WHERE t.workspace_id = $1
      AND (t.task ILIKE $2 OR COALESCE(t.description, '') ILIKE $2)
    ORDER BY t.updated_at DESC
    LIMIT 8
    `,
    [workspaceId, `%${q}%`]
  );

  return rows.map((row) => buildResult({
    type: "task",
    id: row.id,
    title: row.task,
    snippet: row.description || row.status,
    rank: rankByMatch(row.task, q),
    meta: {
      projectId: row.project_id,
      projectName: row.project_name,
      status: row.status,
      priority: row.priority,
      path: row.project_id
        ? `/projects/${encodeURIComponent(row.project_id)}?task=${encodeURIComponent(row.id)}`
        : "/projects",
    },
  }));
}

async function searchProjects(workspaceId, q) {
  const hasDescription = await columnExists("projects", "description");
  const descriptionExpr = hasDescription ? "description" : "NULL::text AS description";
  const searchCondition = hasDescription
    ? "(name ILIKE $2 OR COALESCE(description, '') ILIKE $2)"
    : "name ILIKE $2";

  const { rows } = await pool.query(
    `
    SELECT id, name, ${descriptionExpr}
    FROM projects
    WHERE workspace_id = $1
      AND ${searchCondition}
    ORDER BY created_at DESC
    LIMIT 6
    `,
    [workspaceId, `%${q}%`]
  );

  return rows.map((row) => buildResult({
    type: "project",
    id: row.id,
    title: row.name,
    snippet: row.description || "Project",
    rank: rankByMatch(row.name, q),
    meta: {
      path: `/projects/${encodeURIComponent(row.id)}`,
    },
  }));
}

async function searchWiki(workspaceId, q) {
  if (!(await tableExists("wiki_pages"))) return [];

  const { rows } = await pool.query(
    `
    SELECT p.id, p.title, p.content_text, p.space_id, ws.name AS space_name
    FROM wiki_pages p
    JOIN wiki_spaces ws ON ws.id = p.space_id
    WHERE ws.workspace_id = $1
      AND (p.title ILIKE $2 OR COALESCE(p.content_text, '') ILIKE $2)
    ORDER BY p.updated_at DESC
    LIMIT 6
    `,
    [workspaceId, `%${q}%`]
  );

  return rows.map((row) => buildResult({
    type: "wiki",
    id: row.id,
    title: row.title,
    snippet: (row.content_text || "").slice(0, 180),
    rank: rankByMatch(row.title, q),
    meta: {
      spaceId: row.space_id,
      spaceName: row.space_name,
      path: `/wiki?space=${encodeURIComponent(row.space_id)}&page=${encodeURIComponent(row.id)}`,
    },
  }));
}

async function searchGoals(workspaceId, q) {
  if (!(await tableExists("okr_objectives"))) return [];

  const { rows } = await pool.query(
    `
    SELECT id, title, description, status, progress, time_period
    FROM okr_objectives
    WHERE workspace_id = $1
      AND (title ILIKE $2 OR COALESCE(description, '') ILIKE $2)
    ORDER BY updated_at DESC
    LIMIT 6
    `,
    [workspaceId, `%${q}%`]
  );

  return rows.map((row) => buildResult({
    type: "goal",
    id: row.id,
    title: row.title,
    snippet: row.description || `${row.status} (${row.progress}%)`,
    rank: rankByMatch(row.title, q),
    meta: {
      status: row.status,
      progress: row.progress,
      timePeriod: row.time_period,
      path: `/okr?goal=${encodeURIComponent(row.id)}${row.time_period ? `&period=${encodeURIComponent(row.time_period)}` : ""}`,
    },
  }));
}

async function searchChat(workspaceId, q) {
  if (!(await tableExists("chat_messages"))) return [];

  const hasFallbackText = await columnExists("chat_messages", "fallback_text");
  const hasChannelKey = await columnExists("chat_messages", "channel_key");
  const textExpr = hasFallbackText ? "COALESCE(m.fallback_text, m.text_html, '')" : "COALESCE(m.text_html, '')";
  const channelExpr = hasChannelKey ? "m.channel_key" : "NULL";

  const { rows } = await pool.query(
    `
    SELECT
      m.id,
      ${textExpr} AS body_text,
      ${channelExpr} AS channel_key,
      u.username
    FROM chat_messages m
    LEFT JOIN users u ON u.id = m.user_id
    WHERE m.workspace_id = $1
      AND ${textExpr} ILIKE $2
    ORDER BY m.created_at DESC
    LIMIT 5
    `,
    [workspaceId, `%${q}%`]
  );

  return rows.map((row) => {
    const plain = stripHtml(row.body_text || "");
    return buildResult({
      type: "chat",
      id: row.id,
      title: row.username ? `Message from ${row.username}` : "Chat message",
      snippet: plain.slice(0, 180),
      rank: rankByMatch(plain, q),
      meta: {
        channelKey: row.channel_key,
        path: row.channel_key
          ? `/chat?channel=${encodeURIComponent(row.channel_key)}`
          : "/chat",
      },
    });
  });
}

export async function recordWorkspaceSearchClick({
  workspaceId,
  userId,
  query,
  result,
}) {
  const normalizedQuery = normalizeSearchQuery(query);
  const resultPath = result?.meta?.path || null;
  if (!workspaceId || !userId || !normalizedQuery || !resultPath) return null;

  try {
    const existing = await pool.query(
      `
      SELECT id
      FROM workspace_search_history
      WHERE workspace_id = $1
        AND user_id = $2
        AND normalized_query = $3
        AND clicked_result_path = $4
        AND searched_at >= NOW() - ($5 || ' seconds')::interval
      ORDER BY searched_at DESC
      LIMIT 1
      `,
      [
        workspaceId,
        userId,
        normalizedQuery,
        resultPath,
        String(SEARCH_HISTORY_DEDUPE_WINDOW_SECONDS),
      ]
    );

    if (existing.rows[0]?.id) {
      const { rows } = await pool.query(
        `
        UPDATE workspace_search_history
        SET
          query = $2,
          clicked_result_type = $3,
          clicked_result_id = $4,
          clicked_result_title = $5,
          clicked_result_path = $6,
          clicked_result_meta = $7::jsonb,
          searched_at = NOW()
        WHERE id = $1
        RETURNING id, query, clicked_result_type, clicked_result_id, clicked_result_title, clicked_result_path, clicked_result_meta, searched_at
        `,
        [
          existing.rows[0].id,
          String(query || "").trim(),
          result.type || "unknown",
          String(result.id || ""),
          result.title || "Search result",
          resultPath,
          JSON.stringify(result.meta || {}),
        ]
      );
      return rows[0] || null;
    }

    const { rows } = await pool.query(
      `
      INSERT INTO workspace_search_history (
        workspace_id,
        user_id,
        query,
        normalized_query,
        clicked_result_type,
        clicked_result_id,
        clicked_result_title,
        clicked_result_path,
        clicked_result_meta
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
      RETURNING id, query, clicked_result_type, clicked_result_id, clicked_result_title, clicked_result_path, clicked_result_meta, searched_at
      `,
      [
        workspaceId,
        userId,
        String(query || "").trim(),
        normalizedQuery,
        result.type || "unknown",
        String(result.id || ""),
        result.title || "Search result",
        resultPath,
        JSON.stringify(result.meta || {}),
      ]
    );

    return rows[0] || null;
  } catch (error) {
    if (error?.code === "42P01" || error?.code === "42703") {
      return null;
    }
    throw error;
  }
}

export async function listWorkspaceSearchHistory({
  workspaceId,
  userId,
  limit = 20,
}) {
  if (!workspaceId || !userId) {
    return {
      history: [],
      summary: {
        totalClicks: 0,
        uniqueQueries: 0,
        uniqueDestinations: 0,
        lastClickedAt: null,
      },
    };
  }

  try {
    const parsedLimit = Math.max(1, Math.min(Number(limit || 20), 100));
    const [{ rows: historyRows }, { rows: summaryRows }] = await Promise.all([
      pool.query(
        `
        SELECT
          id,
          query,
          clicked_result_type,
          clicked_result_id,
          clicked_result_title,
          clicked_result_path,
          clicked_result_meta,
          searched_at
        FROM workspace_search_history
        WHERE workspace_id = $1
          AND user_id = $2
          AND clicked_result_path IS NOT NULL
        ORDER BY searched_at DESC
        LIMIT $3
        `,
        [workspaceId, userId, parsedLimit]
      ),
      pool.query(
        `
        SELECT
          COUNT(*)::int AS total_clicks,
          COUNT(DISTINCT normalized_query)::int AS unique_queries,
          COUNT(DISTINCT clicked_result_path)::int AS unique_destinations,
          MAX(searched_at) AS last_clicked_at
        FROM workspace_search_history
        WHERE workspace_id = $1
          AND user_id = $2
          AND clicked_result_path IS NOT NULL
        `,
        [workspaceId, userId]
      ),
    ]);

    const summary = summaryRows[0] || {};

    return {
      history: historyRows.map((row) => ({
        id: row.id,
        query: row.query,
        resultType: row.clicked_result_type || "unknown",
        resultId: row.clicked_result_id || null,
        resultTitle: row.clicked_result_title || "Search result",
        path: row.clicked_result_path || null,
        meta: row.clicked_result_meta || {},
        clickedAt: row.searched_at,
      })),
      summary: {
        totalClicks: Number(summary.total_clicks || 0),
        uniqueQueries: Number(summary.unique_queries || 0),
        uniqueDestinations: Number(summary.unique_destinations || 0),
        lastClickedAt: summary.last_clicked_at || null,
      },
    };
  } catch (error) {
    if (error?.code === "42P01" || error?.code === "42703") {
      return {
        history: [],
        summary: {
          totalClicks: 0,
          uniqueQueries: 0,
          uniqueDestinations: 0,
          lastClickedAt: null,
        },
      };
    }
    throw error;
  }
}

export async function unifiedWorkspaceSearch({
  workspaceId,
  userId,
  role,
  q,
  planFeatures = [],
}) {
  const term = String(q || "").trim();
  if (!term) {
    return {
      query: "",
      results: [],
    };
  }

  const [users, tasks, projects, wiki, chat, goals, memory] = await Promise.all([
    searchUsers(workspaceId, term),
    searchTasks(workspaceId, term),
    searchProjects(workspaceId, term),
    hasPlanFeature(planFeatures, "wiki_docs") ? searchWiki(workspaceId, term) : Promise.resolve([]),
    hasPlanFeature(planFeatures, "team_chat") ? searchChat(workspaceId, term) : Promise.resolve([]),
    hasPlanFeature(planFeatures, "okr_goals") ? searchGoals(workspaceId, term) : Promise.resolve([]),
    listWorkspaceMemoryEntries({ workspaceId, userId, role, q: term, limit: 8 }),
  ]);
  const navigation = searchNavigationCatalog({ q: term, role, planFeatures });

  const memoryResults = memory.map((entry) => buildResult({
    type: "memory",
    id: entry.id,
    title: entry.title,
    snippet: entry.content.slice(0, 180),
    rank: rankByMatch(entry.title, term) + (entry.is_pinned ? 15 : 0),
    meta: {
      visibility: entry.visibility,
      tags: entry.tags,
      createdBy: entry.created_by_name,
      path: `/admin/workspace-search?tab=memory&entry=${encodeURIComponent(entry.id)}`,
    },
  }));

  const results = [
    ...navigation,
    ...users,
    ...tasks,
    ...projects,
    ...wiki,
    ...chat,
    ...goals,
    ...memoryResults,
  ]
    .sort((a, b) => b.rank - a.rank || a.title.localeCompare(b.title))
    .slice(0, 30);

  const counts = {
    navigation: navigation.length,
    users: users.length,
    tasks: tasks.length,
    projects: projects.length,
    wiki: wiki.length,
    chat: chat.length,
    goals: goals.length,
    memory: memoryResults.length,
  };

  return {
    query: term,
    results,
    counts,
  };
}
