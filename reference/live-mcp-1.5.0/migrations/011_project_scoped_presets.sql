CREATE TABLE IF NOT EXISTS mcp_project_preset_items (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  project_id CHAR(36) NOT NULL,
  preset ENUM('low','medium','high','custom1','custom2') NOT NULL,
  item_type ENUM('file','folder') NOT NULL,
  item_path TEXT NOT NULL,
  recursive_flag TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  CONSTRAINT fk_mcp_project_preset_items_project FOREIGN KEY (project_id)
    REFERENCES mcp_projects(id) ON DELETE CASCADE,
  INDEX idx_mcp_project_preset_items (project_id,preset)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS mcp_project_preset_profiles (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  project_id CHAR(36) NOT NULL,
  preset ENUM('low','medium','high','custom1','custom2') NOT NULL,
  profile_id VARCHAR(120) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_mcp_project_preset_profile (project_id,preset,profile_id),
  CONSTRAINT fk_mcp_project_preset_profiles_project FOREIGN KEY (project_id)
    REFERENCES mcp_projects(id) ON DELETE CASCADE,
  INDEX idx_mcp_project_preset_profiles (project_id,preset)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS mcp_project_preset_profile_bundles (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  project_id CHAR(36) NOT NULL,
  preset ENUM('low','medium','high','custom1','custom2') NOT NULL,
  profile_bundle_id VARCHAR(120) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_mcp_project_preset_profile_bundle (project_id,preset,profile_bundle_id),
  CONSTRAINT fk_mcp_project_preset_profile_bundles_project FOREIGN KEY (project_id)
    REFERENCES mcp_projects(id) ON DELETE CASCADE,
  INDEX idx_mcp_project_preset_profile_bundles (project_id,preset)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS mcp_project_preset_bundles (
  project_id CHAR(36) NOT NULL,
  preset ENUM('low','medium','high','custom1','custom2') NOT NULL,
  bundle_id CHAR(36) NOT NULL,
  required_flag TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (project_id,preset,bundle_id),
  CONSTRAINT fk_mcp_project_preset_bundle_project FOREIGN KEY (project_id)
    REFERENCES mcp_projects(id) ON DELETE CASCADE,
  CONSTRAINT fk_mcp_project_preset_bundle_bundle FOREIGN KEY (bundle_id)
    REFERENCES mcp_context_bundles(id) ON DELETE CASCADE,
  INDEX idx_mcp_project_preset_bundles (project_id,preset,sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
