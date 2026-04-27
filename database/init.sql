-- CMS内容管理系统数据库初始化脚本
-- 创建时间: 2026-04-24

-- 创建扩展
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "unaccent";

-- 用户表
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    nickname VARCHAR(100),
    avatar_url VARCHAR(500),
    is_active BOOLEAN DEFAULT true,
    last_login_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    deleted_at TIMESTAMP
);

-- 角色表
CREATE TABLE IF NOT EXISTS roles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(50) UNIQUE NOT NULL,
    description TEXT,
    is_system BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 权限表
CREATE TABLE IF NOT EXISTS permissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code VARCHAR(100) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    module VARCHAR(50) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- 角色权限关联表
CREATE TABLE IF NOT EXISTS role_permissions (
    role_id UUID REFERENCES roles(id) ON DELETE CASCADE,
    permission_id UUID REFERENCES permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

-- 用户角色关联表
CREATE TABLE IF NOT EXISTS user_roles (
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    role_id UUID REFERENCES roles(id) ON DELETE CASCADE,
    assigned_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (user_id, role_id)
);

-- 内容表
CREATE TABLE IF NOT EXISTS contents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(500) NOT NULL,
    slug VARCHAR(500) UNIQUE NOT NULL,
    content_type VARCHAR(50) DEFAULT 'article',
    status VARCHAR(20) DEFAULT 'draft',
    author_id UUID REFERENCES users(id),
    category_id UUID,
    featured_image_url VARCHAR(500),
    excerpt TEXT,
    body TEXT NOT NULL,
    meta_title VARCHAR(200),
    meta_description VARCHAR(300),
    view_count INTEGER DEFAULT 0,
    is_published BOOLEAN DEFAULT false,
    published_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    deleted_at TIMESTAMP
);

-- 分类表
CREATE TABLE IF NOT EXISTS categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    description TEXT,
    parent_id UUID REFERENCES categories(id),
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 标签表
CREATE TABLE IF NOT EXISTS tags (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 内容标签关联表
CREATE TABLE IF NOT EXISTS content_tags (
    content_id UUID REFERENCES contents(id) ON DELETE CASCADE,
    tag_id UUID REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (content_id, tag_id)
);

-- 媒体文件表
CREATE TABLE IF NOT EXISTS media_files (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    filename VARCHAR(255) NOT NULL,
    original_name VARCHAR(255) NOT NULL,
    mime_type VARCHAR(100) NOT NULL,
    size INTEGER NOT NULL,
    url VARCHAR(500) NOT NULL,
    thumbnail_url VARCHAR(500),
    width INTEGER,
    height INTEGER,
    uploader_id UUID REFERENCES users(id),
    is_used BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 审计日志表
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id),
    action VARCHAR(100) NOT NULL,
    resource_type VARCHAR(50) NOT NULL,
    resource_id UUID,
    ip_address INET,
    user_agent TEXT,
    old_values JSONB,
    new_values JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);

-- 系统配置表
CREATE TABLE IF NOT EXISTS system_configs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    config_key VARCHAR(100) UNIQUE NOT NULL,
    config_value JSONB NOT NULL,
    description TEXT,
    is_editable BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_is_active ON users(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_contents_status ON contents(status);
CREATE INDEX IF NOT EXISTS idx_contents_author ON contents(author_id);
CREATE INDEX IF NOT EXISTS idx_contents_category ON contents(category_id);
CREATE INDEX IF NOT EXISTS idx_contents_published ON contents(is_published, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_contents_slug ON contents(slug);
CREATE INDEX IF NOT EXISTS idx_media_uploader ON media_files(uploader_id);
CREATE INDEX IF NOT EXISTS idx_media_mime_type ON media_files(mime_type);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);

-- 插入系统角色
INSERT INTO roles (id, name, description, is_system) VALUES
    ('00000000-0000-0000-0000-000000000001', 'admin', '系统管理员', true),
    ('00000000-0000-0000-0000-000000000002', 'editor', '内容编辑', true),
    ('00000000-0000-0000-0000-000000000003', 'author', '内容作者', true),
    ('00000000-0000-0000-0000-000000000004', 'user', '普通用户', true)
ON CONFLICT (id) DO NOTHING;

-- 插入系统权限
INSERT INTO permissions (id, code, name, description, module) VALUES
    ('10000000-0000-0000-0000-000000000001', 'user:read', '查看用户', '查看用户信息', 'user'),
    ('10000000-0000-0000-0000-000000000002', 'user:create', '创建用户', '创建新用户', 'user'),
    ('10000000-0000-0000-0000-000000000003', 'user:update', '更新用户', '更新用户信息', 'user'),
    ('10000000-0000-0000-0000-000000000004', 'user:delete', '删除用户', '删除用户', 'user'),
    ('20000000-0000-0000-0000-000000000001', 'content:read', '查看内容', '查看内容', 'content'),
    ('20000000-0000-0000-0000-000000000002', 'content:create', '创建内容', '创建新内容', 'content'),
    ('20000000-0000-0000-0000-000000000003', 'content:update', '更新内容', '更新内容', 'content'),
    ('20000000-0000-0000-0000-000000000004', 'content:delete', '删除内容', '删除内容', 'content'),
    ('20000000-0000-0000-0000-000000000005', 'content:publish', '发布内容', '发布取消发布内容', 'content'),
    ('30000000-0000-0000-0000-000000000001', 'media:read', '查看媒体', '查看媒体文件', 'media'),
    ('30000000-0000-0000-0000-000000000002', 'media:upload', '上传媒体', '上传媒体文件', 'media'),
    ('30000000-0000-0000-0000-000000000003', 'media:delete', '删除媒体', '删除媒体文件', 'media')
ON CONFLICT (id) DO NOTHING;

-- 插入默认管理员账号 (密码: admin123)
INSERT INTO users (id, username, email, password_hash, nickname, is_active) VALUES
    ('00000000-0000-0000-0000-000000000001', 'admin', 'admin@cms.com', '$2b$12$exVbtk2RFKDR8VSDw7ZgvO1NP8ZnjIgS.dU9ilrVYKZeSVGQpKV/G', '系统管理员', true)
ON CONFLICT (id) DO NOTHING;

-- 给管理员分配 admin 角色
INSERT INTO user_roles (user_id, role_id) VALUES
    ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001')
ON CONFLICT DO NOTHING;

SELECT 'CMS数据库初始化完成' as message;
SELECT '创建时间: ' || NOW() as created_at;
