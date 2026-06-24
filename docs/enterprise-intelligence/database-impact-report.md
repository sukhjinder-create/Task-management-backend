# Database Impact Report

Date: 2026-06-24

## New Tables

- `user_intelligence`
- `project_intelligence`
- `team_intelligence`
- `workspace_intelligence`
- `intelligence_snapshots`
- `intelligence_recalculation_events`

## Purpose

These tables become the authoritative read source for dashboard and intelligence scores.

## Existing Tables Read As Evidence

- `tasks`
- `comments`
- `task_links`
- `task_watchers`
- `task_activity_logs`
- `time_logs`
- `attendance_daily`
- `attendance_events`
- `workspace_work_schedule`
- `workspace_holidays`
- `leave_requests`
- `performance_reviews`
- `review_cycles`
- `projects`
- `sprints`
- `workspace_users`
- `integration_entity_state`
- `workspace_execution_signals`

## Write Pattern

Incremental recalculation writes only impacted rows:

- impacted users
- impacted projects
- impacted teams
- workspace aggregate
- snapshot rows
- recalculation event audit row

`intelligence_recalculation_events.source_id` is `TEXT` so the audit stream can record UUID entity IDs and non-UUID operational keys such as attendance closeout dates or integration external IDs.

## Backward Compatibility

No existing tables are dropped or renamed. Existing APIs remain available during migration.

## Risk

The largest write amplification happens during bootstrap and daily attendance closeout. Normal task/comment/time-log events recalculate only impacted users/projects and aggregate rows.
