# OrbitFS MCP add-on 1.4.0

Install this package through OrbitFS Add-on Management.

## Automatic operating mode

The engine checks Workspaces at install, attach, startup and health-check time.
It uses `workspace` mode only when Workspaces is installed, licensed, attached and active.
Otherwise it uses `public` mode against the panel public/default storage root.
Workspaces is an optional integration, not a hard dependency, and mode changes do not delete records.

## Installation behaviour

- Requires the `orbitfs_mcp` licence component.
- Reuses or provisions the shared MySQL server and `orbitfs` database.
- Imports only unapplied `mcp_*` migrations.
- Installs the MCP engine as the `OrbitFSMcpServer` service.
- Registers ChatGPT connection metadata and exposes `/mcp` plus `/health`.
- Registers its own menus, pages, backend routes and status slot.
- Detach and normal uninstall preserve database records and configuration.

## Core interfaces required

`mysql`, `db`, `migrations`, `configStore`, `registry`, `router`, `frontend`, `storage`, `service`, `connector`, `license`, `transport`, `manifest`, and `addonRoot`.
Secrets and OAuth tokens remain in the OrbitFS core secret store and are never packaged.


## MCP Admin
Owner/admin-only menu contributed entirely by the add-on: Runtime, Settings, Startup, Projects, Connected clients, Client registry, Auth sessions, and Logs.

## 1.4 highlights

- Native ChatGPT file handoff with explicit OrbitFS transfer intent.
- ChatGPT Library import workflow and device-upload fallback.
- Embedded Files and Upload tabs with preview, download, rename, move, delete and folder controls.
- Persistent OAuth state outside the packaged engine runtime.
- Package validation excludes runtime state and repair scratch files.
