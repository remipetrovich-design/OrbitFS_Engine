CREATE TABLE IF NOT EXISTS mcp_runtime_state (
 id TINYINT PRIMARY KEY DEFAULT 1, mode ENUM('workspace','public') NOT NULL DEFAULT 'public',
 workspace_addon_active TINYINT(1) NOT NULL DEFAULT 0, connector_url VARCHAR(500) NULL,
 service_status VARCHAR(40) NOT NULL DEFAULT 'stopped', updated_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS mcp_projects (
 id CHAR(36) PRIMARY KEY, workspace_id VARCHAR(120) NOT NULL DEFAULT 'public', name VARCHAR(120) NOT NULL,
 description VARCHAR(500) NOT NULL DEFAULT '', instructions TEXT NOT NULL, ai_behaviour TEXT NOT NULL,
 enabled TINYINT(1) NOT NULL DEFAULT 1, created_by_user_id VARCHAR(120) NOT NULL,
 created_by_username VARCHAR(120) NOT NULL, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
 INDEX idx_mcp_projects_workspace (workspace_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS mcp_project_items (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, project_id CHAR(36) NOT NULL,
 item_type ENUM('file','folder') NOT NULL, item_path TEXT NOT NULL, stable_file_id VARCHAR(180) NULL,
 missing TINYINT(1) NOT NULL DEFAULT 0, created_at DATETIME(3) NOT NULL,
 INDEX idx_mcp_project_items_project(project_id),
 CONSTRAINT fk_mcp_project_items_project FOREIGN KEY (project_id) REFERENCES mcp_projects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS mcp_clients (
 id VARCHAR(180) PRIMARY KEY, user_id VARCHAR(120) NULL, client_name VARCHAR(160) NOT NULL,
 status ENUM('active','blocked','revoked') NOT NULL DEFAULT 'active', first_seen_at DATETIME(3) NOT NULL,
 last_seen_at DATETIME(3) NOT NULL, metadata JSON NULL, INDEX idx_mcp_clients_status(status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS mcp_audit_log (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, scope_id VARCHAR(120) NOT NULL DEFAULT 'public',
 actor_user_id VARCHAR(120) NULL, event_type VARCHAR(80) NOT NULL, details JSON NULL, created_at DATETIME(3) NOT NULL,
 INDEX idx_mcp_audit_scope(scope_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
