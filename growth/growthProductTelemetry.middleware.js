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
        status_code: res.statusCode,
        route_template: req.route?.path || path,
      },
    });
  });
  next();
}

