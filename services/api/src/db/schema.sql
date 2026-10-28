-- Neo MD 服务端数据库结构（MySQL 8.0）
-- 全部使用 CREATE TABLE IF NOT EXISTS，可在每次启动时安全重复执行。

CREATE TABLE IF NOT EXISTS `users` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `email` VARCHAR(190) NOT NULL,
  `username` VARCHAR(64) NOT NULL,
  `pass_hash` VARCHAR(255) NOT NULL,
  `role` ENUM('user','admin') NOT NULL DEFAULT 'user',
  `status` ENUM('active','disabled') NOT NULL DEFAULT 'active',
  `quota_bytes` BIGINT NOT NULL DEFAULT 1073741824,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_login_at` DATETIME NULL DEFAULT NULL,
  `last_login_ip` VARCHAR(64) NULL DEFAULT NULL,
  `nickname` VARCHAR(64) NULL DEFAULT NULL,
  `avatar_url` VARCHAR(512) NULL DEFAULT NULL,
  `credits` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_users_email` (`email`),
  UNIQUE KEY `uk_users_username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `refresh_tokens` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT NOT NULL,
  `token_hash` CHAR(64) NOT NULL,
  `device_id` VARCHAR(64) NULL DEFAULT NULL,
  `user_agent` VARCHAR(255) NULL DEFAULT NULL,
  `expires_at` DATETIME NOT NULL,
  `revoked_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_refresh_tokens_hash` (`token_hash`),
  KEY `idx_refresh_tokens_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 用户设置（多端分区同步）：
-- payload_json 存 v2 分组结构
--   { global: { storage, ai, sync, naming, shortcuts, autosave, shareStyle },
--     platform: { desktop: { appearance, layout, enabledPlugins }, web: {...}, android: {...} } }
--   global 为全平台强一致配置；platform 为允许按端差异化的配置。
-- payload_enc 为 AES-256-GCM 密文，结构相同，仅存放 storage/ai 等敏感字段。
-- 旧结构（无 global/platform 字段）在读取时整体视为 global，因此**无需新增表或列**。
CREATE TABLE IF NOT EXISTS `user_settings` (
  `user_id` BIGINT NOT NULL,
  `payload_json` MEDIUMTEXT NULL,
  `payload_enc` MEDIUMTEXT NULL,
  `version` INT NOT NULL DEFAULT 1,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `device_id` VARCHAR(64) NULL DEFAULT NULL,
  PRIMARY KEY (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `shares` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT NOT NULL,
  `doc_id` VARCHAR(64) NOT NULL,
  `token` CHAR(24) NOT NULL,
  `title` VARCHAR(255) NULL DEFAULT NULL,
  `mode` ENUM('read','comment') NOT NULL DEFAULT 'comment',
  `snapshot_md` MEDIUMTEXT NULL,
  `snapshot_html` MEDIUMTEXT NULL,
  `allow_comment` TINYINT(1) NOT NULL DEFAULT 1,
  `expires_at` DATETIME NULL DEFAULT NULL,
  `view_count` INT NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `revoked_at` DATETIME NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_shares_token` (`token`),
  KEY `idx_shares_user` (`user_id`),
  KEY `idx_shares_token` (`token`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `share_comments` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `share_id` BIGINT NOT NULL,
  `author_name` VARCHAR(64) NULL DEFAULT NULL,
  `body` TEXT NOT NULL,
  `ip_hash` CHAR(32) NULL DEFAULT NULL,
  `status` ENUM('visible','hidden') NOT NULL DEFAULT 'visible',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_share_comments_share` (`share_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `share_annotations` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `comment_id` BIGINT NOT NULL,
  `share_id` BIGINT NOT NULL,
  `quote` TEXT NULL,
  `selector_json` TEXT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_share_annotations_share` (`share_id`),
  KEY `idx_share_annotations_comment` (`comment_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `publishes` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT NOT NULL,
  `doc_id` VARCHAR(64) NOT NULL,
  `slug` VARCHAR(120) NOT NULL,
  `title` VARCHAR(255) NULL DEFAULT NULL,
  `oss_key` VARCHAR(512) NULL DEFAULT NULL,
  `url` VARCHAR(512) NULL DEFAULT NULL,
  `rev` INT NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `revoked_at` DATETIME NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_publishes_slug` (`slug`),
  KEY `idx_publishes_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `audit_logs` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT NULL DEFAULT NULL,
  `action` VARCHAR(64) NOT NULL,
  `target` VARCHAR(255) NULL DEFAULT NULL,
  `detail_json` TEXT NULL,
  `ip` VARCHAR(64) NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_audit_logs_user` (`user_id`),
  KEY `idx_audit_logs_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- AI 调用流水。1.1.8 起补 status / latency_ms / error_code 三列，
-- 用于后台看板计算「失败率」与「平均响应时间」（此前只有 token 与费用）。
CREATE TABLE IF NOT EXISTS `ai_usage` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT NOT NULL,
  `provider` VARCHAR(40) NULL DEFAULT NULL,
  `model` VARCHAR(80) NULL DEFAULT NULL,
  `in_tokens` INT NOT NULL DEFAULT 0,
  `out_tokens` INT NOT NULL DEFAULT 0,
  `cost` BIGINT NOT NULL DEFAULT 0,
  `status` ENUM('ok','error') NOT NULL DEFAULT 'ok',
  `latency_ms` INT NOT NULL DEFAULT 0,
  `error_code` VARCHAR(64) NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_ai_usage_user_created` (`user_id`, `created_at`),
  KEY `idx_ai_usage_created_status` (`created_at`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 用户仓库注册表（1.1.5 起为多仓库同步的前置条件）
-- 存储前缀按仓库隔离：mdadmin/neomd/users/<username>/vaults/<vault_id>/
-- status=disabled 时该仓库的 /api/storage/* 会被拒绝但数据保留。
CREATE TABLE IF NOT EXISTS `user_vaults` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT NOT NULL,
  `vault_id` VARCHAR(64) NOT NULL,
  `name` VARCHAR(120) NULL DEFAULT NULL,
  `doc_count` INT NOT NULL DEFAULT 0,
  `bytes` BIGINT NOT NULL DEFAULT 0,
  `status` ENUM('active','disabled') NOT NULL DEFAULT 'active',
  `last_synced_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_vaults` (`user_id`, `vault_id`),
  KEY `idx_user_vaults_user_status` (`user_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 积分流水：余额变更的唯一账本，delta 为正表示入账、为负表示扣减。
CREATE TABLE IF NOT EXISTS `credit_ledger` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT NOT NULL,
  `delta` BIGINT NOT NULL,
  `balance_after` BIGINT NOT NULL,
  `kind` ENUM('recharge','consume','grant','refund') NOT NULL,
  `ref` VARCHAR(120) NULL DEFAULT NULL,
  `detail_json` TEXT NULL,
  `created_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_credit_ledger_user_created` (`user_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 平台代付的 AI 供应商配置，api_key_enc 为 AES-256-GCM 密文，永不对外回传。
-- 1.1.7 起新增展示元数据列（signup_url / docs_url / note / sort_order）：
-- 这几列允许为 NULL，NULL 表示「未自定义」，读取时回落到 lib/platform.js 的内置默认值，
-- 因此老库升级后无需手工补数据。老库补列见 migrate-v2.js 的 COLUMN_ADDITIONS（幂等）。
-- 注意 sort_order 必须允许 NULL（不能用 NOT NULL DEFAULT 100）：否则「未配置」会被
-- 100 这个哨兵值掩盖，所有供应商挤在同一顺位，内置的差异化排序就失效了。
--
-- 1.1.8 起再新增平台付费侧的「模型治理」三列（同样 NULL = 未自定义）：
--   default_model     ：该供应商的默认模型（前台预选）
--   model_settings_json：每模型独立设置（温度上限 / 最大 token / 单价 / 系统提示词）
--   system_prompt     ：该供应商的兜底系统提示词（模型级未配时使用）
CREATE TABLE IF NOT EXISTS `platform_ai_providers` (
  `provider` VARCHAR(40) NOT NULL,
  `base_url` VARCHAR(255) NOT NULL,
  `api_key_enc` TEXT NULL,
  `models_json` TEXT NULL,
  `enabled` TINYINT(1) NOT NULL DEFAULT 0,
  `priority` INT NOT NULL DEFAULT 100,
  `signup_url` VARCHAR(255) NULL DEFAULT NULL,
  `docs_url` VARCHAR(255) NULL DEFAULT NULL,
  `note` VARCHAR(500) NULL DEFAULT NULL,
  `sort_order` INT NULL DEFAULT NULL,
  `default_model` VARCHAR(120) NULL DEFAULT NULL,
  `model_settings_json` MEDIUMTEXT NULL,
  `system_prompt` TEXT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`provider`),
  KEY `idx_platform_ai_sort` (`sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 兑换码：used_by / used_at 非空即视为已核销，删除只允许未使用的码。
CREATE TABLE IF NOT EXISTS `redeem_codes` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `code` VARCHAR(24) NOT NULL,
  `credits` BIGINT NOT NULL,
  `used_by` BIGINT NULL DEFAULT NULL,
  `used_at` DATETIME NULL DEFAULT NULL,
  `created_by` BIGINT NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_redeem_codes_code` (`code`),
  KEY `idx_redeem_codes_used` (`used_by`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 平台键值配置：计费、支付方式等运营参数。
CREATE TABLE IF NOT EXISTS `platform_config` (
  `cfg_key` VARCHAR(64) NOT NULL,
  `cfg_value` MEDIUMTEXT NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`cfg_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 用户仓库备份记录，实体文件在对象存储 us/<用户名>/bk/ 或 admin/ 下。
CREATE TABLE IF NOT EXISTS `backups` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT NOT NULL,
  `vault_id` VARCHAR(64) NOT NULL,
  `name` VARCHAR(160) NOT NULL,
  `doc_count` INT NOT NULL DEFAULT 0,
  `bytes` BIGINT NOT NULL DEFAULT 0,
  `oss_key` VARCHAR(512) NOT NULL,
  `created_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_backups_user_created` (`user_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 插件市场与插件开放平台：用户/开发者发布的扩展插件。
CREATE TABLE IF NOT EXISTS `community_plugins` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `plugin_id` VARCHAR(64) NOT NULL,
  `user_id` BIGINT NOT NULL,
  `author_name` VARCHAR(64) NOT NULL,
  `name` VARCHAR(80) NOT NULL,
  `version` VARCHAR(32) NOT NULL DEFAULT '1.0.0',
  `category` VARCHAR(32) NOT NULL DEFAULT 'writing',
  `icon` VARCHAR(255) NOT NULL DEFAULT 'layers',
  `description` VARCHAR(500) NOT NULL,
  `readme_md` MEDIUMTEXT NULL,
  `manifest_json` TEXT NULL,
  `code_js` MEDIUMTEXT NOT NULL,
  `status` ENUM('published','pending','rejected','disabled') NOT NULL DEFAULT 'published',
  `downloads` BIGINT NOT NULL DEFAULT 0,
  `stars` BIGINT NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_community_plugins_pid` (`plugin_id`),
  KEY `idx_community_plugins_user` (`user_id`),
  KEY `idx_community_plugins_status` (`status`, `downloads`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- AI 知识库使用统计（1.1.0）。
-- 只记录「用量」元数据：查询次数、上下文长度、命中的片段数、token 与费用。
-- 刻意不存用户的笔记内容 —— 切片与检索都在客户端完成，服务端只做 AI 代理转发。
CREATE TABLE IF NOT EXISTS `knowledge_usage` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT NOT NULL,
  `model` VARCHAR(80) NOT NULL,
  `context_chars` INT NOT NULL DEFAULT 0,
  `chunk_count` INT NOT NULL DEFAULT 0,
  `in_tokens` INT NOT NULL DEFAULT 0,
  `out_tokens` INT NOT NULL DEFAULT 0,
  `cost` INT NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_knowledge_usage_user` (`user_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- AI 知识库访问令牌（1.1.8）。
--
-- 用途：让外部 AI / 智能体用 `Authorization: Bearer <token>` 调用
-- `/api/knowledge/chat` 与 `/api/knowledge/stats`，无需用户账号密码。
--
-- 安全约定：
--  - 只存 **SHA-256 哈希**（token_hash），明文仅在创建响应里返回一次；
--  - token_prefix 存前 12 位明文，用于在列表里区分「是哪一把」，不构成泄露风险；
--  - 吊销用 revoked_at 软删除，保留审计痕迹；
--  - last_used_at 在每次成功鉴权时更新（节流写，避免每请求都 UPDATE）。
CREATE TABLE IF NOT EXISTS `knowledge_tokens` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT NOT NULL,
  `name` VARCHAR(80) NOT NULL,
  `token_hash` CHAR(64) NOT NULL,
  `token_prefix` VARCHAR(16) NOT NULL DEFAULT '',
  `scope` ENUM('read','write') NOT NULL DEFAULT 'read',
  `expires_at` DATETIME NULL DEFAULT NULL,
  `last_used_at` DATETIME NULL DEFAULT NULL,
  `revoked_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_knowledge_tokens_hash` (`token_hash`),
  KEY `idx_knowledge_tokens_user` (`user_id`, `revoked_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;