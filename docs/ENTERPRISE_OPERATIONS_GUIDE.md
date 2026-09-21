# Asystence enterprise operations guide

## Identity and lifecycle

- Configure SAML 2.0 or OpenID Connect in **Admin → Enterprise → Identity**. Test sign-in before enabling workspace-wide enforcement.
- Verify company domains with the generated DNS TXT record.
- Create a SCIM bearer token in **Security**, paste it into the directory provider, validate `/scim/v2/ServiceProviderConfig`, then provision a pilot group before enabling deprovisioning.
- Require MFA, set session and idle limits, and review active sessions from the same screen. IP allowlists cannot be saved unless they contain the administrator's current address.

## API and integrations

- Prefer OAuth 2.0 client credentials for server workloads. Secrets are displayed once and credentials have a policy-bound expiry.
- The machine-readable contract is at `/developer/openapi.json`; the short discovery document is at `/developer/quickstart`.
- Webhooks carry stable delivery IDs, timestamps, and HMAC signatures. Consumers must reject stale timestamps, deduplicate delivery IDs, and return a 2xx response only after durable acceptance.
- Failed deliveries retry with backoff and can be replayed by an administrator. Custom REST connectors use the existing provider capability contract rather than application-specific code.

## Evidence, audit, and privacy

- Audit records are chained per workspace and can be verified or exported from **Enterprise → Audit Logs** for SIEM ingestion.
- Public outcome receipts are signed with a workspace Ed25519 key. The verification URL exposes the signed receipt and public key, never internal people or evidence notes unless explicitly included.
- Client outcome reviews support multiple named approvers and an explicit quorum.
- Data export, erasure, and legal holds are available through the GDPR routes. A legal hold blocks erasure until an administrator releases it.

## Encryption and deployment isolation

- Set `DATA_ENCRYPTION_KEY` to a tenant/deployment-owned base64 32-byte key. It protects stored SSO, webhook, domain-verification, and receipt-signing secrets.
- Set a separate `BACKUP_ENCRYPTION_KEY` when cryptographic separation is required. Rotate by changing `BACKUP_ENCRYPTION_KEY_ID` and retaining old keys until their backup retention window closes.
- Dedicated deployment uses the existing production Docker Compose stack with a customer-owned database, object store, DNS, mail provider, and encryption keys. Deploy the same immutable image in the required region; data residency is determined by those customer-selected regional services.
- Database TLS certificate verification is on by default. Use `DB_SSL_CA` for private roots. `DB_SSL_REJECT_UNAUTHORIZED=false` is an explicit break-glass exception and should be time-boxed.

## Release and recovery gates

1. Run the additive enterprise migration before starting the new image.
2. Pass the backend test suite, dependency high-severity audit, frontend build, and landing build.
3. Take an encrypted backup and run a workspace recovery dry-run.
4. Verify `/livez`, `/readyz`, SSO pilot login, SCIM pilot provisioning, webhook test delivery, audit-chain integrity, and one signed receipt.
5. Roll back the image if health checks fail; additive schema remains backward compatible.

External credentials found in files or logs must be revoked at their provider, replaced in the deployment secret store, and removed from local history. Repository changes cannot rotate a provider credential by themselves.
