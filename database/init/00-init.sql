-- MySQL 容器首次启动时自动执行
-- 1. 确认数据库 utf8mb4 编码
-- 2. 给 cms 用户全权限（默认只对 cms_dev 库有权限，但开发期方便起见放开）

ALTER DATABASE cms_dev CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 创建测试库（跑测试用，免得污染开发库）
CREATE DATABASE IF NOT EXISTS cms_test
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

GRANT ALL PRIVILEGES ON cms_dev.*  TO 'cms'@'%';
GRANT ALL PRIVILEGES ON cms_test.* TO 'cms'@'%';
FLUSH PRIVILEGES;
