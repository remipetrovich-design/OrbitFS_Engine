CREATE TABLE IF NOT EXISTS mcp_workspace_default_profile_bundles (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  workspace_id VARCHAR(120) NOT NULL,
  profile_bundle_id VARCHAR(120) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_mcp_default_profile_bundle (workspace_id,profile_bundle_id),
  INDEX idx_mcp_default_profile_bundles_workspace (workspace_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
