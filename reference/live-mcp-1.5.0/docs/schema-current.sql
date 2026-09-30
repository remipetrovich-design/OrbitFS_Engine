-- OrbitFS MCP live schema reference
-- Generated 2026-08-09; schema only, no rows or secrets.
-- Install/upgrade authority: migrations/.

/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `mcp_audit_log` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `scope_id` varchar(120) NOT NULL DEFAULT 'public',
  `actor_user_id` varchar(120) DEFAULT NULL,
  `event_type` varchar(80) NOT NULL,
  `details` json DEFAULT NULL,
  `created_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_mcp_audit_scope` (`scope_id`,`created_at`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `mcp_clients` (
  `id` varchar(180) NOT NULL,
  `user_id` varchar(120) DEFAULT NULL,
  `client_name` varchar(160) NOT NULL,
  `status` enum('active','blocked','revoked') NOT NULL DEFAULT 'active',
  `first_seen_at` datetime(3) NOT NULL,
  `last_seen_at` datetime(3) NOT NULL,
  `metadata` json DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_mcp_clients_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `mcp_connections` (
  `id` char(36) NOT NULL,
  `scope_id` varchar(120) NOT NULL DEFAULT 'public',
  `provider` varchar(40) NOT NULL DEFAULT 'chatgpt',
  `auth_mode` enum('oauth','token') NOT NULL DEFAULT 'oauth',
  `credential_ref` varchar(255) DEFAULT NULL,
  `status` enum('pending','active','blocked','revoked') NOT NULL DEFAULT 'pending',
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_mcp_connections_scope` (`scope_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `mcp_context_bundle_dependencies` (
  `bundle_id` char(36) NOT NULL,
  `depends_on_bundle_id` char(36) NOT NULL,
  `required_flag` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `created_at` datetime(3) NOT NULL,
  PRIMARY KEY (`bundle_id`,`depends_on_bundle_id`),
  KEY `fk_mcp_bundle_dep_child` (`depends_on_bundle_id`),
  CONSTRAINT `fk_mcp_bundle_dep_child` FOREIGN KEY (`depends_on_bundle_id`) REFERENCES `mcp_context_bundles` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_mcp_bundle_dep_parent` FOREIGN KEY (`bundle_id`) REFERENCES `mcp_context_bundles` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `mcp_context_bundle_entries` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `bundle_id` char(36) NOT NULL,
  `entry_type` enum('file','folder') NOT NULL,
  `item_path` text NOT NULL,
  `attachment_type` enum('path','profile') NOT NULL DEFAULT 'path',
  `profile_id` varchar(120) DEFAULT NULL,
  `profile_name` varchar(160) DEFAULT NULL,
  `recursive_flag` tinyint(1) NOT NULL DEFAULT '1',
  `required_flag` tinyint(1) NOT NULL DEFAULT '1',
  `priority` int NOT NULL DEFAULT '100',
  `sort_order` int NOT NULL DEFAULT '0',
  `created_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_mcp_bundle_entries` (`bundle_id`,`priority`,`sort_order`),
  CONSTRAINT `fk_mcp_bundle_entries_bundle` FOREIGN KEY (`bundle_id`) REFERENCES `mcp_context_bundles` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=27 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `mcp_context_bundles` (
  `id` char(36) NOT NULL,
  `workspace_id` varchar(120) NOT NULL,
  `name` varchar(160) NOT NULL,
  `description` varchar(1000) NOT NULL DEFAULT '',
  `enabled` tinyint(1) NOT NULL DEFAULT '1',
  `version` int NOT NULL DEFAULT '1',
  `created_by_user_id` varchar(120) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_mcp_bundle_name` (`workspace_id`,`name`),
  KEY `idx_mcp_bundles_workspace` (`workspace_id`,`enabled`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `mcp_project_context_bundles` (
  `project_id` char(36) NOT NULL,
  `bundle_id` char(36) NOT NULL,
  `required_flag` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `created_at` datetime(3) NOT NULL,
  PRIMARY KEY (`project_id`,`bundle_id`),
  KEY `fk_mcp_project_bundle_bundle` (`bundle_id`),
  KEY `idx_mcp_project_bundles` (`project_id`,`sort_order`),
  CONSTRAINT `fk_mcp_project_bundle_bundle` FOREIGN KEY (`bundle_id`) REFERENCES `mcp_context_bundles` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_mcp_project_bundle_project` FOREIGN KEY (`project_id`) REFERENCES `mcp_projects` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `mcp_project_items` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `project_id` char(36) NOT NULL,
  `item_type` enum('file','folder') NOT NULL,
  `item_path` text NOT NULL,
  `stable_file_id` varchar(180) DEFAULT NULL,
  `missing` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_mcp_project_items_project` (`project_id`),
  CONSTRAINT `fk_mcp_project_items_project` FOREIGN KEY (`project_id`) REFERENCES `mcp_projects` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `mcp_projects` (
  `id` char(36) NOT NULL,
  `workspace_id` varchar(120) NOT NULL,
  `name` varchar(120) NOT NULL,
  `description` varchar(500) NOT NULL DEFAULT '',
  `instructions` text NOT NULL,
  `ai_behaviour` text NOT NULL,
  `enabled` tinyint(1) NOT NULL DEFAULT '1',
  `created_by_user_id` varchar(120) NOT NULL,
  `created_by_username` varchar(120) NOT NULL,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_mcp_projects_workspace` (`workspace_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `mcp_runtime_state` (
  `id` tinyint NOT NULL DEFAULT '1',
  `mode` enum('workspace','public') NOT NULL DEFAULT 'public',
  `workspace_addon_active` tinyint(1) NOT NULL DEFAULT '0',
  `connector_url` varchar(500) DEFAULT NULL,
  `service_status` varchar(40) NOT NULL DEFAULT 'stopped',
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `mcp_startup` (
  `scope_id` varchar(120) NOT NULL,
  `strength` enum('low','medium','high','custom1','custom2') NOT NULL DEFAULT 'medium',
  `instructions` text NOT NULL,
  `ai_behaviour` text NOT NULL,
  `updated_by_user_id` varchar(120) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`scope_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `mcp_startup_projects` (
  `scope_id` varchar(120) NOT NULL,
  `project_id` char(36) NOT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`scope_id`,`project_id`),
  KEY `fk_mcp_legacy_startup_project` (`project_id`),
  CONSTRAINT `fk_mcp_legacy_startup_project` FOREIGN KEY (`project_id`) REFERENCES `mcp_projects` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `mcp_strength_profiles` (
  `workspace_id` varchar(120) NOT NULL,
  `profile` enum('low','medium','high','custom1','custom2') NOT NULL,
  `max_characters` int NOT NULL,
  `max_files` int NOT NULL,
  `updated_by_user_id` varchar(120) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`workspace_id`,`profile`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `mcp_workspace_default_items` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `workspace_id` varchar(120) NOT NULL,
  `item_type` enum('file','folder') NOT NULL,
  `item_path` text NOT NULL,
  `stable_file_id` varchar(180) DEFAULT NULL,
  `missing` tinyint(1) NOT NULL DEFAULT '0',
  `sort_order` int NOT NULL DEFAULT '0',
  `created_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_mcp_default_items_workspace` (`workspace_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `mcp_workspace_preset_bundles` (
  `workspace_id` varchar(120) NOT NULL,
  `preset` enum('low','medium','high','custom1','custom2') NOT NULL,
  `bundle_id` char(36) NOT NULL,
  `required_flag` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `created_at` datetime(3) NOT NULL,
  PRIMARY KEY (`workspace_id`,`preset`,`bundle_id`),
  KEY `fk_mcp_preset_bundle` (`bundle_id`),
  KEY `idx_mcp_preset_bundles` (`workspace_id`,`preset`,`sort_order`),
  CONSTRAINT `fk_mcp_preset_bundle` FOREIGN KEY (`bundle_id`) REFERENCES `mcp_context_bundles` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `mcp_workspace_preset_items` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `workspace_id` varchar(120) NOT NULL,
  `preset` enum('low','medium','high','custom1','custom2') NOT NULL,
  `item_type` enum('file','folder') NOT NULL,
  `item_path` text NOT NULL,
  `recursive_flag` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `created_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_mcp_preset_items_workspace` (`workspace_id`,`preset`)
) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `mcp_workspace_preset_metadata` (
  `workspace_id` varchar(120) NOT NULL,
  `preset` enum('low','medium','high','custom1','custom2') NOT NULL,
  `display_name` varchar(80) NOT NULL DEFAULT '',
  `updated_by_user_id` varchar(120) DEFAULT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`workspace_id`,`preset`),
  KEY `idx_mcp_preset_metadata_workspace` (`workspace_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `mcp_workspace_presets` (
  `workspace_id` varchar(120) NOT NULL,
  `preset` enum('low','medium','high','custom1','custom2') NOT NULL,
  `project_id` char(36) DEFAULT NULL,
  `updated_by_user_id` varchar(120) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`workspace_id`,`preset`),
  KEY `fk_mcp_workspace_preset_project` (`project_id`),
  CONSTRAINT `fk_mcp_workspace_preset_project` FOREIGN KEY (`project_id`) REFERENCES `mcp_projects` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `mcp_workspace_startup` (
  `workspace_id` varchar(120) NOT NULL,
  `strength` enum('low','medium','high','custom1','custom2') NOT NULL DEFAULT 'medium',
  `instructions` text NOT NULL,
  `ai_behaviour` text NOT NULL,
  `updated_by_user_id` varchar(120) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`workspace_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `mcp_workspace_startup_projects` (
  `workspace_id` varchar(120) NOT NULL,
  `project_id` char(36) NOT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`workspace_id`,`project_id`),
  KEY `fk_mcp_workspace_startup_project` (`project_id`),
  CONSTRAINT `fk_mcp_workspace_startup_project` FOREIGN KEY (`project_id`) REFERENCES `mcp_projects` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
