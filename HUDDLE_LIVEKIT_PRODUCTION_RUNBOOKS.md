# Huddle LiveKit Production Runbooks

These runbooks are operational controls for the LiveKit canary path. Mesh
remains the production default and fallback. Do not migrate active sessions
between providers.

## Stage 0 Internal Validation

Stage 0 defaults to infrastructure-only when
`HUDDLE_LIVEKIT_CANARY_WORKSPACES` is empty. For real internal LiveKit
validation, Stage 0 may allow exactly one explicitly internal workspace.

1. Set `HUDDLE_LIVEKIT_ROLLOUT_STAGE=stage_0_internal_only`.
2. Set `HUDDLE_LIVEKIT_CANARY_WORKSPACES=<internal_workspace_id>`.
3. Keep wildcard allowlists disabled.
4. Confirm diagnostics report `mode=stage_0_internal_validation`.
5. Confirm room and token readiness are green for that internal workspace.

Rollback: clear `HUDDLE_LIVEKIT_CANARY_WORKSPACES` to return Stage 0 to
infrastructure-only mode, or use Emergency Canary Shutdown if LiveKit itself is
suspect.

## Force Mesh

Use when LiveKit should stop being selected while all existing mesh behavior
continues.

1. Set `HUDDLE_MEDIA_FORCE_MESH=true`.
2. Keep mesh infrastructure unchanged.
3. Restart only the API processes that read environment flags.
4. Confirm `GET /huddle/media/livekit/diagnostics` reports `forceMesh=true`.
5. Let existing locked LiveKit sessions end naturally.

Rollback: set `HUDDLE_MEDIA_FORCE_MESH=false` after canary certification passes.

## Disable LiveKit

Use when all LiveKit canary selection should stop.

1. Set `HUDDLE_LIVEKIT_CANARY_ENABLED=false`.
2. Set `HUDDLE_LIVEKIT_FORCE_MESH=true`.
3. Remove workspace IDs from `HUDDLE_LIVEKIT_CANARY_WORKSPACES`.
4. Confirm provider selection falls back with `livekit_canary_disabled`.

Rollback: restore the previous allowlist, clear force-mesh, and re-enable the
canary flag only after operational readiness is green.

## Disable Room Provisioning

Use when LiveKit room readiness or connectivity is suspect.

1. Set `HUDDLE_LIVEKIT_ROOM_ENDPOINT_ENABLED=false`.
2. Confirm diagnostics report `roomStatus.provisioningEnabled=false`.
3. Confirm new LiveKit room requests fail closed and do not affect mesh.

Rollback: set `HUDDLE_LIVEKIT_ROOM_ENDPOINT_ENABLED=true` and rerun
`npm run verify:huddle-operational-readiness`.

## Disable Token Issuance

Use when token signing, key exposure, or LiveKit credentials are suspect.

1. Set `HUDDLE_LIVEKIT_TOKEN_ENDPOINT_ENABLED=false`.
2. Rotate `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` if compromise is suspected.
3. Confirm diagnostics report `tokenStatus.issuanceEnabled=false`.

Rollback: restore valid credentials, set
`HUDDLE_LIVEKIT_TOKEN_ENDPOINT_ENABLED=true`, and certify token readiness.

## Emergency Canary Shutdown

Use for broad customer-impacting LiveKit incidents.

1. Set `HUDDLE_MEDIA_FORCE_MESH=true`.
2. Set `HUDDLE_LIVEKIT_FORCE_MESH=true`.
3. Set `HUDDLE_LIVEKIT_CANARY_ENABLED=false`.
4. Set `HUDDLE_LIVEKIT_ROOM_ENDPOINT_ENABLED=false`.
5. Set `HUDDLE_LIVEKIT_TOKEN_ENDPOINT_ENABLED=false`.
6. Clear `HUDDLE_LIVEKIT_CANARY_WORKSPACES`.
7. Confirm mesh default, room disabled, token disabled, and rollout blocked.

Do not terminate active locked sessions unless incident command explicitly
chooses user-visible interruption over natural session drain.

## Provider Lock Handling

Provider locks are immutable per media session.

1. If a session is mesh-locked, LiveKit join attempts must be rejected or fall
   back before lock creation.
2. If a session is LiveKit-locked, clients must not switch that active session
   to mesh.
3. Provider lock violations should increment operational diagnostics and be
   investigated as split-brain prevention events.
4. Manual database edits are not part of normal rollback.

## Rollback Procedure

1. Freeze rollout stage at the current value.
2. Enable force mesh.
3. Disable room and token endpoints.
4. Remove new workspaces from the canary allowlist.
5. Verify:
   - `npm run verify:huddle-media-governance`
   - `npm run verify:huddle-mobile-livekit`
   - `npm run verify:huddle-operational-readiness`
6. Monitor provider selection counts, fallback counts, room/token failures, and
   provider lock violations.

## Certification Gate

Before advancing a rollout stage, verify the diagnostics report:

- Room status ready.
- Token status ready.
- Canary status ready for the target workspace set.
- Rollout stage allowlist within limit.
- SLO diagnostics not failing.
- Provider lock violation rate within diagnostic threshold.
- Emergency rollback flags documented and tested.
