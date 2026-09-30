# OrbitFS V1 Vercel Engine Host

`V1-vercel-engine` is the separate OrbitFS Engine Host for the Vercel + Supabase build. It hosts the runtime/configuration side of OrbitFS MCP, APEX and Studio. The main OrbitFS Panel remains in `V1-vercel-base`.

The separate repository is intentional: a brand-new Base install does not need an Engine Host at all. The Engine Host is only deployed when an engine-backed add-on is installed, and later updates redeploy that existing Engine Vercel project without reinstalling the customer's Panel or data.

## Engine Host owns

- Engine first-time setup after Panel attach
- MCP runtime and `/mcp` transport
- MCP OAuth, client/session and connection management
- APEX runtime configuration, processing and job controls
- Studio engine processing/configuration
- Engine runtime state, monitoring, logs and diagnostics

## Panel owns

- Users, authentication and permissions
- Workspaces and workspace access
- Library, Knowledge and Profiles
- Projects, OSS and CCS
- Normal Panel-side Studio data/UI
- Licensing, installation identity and add-on install/attach/detach controls
- Release/update coordination and pre-update checkpoints

## Install and link lifecycle

1. Deploy `V1-vercel-base` and complete Base first-time setup.
2. Do not deploy an Engine Host unless an engine-backed add-on is needed.
3. Install MCP, APEX or Studio from the Panel.
4. Panel validates licensing and deploys/links the shared Engine Host when required.
5. The shared `orbitfs_addons` registry records the Panel, installation and workspace link.
6. Engine Host exposes **Complete setup** for the attached engine.
7. Complete engine setup and verify readiness.
8. Future Engine-backed add-ons reuse the same Engine Host.
9. MCP runs request-driven as `running` or `stopped`; MCP does not use Standby mode. APEX retains its own on-demand runtime/idle policy.

`licensed`, `installed`, `attached`, `linked`, `setupState` and runtime state are separate states and must remain separate.

## Release state and differential updates

Every Engine release is a complete immutable target snapshot, not just a list of commits. The release manifest records the source commit, selected components, per-component versions, every packaged file, file component, file size and SHA-256. The customer Base compares the installed Engine inventory with the target manifest before deploying and produces an update plan containing added, modified, removed and unchanged files plus component-version changes.

A customer may jump directly from an older Engine release to a newer published release. The updater does not require every intermediate update to be installed; it compares the recorded installed state with the target state. If the installed Engine release is newer than the target, the update is blocked unless the release is explicitly a rollback. If the target requires a newer Base version, the update is blocked until Base is updated. A pre-update checkpoint is captured before an existing Engine deployment is replaced, and the new manifest is only marked active after the Vercel deployment reaches Ready.

Vercel deployments are immutable snapshots, so the deployer always sends a complete target snapshot to Vercel; the differential plan determines exactly what changed and prevents unnecessary no-op deployments. Vercel's immutable deployment model also provides a preserved rollback target.

## Release model

The Engine Host does not use `BASE_RELEASE`. Clean Base installs come only from `V1-vercel-base/BASE_RELEASE`.

Engine changes are published directly from the default `main` branch using the same global OrbitFS update version as the matching Panel update. The GitHub Action provides checkbox selectors for APEX, MCP and Studio. If an update is Panel-only, no Engine candidate is needed.

Every Engine update is checkpoint-protected by the Panel before the existing Engine project is redeployed. The checkpoint records the previous Engine deployment/release link and add-on state so rollback can return to the known-good release without reinstalling the installation.

## Required environment

See `.env.example`.

When the Engine Host is actually deployed, its core requirements are:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `ORBITFS_DB_SECRET`
- `ORBITFS_PANEL_URL`
- `ORBITFS_ENGINE_HOST_URL`

The Engine Host uses the shared OrbitFS Supabase registry for pairing state; it does not require a second account system or separate Engine Host database.

## APEX readiness

APEX is installable through the Panel add-on lifecycle. Before jobs are accepted, the Engine Host verifies that APEX is installed, attached, linked, configured and available. Processing supports the canonical Library/Knowledge path, source-format validation, normalized document processing, provenance metadata, revision handling and routing controls.

## Development

```bash
npm install
npm run check
npm run build
```
