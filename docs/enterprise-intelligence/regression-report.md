# Regression Report

Date: 2026-06-24

## Preserved Areas

The implementation does not modify:

- authentication
- RBAC middleware
- task CRUD contracts
- project CRUD contracts
- attendance event recording
- leave request flow
- review submission flow
- comments
- time logs
- workspace isolation

## Dashboard Preservation

The dashboard layout, hierarchy, spacing, card style, typography, and navigation are preserved. New charts use existing design tokens and fit inside existing card patterns.

## Compatibility Adapters

Existing dashboard endpoints still exist:

- `/dashboard/overview`
- `/dashboard/executive-detail`

Existing intelligence endpoints still exist, but their active responses are backed by enterprise intelligence where changed.

## Known Migration State

Until the enterprise migration is run, enterprise intelligence endpoints return controlled schema-missing errors instead of silently calculating fallback scores.

## Local Verification

Use:

```powershell
npm run verify:enterprise-intelligence
```
