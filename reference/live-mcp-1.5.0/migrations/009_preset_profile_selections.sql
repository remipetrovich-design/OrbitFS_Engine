CREATE TABLE IF NOT EXISTS mcp_workspace_preset_profiles (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  workspace_id VARCHAR(120) NOT NULL,
  preset ENUM('low','medium','high','custom1','custom2') NOT NULL,
  profile_id VARCHAR(120) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_mcp_preset_profile (workspace_id,preset,profile_id),
  INDEX idx_mcp_preset_profiles (workspace_id,preset)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS mcp_workspace_preset_profile_bundles (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  workspace_id VARCHAR(120) NOT NULL,
  preset ENUM('low','medium','high','custom1','custom2') NOT NULL,
  profile_bundle_id VARCHAR(120) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_mcp_preset_profile_bundle (workspace_id,preset,profile_bundle_id),
  INDEX idx_mcp_preset_profile_bundles (workspace_id,preset)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
