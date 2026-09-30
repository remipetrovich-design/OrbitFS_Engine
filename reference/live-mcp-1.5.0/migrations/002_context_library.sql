CREATE TABLE IF NOT EXISTS mcp_context_bundles (
 id CHAR(36) PRIMARY KEY, workspace_id VARCHAR(120) NOT NULL,
 name VARCHAR(160) NOT NULL, description VARCHAR(1000) NOT NULL DEFAULT '',
 enabled TINYINT(1) NOT NULL DEFAULT 1, version INT NOT NULL DEFAULT 1,
 created_by_user_id VARCHAR(120) NULL, created_at DATETIME(3) NOT NULL,
 updated_at DATETIME(3) NOT NULL,
 UNIQUE KEY uq_mcp_bundle_name (workspace_id,name),
 INDEX idx_mcp_bundles_workspace (workspace_id,enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS mcp_context_bundle_entries (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 bundle_id CHAR(36) NOT NULL, entry_type ENUM('file','folder') NOT NULL,
 item_path TEXT NOT NULL,
 attachment_type ENUM('path','profile') NOT NULL DEFAULT 'path',
 profile_id VARCHAR(120) NULL, profile_name VARCHAR(160) NULL,
 recursive_flag TINYINT(1) NOT NULL DEFAULT 1,
 required_flag TINYINT(1) NOT NULL DEFAULT 1, priority INT NOT NULL DEFAULT 100,
 sort_order INT NOT NULL DEFAULT 0, created_at DATETIME(3) NOT NULL,
 CONSTRAINT fk_mcp_bundle_entries_bundle FOREIGN KEY (bundle_id)
   REFERENCES mcp_context_bundles(id) ON DELETE CASCADE,
 INDEX idx_mcp_bundle_entries (bundle_id,priority,sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS mcp_context_bundle_dependencies (
 bundle_id CHAR(36) NOT NULL, depends_on_bundle_id CHAR(36) NOT NULL,
 required_flag TINYINT(1) NOT NULL DEFAULT 1, sort_order INT NOT NULL DEFAULT 0,
 created_at DATETIME(3) NOT NULL,
 PRIMARY KEY (bundle_id,depends_on_bundle_id),
 CONSTRAINT fk_mcp_bundle_dep_parent FOREIGN KEY (bundle_id)
   REFERENCES mcp_context_bundles(id) ON DELETE CASCADE,
 CONSTRAINT fk_mcp_bundle_dep_child FOREIGN KEY (depends_on_bundle_id)
   REFERENCES mcp_context_bundles(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
