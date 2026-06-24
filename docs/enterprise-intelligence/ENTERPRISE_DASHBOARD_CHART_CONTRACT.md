# Enterprise Dashboard Chart Contract

Generated: 2026-06-24

## Contract Location

Backend producer:

- `intelligence/analytics/unifiedDashboard.adapter.js`

Frontend consumer:

- `src/pages/Dashboard.jsx`

## Contract Shape

All dashboard charts are returned under:

```json
{
  "visualizations": {
    "charts": [
      {
        "id": "workspace_health_trends",
        "key": "workspace_health_trends",
        "title": "Workspace Health Trends",
        "type": "line",
        "dataKey": "value",
        "metric": "Workspace Health",
        "source": "intelligence_snapshots",
        "scope": {
          "type": "role_dashboard",
          "role": "admin",
          "range": "30d"
        },
        "axis": {
          "x": { "dataKey": "label", "type": "category" },
          "y": { "dataKey": "value", "domain": [0, 100] }
        },
        "series": [
          {
            "id": "value",
            "label": "Workspace Health",
            "dataKey": "value"
          }
        ],
        "data": [
          {
            "label": "06-24",
            "date": "2026-06-24",
            "value": 82
          }
        ]
      }
    ]
  }
}
```

`value` may be `null` when the exact intelligence dimension is absent from the repository snapshot. The backend does not fall back to an alternate score for dimension-specific charts.

## Supported Dashboard Ranges

- `30d`
- `90d`
- `6m`
- `1y`
- `all`

`all` means the full available intelligence snapshot history. The backend still returns the same `visualizations.charts` schema and uses month-level bucketing for readability.

## Required Chart Keys

Admin:

- `workspace_health_trends`
- `productivity_trends`
- `risk_trends`
- `team_comparisons`
- `project_portfolio_comparisons`
- `department_comparisons`

Manager:

- `assigned_project_performance`
- `team_delivery_trends`
- `team_risk_trends`
- `sprint_progress_trends`
- `completion_forecasts`

User:

- `personal_performance_trends`
- `workload_trends`
- `delivery_trends`
- `task_completion_trends`
- `personal_risk_trends`

## Source Rules

- Line charts use `intelligence_snapshots`.
- Team bars use `team_intelligence`.
- Project bars use `project_intelligence`.
- User charts use user snapshots.
- Frontend does not compute chart math.
- Backend does not derive fallback bands.
- Backend does not synthesize risk as `100 - score`.
- The frontend may use values for rendering dimensions such as bar width, but it must not derive new chart data or alternate scores.

## Frontend Preservation

The dashboard continues using existing card, typography, color tokens, and `ResponsiveContainer` chart rendering. No new design system was introduced.
