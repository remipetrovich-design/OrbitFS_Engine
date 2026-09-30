CREATE TABLE IF NOT EXISTS mcp_workspace_preset_metadata (
 workspace_id VARCHAR(120) NOT NULL,
 preset ENUM('low','medium','high','custom1','custom2') NOT NULL,
 display_name VARCHAR(80) NOT NULL DEFAULT '',
 updated_by_user_id VARCHAR(120) NULL,
 updated_at DATETIME(3) NOT NULL,
 PRIMARY KEY(workspace_id,preset),
 INDEX idx_mcp_preset_metadata_workspace(workspace_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
