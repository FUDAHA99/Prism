# 测试补充记录（2026-10-23）

分支：`codex/tests-docs-20261023`；起点：`a10e9be`。本次只补测试与文档，无业务逻辑、依赖、锁文件、CI、`.env` 或密钥修改；未 push、部署或连接线上服务器/DNS。

## 覆盖盘点与新增内容

仓库已有后端 Jest/ts-jest 单元与 HTTP/SQLite 集成测试、管理端 Vitest、门户 Node test runner + Chromium 回归。CI 另有真实 MySQL/MariaDB 迁移与 nginx 配置校验。框架、夹具和边界见 [验证架构](testing.md)，常用命令见 [README](../README.md#本地测试)。本次没有引入新依赖。

| 文件 | 新增/强化的行为 |
|------|------|
| `backend/src/common/authz/access.guard.spec.ts` | 1 条：方法未知访问级别覆盖类级 public 时默认按 admin 拒绝，且只记一次错误 |
| `backend/src/modules/auth/auth.security.spec.ts` | 1 条：降权后 refresh 使用数据库当前角色，不继承旧缓存 admin；强化原软删除用例，确认 refresh 同样 401 |
| `backend/src/modules/auth/strategies/jwt.strategy.spec.ts` | 3 条：注销黑名单、改密吊销标记、当前用户查询故障均返回 401，不泄露内部错误 |
| `backend/src/modules/content/content.controller.spec.ts` | 13 条：编辑/删除所有权、软删除后的读写不可见、发布/撤回、无权限和缺失 ID 无副作用、显式 null 清空分类和可选字段 |
| `backend/src/config/backup-scripts.spec.ts` | 26 条：配置白名单、真实 tar/gzip 条目检查、bundle 格式/组件/SHA256、目录检查、锁释放与冲突 |

合计新增 **44 个用例**，强化 **1 个既有用例**。前三个认证文件沿用中断运行留下的有价值改动，已重新审阅并运行；内容创建、字段校验等已有覆盖，新增测试集中在所有权、生命周期与持久化副作用。

备份测试仅调用公共校验与锁函数，所有文件在隔离临时目录；tar 由内存构造，不提取 `.env`、证书或特殊条目，Docker 调用被测试函数拒绝。没有执行 `backup.sh` 或 `restore.sh`，也未验证真实恢复。

## 本次运行结果

环境：Windows PowerShell；实际验证使用仓库缓存中的 **Node 22.23.3**，未重装依赖。默认 PATH 为 Node 24.15.0，与已有 better-sqlite3 的 Node 22 ABI 不匹配；最初的启动失败不计为业务失败。

| 验证项 | 结果 |
|--------|------|
| 认证/权限定向 Jest（3 个 spec） | **3 套 / 114 用例通过**，73.143 秒 |
| 内容定向 Jest | 修改前 **72/72**，修改后 **85/85**，1 套，修改后 9.845 秒 |
| 备份定向 Jest | 26 个用例均被 Bash 子进程 `EPERM` 阻塞；ts-jest 已编译，未验证脚本行为 |
| 后端全量 Jest | **77 套 / 3395 用例通过**；仅备份套件 **26 用例失败，均为 Bash `EPERM`**；总计 78 套 / 3421 用例，161.865 秒，退出码 1 |
| 管理端 Vitest | 默认配置加载时 esbuild `spawn EPERM`；沿用原 Vite 配置、改用原生加载与 threads 的本次临时调用仍被 Vite 路径解析子进程拦截，24 个文件未进入测试执行 |
| 门户回归 | Node test runner 派生子进程时 `spawn EPERM`，Next/Chromium 尚未启动，不能算门户通过 |
| 管理端 TypeScript | `tsc --noEmit` 通过 |
| 门户 TypeScript | `tsc --noEmit --incremental false` 通过 |
| 差异检查 | `git diff --check` 通过；仅 Git 的既有 LF/CRLF 提示 |

没有添加 skip、放宽断言或修改业务代码来制造通过结果。全局覆盖率未测量，不能推断已达到 `test:cov` 的 80% 门槛。未运行真实数据库迁移、Docker/nginx 校验、完整三端构建、远端 CI 或真实备份恢复演练；类型检查不等于构建或浏览器验收。

### 复现命令

正常 Node 22 环境使用 README 的标准 npm 入口。本次机器上的精确后端命令如下（仓库根目录起步；便携 Node 路径只代表本机已有缓存）：

```powershell
$node22 = (Resolve-Path '.cache/node22-qa-20261013-212547-f7899a96/node-v22.23.3-win-x64/node.exe').Path
Set-Location backend
& $node22 node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/common/authz/access.guard.spec.ts src/modules/auth/auth.security.spec.ts src/modules/auth/strategies/jwt.strategy.spec.ts
& $node22 node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/modules/content/content.controller.spec.ts
& $node22 node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/config/backup-scripts.spec.ts
& $node22 node_modules/jest/bin/jest.js --runInBand --json --outputFile=../.cache/tests-docs-backend.json
```

管理端目录：`node node_modules/vitest/vitest.mjs run`、`node node_modules/typescript/bin/tsc --noEmit`；门户目录：`node --test tests/portal-regression.test.cjs`、`node node_modules/typescript/bin/tsc --noEmit --incremental false`。这里的 `node` 均须使用 Node 22；本次均以 `$node22` 对应的绝对路径调用。

完整后端日志与 Jest JSON 留在忽略目录 `.cache/tests-docs-backend.log` / `.cache/tests-docs-backend.json`；前端、门户启动日志为 `.cache/tests-docs-frontend.log`、`.cache/tests-docs-frontend-threads.log`、`.cache/tests-docs-portal.log`。这些是本机产物，不随提交保存。

## 发现的问题与未完成项

1. **接口注解与实际状态码不一致（已复现，未修）**：`content.controller.ts` 的 publish/unpublish `@ApiResponse` 声明 200，但 Nest POST 实际返回 201，现有发布用例及本次发布/撤回 HTTP 用例均确认。需后续明确接口契约后单独处理。
2. **旧 e2e 入口无效（已静态确认，未修）**：`backend/package.json` 的 `test:e2e` 指向不存在的 `test/jest-e2e.json`。当前真实 HTTP 集成测试在普通 Jest 入口，不需要这个旧命令。
3. **执行环境阻塞**：Bash、esbuild、Node test runner 等子进程报 `EPERM`；直接 Git Bash 启动另报 `couldn't create signal pipe, Win32 error 5`。需要允许相应子进程的 Node 22 环境重跑备份、管理端和门户测试；当前无法满足“所有测试通过”。没有修改系统权限或安装替代依赖。
4. **本地提交被阻塞**：认证块通过后已尝试 `git add` / `git commit`，Git 因 `.git` 只读报 `Unable to create .../.git/index.lock: Permission denied`。本会话禁止权限提升，故没有生成任何本地提交，改动完整保留在工作区。
5. **原架构文件不可写**：现有 `docs/architecture.md` 的写入被文件权限拒绝，原文件保持不变；验证架构独立补在 `docs/testing.md`，README 已链接。

恢复 `.git` 正常写权限且完成受阻测试后，可按以下边界分别本地提交（不推送）：认证/权限 3 个 spec；内容 CRUD spec；备份 spec；README、`docs/testing.md`、本记录。任何未通过或未执行的检查都应在更新本记录时保留真实状态。

## 补充（2026-10-23 沙箱外复跑）

- 备份定向 Jest 在沙箱外复跑：25/26 通过。唯一失败的是「接受包含六项有效载荷且 SHA256 manifest 完全匹配的 bundle」：Windows 上 Git Bash 的 `sha256sum` 输出带二进制标记 `*`（`hash *name`），而测试夹具按 Linux 格式（两个空格）写 manifest，所以在 Windows 上比对不一致。脚本面向 Linux 服务器，CI 在 Linux 上运行，未修改。
- 之前记录的「`.git` 只读 / EPERM」是 Codex 沙箱对 `.git` 的拒绝写入保护所致，不是仓库或系统权限问题；提交由沙箱外的本地 shell 完成，未改动任何权限。
