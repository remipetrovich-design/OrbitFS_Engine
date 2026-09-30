# OrbitFS Engine customer database migrations

Normal Engine/add-on customer database evolution is shipped inside immutable OrbitFS Update Bundles. Base database evolution is owned by `V1-vercel-base`.

Use these component directories:

- `shared/` — common update-managed database changes; included whenever any update component is targeted.
- `base/` — reserved legacy directory only. New Base migrations are forbidden here; Base database changes belong to `V1-vercel-base` and the Base Deployer.
- `apex/` — APEX-only database changes.
- `mcp/` — MCP-only database changes.
- `studio/` — Studio-only database changes.

Migration filenames must be `YYYYMMDDHHMMSS_description.sql`. Update bundles carry the cumulative migration history for selected components, so customers may skip versions: the Store applies missing IDs and skips migrations already recorded with the same SHA-256.

Rules:

- Never modify, rename, or delete a migration after publication. Add a new forward migration.
- Do not use explicit `BEGIN`, `COMMIT`, or `ROLLBACK`; the customer updater applies each migration atomically.
- Update migrations must be forward-compatible and non-destructive.
- Base foundational/fresh-install schema remains owned by V1-vercel-base.
