import {
  getDashboardExecutiveDetailFromIntelligence,
  getDashboardOverviewFromIntelligence,
} from "../intelligence/analytics/unifiedDashboard.adapter.js";
import { resolveCutoverResponse } from "../intelligence/cutover/sourceSwitch.service.js";
import {
  getLegacyDashboardExecutiveDetail,
  getLegacyDashboardOverview,
} from "../intelligence/legacy/legacyDashboard.adapter.js";

/**
 * Dashboard service is a cutover-aware compatibility adapter.
 *
 * It does not calculate scores. Normal unified mode reads the enterprise
 * intelligence repositories; legacy/shadow modes route through explicit
 * rollback adapters for staged production safety.
 */
export async function getDashboardOverview({ workspaceId, userId, role, range = "30d", res = null }) {
  return resolveCutoverResponse({
    workspaceId,
    surface: "dashboard_overview",
    res,
    unified: () => getDashboardOverviewFromIntelligence({ workspaceId, userId, role, range }),
    legacy: () => getLegacyDashboardOverview({ workspaceId, userId, role }),
  });
}

export async function getDashboardExecutiveDetail({ workspaceId, userId, role, range = "30d", res = null }) {
  return resolveCutoverResponse({
    workspaceId,
    surface: "dashboard_executive_detail",
    res,
    unified: () => getDashboardExecutiveDetailFromIntelligence({ workspaceId, userId, role, range }),
    legacy: () => getLegacyDashboardExecutiveDetail({ workspaceId, userId, role }),
  });
}
