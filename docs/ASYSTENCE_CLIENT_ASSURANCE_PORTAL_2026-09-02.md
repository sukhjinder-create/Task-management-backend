# Asystence Client Assurance Portal

**Implemented:** 2 September 2026

**Boundary:** Existing Execution Assurance outcomes

**Identity:** Passwordless external client contact; never a workspace user or billable seat

## User flow

1. A manager creates or edits an outcome using the existing four required answers.
2. The optional **Client-facing outcome** control reveals only the client company, approver name, and approved email account.
3. Internal users execute the work and record result evidence exactly as before.
4. After internal completion, a manager reviews a client-safe result summary and sends it for acceptance.
5. The approved email receives a one-time link that expires after 20 minutes. Opening it exchanges the link for a revocable seven-day portal session and removes the token from the browser URL.
6. The portal shows every outcome explicitly shared with that client, grouped by project. It never exposes tasks, team data, internal evidence history, assurance scores, decisions, or governance records.
7. The assigned approver accepts the result or submits a required change note.
8. Acceptance makes the evidenced outcome verified. A change request notifies the internal owner and requester; revised result evidence is required before it can be sent again.
9. For later access, the client enters only the approved email at `/client-portal`. No workspace slug or password is required.
10. An admin can revoke or restore a client contact under **Outcomes → Policy**. Revocation immediately closes sessions, unused links, and pending reviews.

Managers can also resend a pending link or withdraw the request. Resending preserves the original immutable review snapshot and revokes the previous unused link.

## Security and tenancy contract

- Client contacts are stored separately from `users` and `workspace_users`.
- Every client, contact, outcome, review, link, and session relationship is workspace-scoped with composite foreign keys.
- All five new tables have PostgreSQL Row Level Security enabled.
- Magic-link and session credentials are 256-bit opaque values; only SHA-256 digests are stored.
- Magic links are one-time use, expire in 20 minutes, and are rate limited. Sessions are server-revocable and expire in seven days.
- Access-request responses are enumeration-safe.
- Client decisions and internal access-management actions are audit logged.
- Client-safe review snapshots are immutable after the first send.
- Expired authentication rows are cleaned during normal link/session issuance.
- Workspace recovery preserves clients, contacts, evidence, and review decisions but deliberately does not resurrect one-time links or active portal sessions.

## Deployment and verification

Production deployment applies and verifies `migrations/20260902_client_assurance_portal.sql` before pulling the new image.

```bash
npm run migrate:client-assurance-portal
npm run test:client-assurance-portal
npm run test:execution-assurance
npm run test:rls-guard
npm run verify:backup-recovery
```

The portal reuses the existing SMTP configuration and frontend base URL. The optional `CLIENT_PORTAL_ACCESS_RATE_LIMIT_PER_HOUR` setting defaults to 10 requests per source IP per hour.
