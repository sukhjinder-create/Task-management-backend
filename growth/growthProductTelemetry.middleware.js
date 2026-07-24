import { captureGrowthEvent } from "./growthCollector.js";
import { requestGrowthContext } from "./growthEvent.js";

const PRODUCT_RULES = [
  { method: "POST", pattern: /^\/projects\/?$/, eventName: "product.project_created", feature: "Projects", entityType: "project" },
  { method: "POST", pattern: /^\/tasks(?:\/[^/]+)?\/?$/, exclude: /^\/tasks\/(nl|all|detail)/, eventName: "product.task_created", feature: "Tasks", entityType: "task" },
  { method: "POST", pattern: /^\/users\/?$/, eventName: "product.team_member_added", feature: "Team", entityType: "user" },
  { method: "POST", pattern: /^\/teams\/?$/, eventName: "product.team_created", feature: "Team", entityType: "team" },
  { method: "POST", pattern: /^\/chat\/messages\/?$/, eventName: "product.chat_message_sent", feature: "Chat", entityType: "message" },
  { method: "POST", pattern: /^\/attendance\/sign-in\/?$/, eventName: "product.attendance_signed_in", feature: "Attendance" },
  { method: "POST", pattern: /^\/attendance\/sign-off\/?$/, eventName: "product.attendance_signed_out", feature: "Attendance" },
  { method: "POST", pattern: /^\/(ai|ai-features|autopilot)(\/|$)/, eventName: "product.ai_used", feature: "AI" },
  { method: "GET", pattern: /^\/dashboard(?:\/|$)/, eventName: "product.dashboard_viewed", feature: "Dashboard" },
  { method: "GET", pattern: /^\/operations\/search\/?$/, eventName: "product.search_performed", feature: "Workspace Search", entityType: "search" },
  { method: "POST", pattern: /^\/operations\/search\/click\/?$/, eventName: "product.search_result_clicked", feature: "Workspace Search", entityType: "search_result" },
  { method: "GET", pattern: /^\/adaptive\/recommendations\/?$/, eventName: "product.recommendation_viewed", feature: "Adaptive Recommendations", entityType: "recommendation" },
  { method: "POST", pattern: /^\/adaptive\/recommendations\/[^/]+\/(feedback|approve|reject|execute)\/?$/, eventName: "product.recommendation_actioned", feature: "Adaptive Recommendations", entityType: "recommendation" },
  { method: "GET", pattern: /^\/adaptive\/(?:intelligence\/explain|explain)(?:\/|$)/, eventName: "product.explainability_opened", feature: "Explainability" },
  { method: "GET", pattern: /^\/adaptive\/workflows(?:\/|$)/, eventName: "product.workflow_viewed", feature: "Adaptive Workflows", entityType: "workflow" },
  { method: "POST", pattern: /^\/adaptive\/workflows(?:\/|$)/, eventName: "product.workflow_actioned", feature: "Adaptive Workflows", entityType: "workflow" },
  { method: "PATCH", pattern: /^\/adaptive\/workflows(?:\/|$)/, eventName: "product.workflow_actioned", feature: "Adaptive Workflows", entityType: "workflow" },
  { method: "GET", pattern: /^\/adaptive\/intelligence(?:\/|$)/, eventName: "product.ai_feature_used", feature: "Adaptive Intelligence" },
  { method: "POST", pattern: /^\/adaptive\/intelligence(?:\/|$)/, eventName: "product.ai_feature_used", feature: "Adaptive Intelligence" },
  { method: "POST", pattern: /^\/huddles?(?:\/|$)/, eventName: "product.huddle_created", feature: "Huddles", entityType: "huddle" },
  { method: "GET", pattern: /^\/huddles?(?:\/|$)/, eventName: "product.feature_viewed", feature: "Huddles" },
  { method: "POST", pattern: /^\/(?:meeting-intelligence|huddle-intelligence)(?:\/|$)/, eventName: "product.ai_feature_used", feature: "Meeting Intelligence" },
  { method: "GET", pattern: /^\/(?:meeting-intelligence|huddle-intelligence)(?:\/|$)/, eventName: "product.feature_viewed", feature: "Meeting Intelligence" },
  { method: "GET", pattern: /^\/(?:executive-summary|operations\/digests)(?:\/|$)/, eventName: "product.feature_viewed", feature: "Executive Summary" },
  { method: "POST", pattern: /^\/(?:executive-summary|operations\/digests)(?:\/|$)/, eventName: "product.ai_feature_used", feature: "Executive Summary" },
  { method: "GET", pattern: /^\/(?:enterprise-intelligence|workspace-intelligence)(?:\/|$)/, eventName: "product.feature_viewed", feature: "Workspace Intelligence" },
  { method: "POST", pattern: /^\/(?:enterprise-intelligence|workspace-intelligence)(?:\/|$)/, eventName: "product.ai_feature_used", feature: "Workspace Intelligence" },
  { method: "POST", pattern: /^\/(?:notifications|push)(?:\/|$)/, eventName: "product.feature_used", feature: "Notifications" },
  { method: "POST", pattern: /^\/(?:approvals|adaptive\/approvals)(?:\/|$)/, eventName: "product.workflow_actioned", feature: "Approvals", entityType: "approval" },
];

export function matchProductGrowthEvent(method, path, statusCode) {
  if (statusCode < 200 || statusCode >= 400) return null;
  return PRODUCT_RULES.find(
    (rule) =>
      rule.method === method &&
      rule.pattern.test(path) &&
      (!rule.exclude || !rule.exclude.test(path))
  ) || null;
}

export function growthProductTelemetry(req, res, next) {
  res.once("finish", () => {
    const path = String(req.originalUrl || req.url || "").split("?")[0];
    const rule = matchProductGrowthEvent(req.method, path, res.statusCode);
    if (!rule) return;
    const context = requestGrowthContext(req);
    captureGrowthEvent({
      ...context,
      eventName: rule.eventName,
      source: "server",
      entityType: rule.entityType,
      properties: {
        feature_name: rule.feature,
        method: req.method,
        status_code: res.statusCode,
        route_template: req.route?.path || path,
      },
    });
  });
  next();
}
