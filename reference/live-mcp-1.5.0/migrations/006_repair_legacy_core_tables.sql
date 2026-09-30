-- Legacy repair migration retained for upgrade ordering.
-- The active MCP schema lives in the main OrbitFS database using mcp_* tables.
CREATE TABLE IF NOT EXISTS mcp_audit_log (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  scope_id VARCHAR(120) NOT NULL DEFAULT 'public',
  actor_user_id VARCHAR(120) NULL,
  event_type VARCHAR(80) NOT NULL,
  details JSON NULL,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_mcp_audit_scope(scope_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
