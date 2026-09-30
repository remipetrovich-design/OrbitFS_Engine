CREATE TABLE IF NOT EXISTS mcp_workspace_startup (
  workspace_id VARCHAR(120) NOT NULL,
  strength ENUM('low','medium','high','custom1','custom2') NOT NULL DEFAULT 'medium',
  instructions TEXT NOT NULL,
  ai_behaviour TEXT NOT NULL,
  updated_by_user_id VARCHAR(120) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (workspace_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS mcp_workspace_presets (
  workspace_id VARCHAR(120) NOT NULL,
  preset ENUM('low','medium','high','custom1','custom2') NOT NULL,
  project_id CHAR(36) DEFAULT NULL,
  updated_by_user_id VARCHAR(120) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (workspace_id,preset),
  KEY idx_mcp_workspace_preset_project (project_id),
  CONSTRAINT fk_mcp_workspace_preset_project FOREIGN KEY (project_id)
    REFERENCES mcp_projects(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS mcp_workspace_default_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  workspace_id VARCHAR(120) NOT NULL,
  item_type ENUM('file','folder') NOT NULL,
  item_path TEXT NOT NULL,
  stable_file_id VARCHAR(180) DEFAULT NULL,
  missing TINYINT(1) NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_mcp_default_items_workspace (workspace_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS mcp_workspace_preset_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  workspace_id VARCHAR(120) NOT NULL,
  preset ENUM('low','medium','high','custom1','custom2') NOT NULL,
  item_type ENUM('file','folder') NOT NULL,
  item_path TEXT NOT NULL,
  recursive_flag TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_mcp_preset_items_workspace (workspace_id,preset)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS mcp_workspace_startup_projects (
  workspace_id VARCHAR(120) NOT NULL,
  project_id CHAR(36) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id,project_id),
  KEY idx_mcp_workspace_startup_project (project_id),
  CONSTRAINT fk_mcp_workspace_startup_project FOREIGN KEY (project_id)
    REFERENCES mcp_projects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
