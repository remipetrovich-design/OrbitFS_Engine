CREATE TABLE IF NOT EXISTS mcp_project_preset_metadata (
  project_id CHAR(36) NOT NULL,
  preset ENUM('low','medium','high','custom1','custom2') NOT NULL,
  display_name VARCHAR(80) NOT NULL DEFAULT '',
  updated_by_user_id VARCHAR(120) NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (project_id,preset),
  CONSTRAINT fk_mcp_project_preset_metadata_project FOREIGN KEY (project_id)
    REFERENCES mcp_projects(id) ON DELETE CASCADE,
  INDEX idx_mcp_project_preset_metadata_project (project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
