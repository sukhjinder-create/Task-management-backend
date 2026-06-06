# Huddle LiveKit Canary Governance

Mesh remains the production default and fallback. LiveKit is a workspace-scoped
web and mobile canary only and must not become the global default through this
control plane.

## Provider Selection

The selector returns `requestedProvider`, `selectedProvider`,
`selectionReason`, `fallbackReason`, client capabilities, entitlement status,
provider-lock status, canary eligibility, room readiness, token readiness, and
the decision path.

LiveKit may be selected only when all checks pass:

- LiveKit is explicitly requested.
- Force-mesh rollback flags are disabled.
- Canary is enabled.
- Workspace is allowlisted.
- The workspace is entitled to video huddles.
- The client declares LiveKit capability.
- Room endpoint readiness passes.
- Token endpoint readiness passes.
- No existing provider lock conflicts.

Missing capability data resolves to mesh.

## Mobile Canary

Mobile LiveKit participation is additive and controlled by Dart define flags.
Without `HUDDLE_LIVEKIT_MOBILE_CANARY_ENABLED=true`, mobile continues to create
the existing mesh provider. With the canary enabled, mobile requests the existing
LiveKit room and token endpoints, sends capability negotiation data, and
inherits the persisted provider lock. Pre-lock canary failures fall back to
mesh after cleaning LiveKit room resources. Once the backend has locked the
session to LiveKit, mobile fails closed rather than migrating that active
session to mesh.

The mobile provider maps LiveKit participants, devices, tracks, publication
state, subscription state, active speaker state, and network quality into Media
State V2 while preserving controller compatibility.

## Provider Locking

When a LiveKit room or token request is authorized, the backend creates or
inherits a `huddle_media_sessions` provider lock for the durable huddle session.
The first persisted media-session provider is immutable for that session.
Late joiners inherit the lock and cannot change the provider.

## Operational Readiness

Operational readiness is reported by the diagnostics/service layer. The
readiness model is provider-neutral where possible and includes provider
selection counts, mesh and LiveKit session selections, fallback counts, room and
token success/failure, join/publish/reconnect counters, provider lock
violations, capability negotiation failures, rollout stage diagnostics, and
non-enforcing SLO diagnostics.

Rollout stages are diagnostic only:

- Stage 0: internal only.
- Stage 1: single workspace.
- Stage 2: five workspaces.
- Stage 3: twenty-five workspaces.
- Stage 4: general availability.

`GET /huddle/media/livekit/diagnostics` exposes the readiness dashboard and the
final Epic 5 readiness report. These reports do not automatically enable
production rollout.

## Rollback

Use any of these reversible controls:

- Set `HUDDLE_MEDIA_FORCE_MESH=true` to force selector fallback to mesh.
- Set `HUDDLE_LIVEKIT_FORCE_MESH=true` as a LiveKit-specific shutdown.
- Set `HUDDLE_LIVEKIT_CANARY_ENABLED=false` to disable all LiveKit canary
  selection.
- Remove the workspace from `HUDDLE_LIVEKIT_CANARY_WORKSPACES`.
- Set `HUDDLE_LIVEKIT_ROOM_ENDPOINT_ENABLED=false` or
  `HUDDLE_LIVEKIT_TOKEN_ENDPOINT_ENABLED=false` to block new LiveKit room/token
  issuance.
- Build mobile without `--dart-define=HUDDLE_LIVEKIT_MOBILE_CANARY_ENABLED=true`
  to keep mobile on mesh.
- Build mobile with `--dart-define=HUDDLE_LIVEKIT_MOBILE_FORCE_MESH=true` to
  force mobile mesh fallback even when the canary flag is present.

Existing locked LiveKit sessions should be allowed to end naturally. Do not
migrate active sessions across providers.

## Certification

Run:

```bash
npm run verify:huddle-media-governance
npm run verify:huddle-mobile-livekit
npm run verify:huddle-operational-readiness
```

The verifier covers mesh defaulting, LiveKit disabled, missing entitlement,
missing canary allowlist, missing capability data, eligible LiveKit selection,
late-join lock inheritance, lock mismatch rejection, rollback flags, and the
mobile canary provider. Mobile certification covers room/token use, capability
negotiation, provider-lock fallback handling, Media State V2 mapping,
mic/camera publication, diagnostics, and rollback flags.
Operational certification covers mesh-only mode, canary mode, force mesh, room
endpoint shutdown, token endpoint shutdown, provider lock inheritance, emergency
rollback flags, rollout stage transitions, SLO diagnostics, and final Epic 5
readiness reporting.
