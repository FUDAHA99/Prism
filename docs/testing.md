# 验证架构与 CI

测试命令统一见 [README 的本地测试](../README.md#本地测试)。本文补充[系统架构](architecture.md)的验证边界；部署与恢复步骤继续以[部署指南](deploy.md)为准。

| 层级 | 现有入口与实际依赖 | 验证边界 |
|------|------|------|
| 后端单元测试 | `backend/src/**/*.spec.ts`，Jest + ts-jest；依赖故障用 mock 注入 | 配置、权限规则、认证失败分支等；不证明真实 Redis 可用 |
| 后端 HTTP 集成 | `common/testing/http-harness.ts` 及模块专用夹具；真实 Nest、JWT、TypeORM、内存 SQLite | 请求校验、401/403、内容持久化与响应；缓存为内存替身，不经过运行时 MySQL、nginx 或 Redis |
| 管理端 | `frontend/src/**/*.test.ts(x)`，Vitest；API adapter、浏览器存储替身及组件渲染断言 | API 封装、状态与工具函数；没有完整浏览器管理端 CRUD 验收 |
| 门户 | `portal/tests/portal-regression.test.cjs`，Node test runner + Playwright Chromium | 真实 Next 构建/服务、页面交互与媒体；后端是本地 HTTP 夹具，不验证真实认证或数据库 |
| 备份校验 | `backend/src/config/backup-scripts.spec.ts` 调用 `scripts/backup-common.sh` 的隔离函数，临时假数据 | 允许路径、归档条目、校验和与锁；不执行生产备份/恢复，不证明 MySQL、Redis RDB、TLS 恢复成功 |

## 编写与运行约定

通用 HTTP 夹具包含与应用相同的 ValidationPipe、响应包装和全局 AccessGuard；内容模块的专用夹具验证未包装响应，不覆盖全局响应包装。新增路由同时更新 `common/authz/route-access.spec.ts` 的访问矩阵；内存 SQLite 夹具只加载需要的实体，不代表运行时支持 SQLite。

认证专用夹具覆盖登录、刷新与吊销；通用 HTTP 夹具直接签发测试 token，不经过密码登录。测试使用假数据与测试常量，不加载运行时数据库。内容服务的门户缓存失效调用由 mock 观察，实际 Next 缓存行为由门户回归单独验证。

备份校验要求 Bash、GNU tar/coreutils/gzip，Windows 使用标准安装位置的 Git Bash。它只 source 公共函数文件并调用校验、锁函数，临时目录用完删除；归档由内存构造，不提取 `.env`、证书或链接，也不调用 Docker。缺少工具或启动失败应报告为阻塞，不能静默跳过后声称备份通过。

## 与 CI 对应

`.github/workflows/deploy.yml` 的 `verify` 对三端执行安装、构建、测试，portal 先安装 Chromium；构建排除后端 spec，测试类型检查由 ts-jest 执行。后端新增 spec 自动被现有 Jest 入口发现，无需新增工作流。

`database` 使用独立 MySQL / MariaDB 服务验证迁移及并发，`nginx` 校验 HTTP / HTTPS 配置。这两类不能由 SQLite 测试替代。迁移测试的建库、删库权限与隔离要求见[迁移手册](database-migrations.md#6-续播写入约定与验证)。

`audit.yml` 是独立的依赖审计流程，不是部署 job 的依赖。普通测试未启用覆盖率门槛；当前 `test:e2e` 配置缺失及本地执行限制记录在 [test-notes.md](test-notes.md)。本地测试通过不等于远端 CI 已运行，也不等于完成部署或恢复演练。
