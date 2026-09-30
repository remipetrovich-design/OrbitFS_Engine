CREATE TABLE IF NOT EXISTS mcp_workspace_preset_bundles (
  workspace_id VARCHAR(120) NOT NULL,
  preset ENUM('low','medium','high','custom1','custom2') NOT NULL,
  bundle_id CHAR(36) NOT NULL,
  required_flag TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (workspace_id,preset,bundle_id),
  CONSTRAINT fk_mcp_preset_bundle FOREIGN KEY (bundle_id)
    REFERENCES mcp_context_bundles(id) ON DELETE CASCADE,
  INDEX idx_mcp_preset_bundles (workspace_id,preset,sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS mcp_project_context_bundles (
  project_id CHAR(36) NOT NULL,
  bundle_id CHAR(36) NOT NULL,
  required_flag TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (project_id,bundle_id),
  CONSTRAINT fk_mcp_project_bundle_project FOREIGN KEY (project_id)
    REFERENCES mcp_projects(id) ON DELETE CASCADE,
  CONSTRAINT fk_mcp_project_bundle_bundle FOREIGN KEY (bundle_id)
    REFERENCES mcp_context_bundles(id) ON DELETE CASCADE,
  INDEX idx_mcp_project_bundles (project_id,sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
