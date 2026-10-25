# 2026-10-23 代码审查修复记录

审查报告：`F:\METU\code-review-20261023.md`。工作分支：`codex/review-fixes-20261023`，起点 `bd461905c055dcb92813d89860a3357d6339185b`。本记录区分已写入修复、尚未应用的候选补丁和未完成的运行验收。

## 执行范围

- 已完整阅读报告，按 1–13 顺序核实和处理；辅助代理先只读分析。
- 不提交、不推送、不部署，不连接线上服务器或 DNS，不读取或修改真实 `.env` 和密钥。
- Jest、tsc 使用仓库缓存 Node v22.23.3；测试使用隔离夹具，不能替代生产 MySQL、Redis、Docker、备份恢复和浏览器验收。
- 不改历史迁移、不加依赖；数据库结构变化以新增迁移交付，既有数据冲突不自动裁决。

## 逐项结果

### 1. 固定管理员初始密码 — 部分修复

报告成立。`backend/scripts/seed-admin.js` 改为仅在新建账号时要求 `ADMIN_INITIAL_PASSWORD`（至少 12 字符、最多 72 UTF-8 字节，含字母和非字母），不打印密码；已有账号保留密码、启用状态及角色，不能因占用默认邮箱获得管理员权限。CLI 使用事务创建账号和角色，避免初始化中断留下半成品。`.env.prod.example`、`backend/.env.example`、`docker-compose.prod.yml` 与 README、开发/部署文档同步更新。

测试：`backend/src/modules/role/seed-admin.spec.ts`，新增/修改 7 个回归用例在修复前失败；修复后 17/17 通过。使用 SQL 内存替身，未连接数据库。

待完成：`scripts/deploy.sh` 写入被当前沙箱拒绝（`PermissionError` / `Failed to write file`；普通文件非只读）。部署前初始化、移除旧密码提示等脚本修改尚未落地，不计为已修复；需恢复该文件写权限后应用待交付补丁。

### 2. 会话撤销被缓存错误或淘汰绕过 — 已修

- 确认成立：锁定版本 `cache-manager` 的 `get` 捕获存储异常并返回 `undefined`；认证路径此前将其当作未撤销。注销和管理员重置后清空普通缓存，两条新增真实 HTTP 回归均先失败（应为 401，实际 200）。
- 新增独立数据库 `token_revocations` 表和 `TokenRevocationStore`。access 黑名单、refresh 轮换/注销黑名单、用户撤销时间全部脱离普通缓存；数据库读失败不放行，写失败不报告成功。普通缓存仅继续承担原有资料缓存、失败计数和受信任 IP。
- 本人及管理员改密将密码与用户撤销时间放在同一数据库事务；撤销写入失败时密码回滚。既有受信任 IP 并发锁保留。
- 单调 UPSERT 使迟到的旧撤销时间不能覆盖较新状态，也不缩短保留期。每次撤销写入用过期索引删除自然过期记录；全局基线 `expiresAt IS NULL` 永不参与清理。无撤销写入时不会自动清理，下一次写入会补清。
- 新迁移 `1792713600000-PersistentTokenRevocation.ts` 创建表后使用数据库当前毫秒时间写入永久全局撤销基线，避免切换存储时旧 Redis 撤销状态丢失。未修改历史迁移。
- JWT 格式和正常接口成功响应保持不变；迁移前所有 access/refresh token 失效，用户需重新登录。
- `README.md` 技术栈说明同步为撤销状态存入数据库，Redis 继续承担缓存和登录限流。
- 每个认证请求现在执行 3 条撤销状态读取及 1 条原有用户/角色联表读取；查询数量测试已精确更新，同时保留不查询 passwordHash、不使用用户资料缓存的断言。

主要实现文件：

- `backend/src/modules/auth/entities/token-revocation.entity.ts`
- `backend/src/modules/auth/token-revocation.store.ts`
- `backend/src/modules/auth/token-revocation.ts`
- `backend/src/modules/auth/auth.service.ts`
- `backend/src/modules/auth/strategies/jwt.strategy.ts`
- `backend/src/modules/auth/login-attempts.ts`
- `backend/src/modules/user/user.service.ts`
- `backend/src/modules/user/user.module.ts`
- `backend/src/shared/database/data-source.ts`
- `backend/src/shared/database/migrations/1792713600000-PersistentTokenRevocation.ts`

新增/修改测试：

- 新增 `token-revocation.store.spec.ts`：真实内存 SQLite，验证缺失/过期、数据库故障、单调写入、过期清理和永久全局基线。
- 新增 `persistent-token-revocation-migration.spec.ts`：QueryRunner 替身验证迁移内容、已有表拒绝、禁止不安全回滚；不是 MySQL 实跑。
- 修改 `auth.security.spec.ts`：缓存丢失后的重放、真实表读取错误、触发器拒绝写入、两条改密路径事务回滚；既有 TTL/竞态断言迁移到真实数据库存储。
- 修改 `login-attempts.spec.ts`、`jwt.strategy.spec.ts`、`migration-management.spec.ts`：保持锁语义，增加全局基线故障及迁移登记检查。
- 调整实体/依赖注册的既有 harness：`common/authz/access.guard.http.spec.ts`、`modules/role/role-assignment.spec.ts`、`modules/content/content.controller.spec.ts`、`modules/movie/movie.controller.spec.ts`、`modules/novel/novel.controller.spec.ts`、`modules/comic/comic.controller.spec.ts`、`modules/user/password-hash-exposure.spec.ts`、`modules/audit/audit.service.spec.ts`。
- `app.module.preview.spec.ts`、`common/authz/route-access.spec.ts` 通过保留配置模块导出的 Jest mock，仅强制测试中的 `ConfigModule.forRoot` 使用 `ignoreEnvFile: true`，防止静态导入 AppModule 读取本机真实 `.env`；生产 AppModule 未改。

测试结果（均使用指定缓存 Node 22.23.3；Jest `--runInBand`）：

1. 先红：`auth.security.spec.ts -t '普通缓存全部丢失'`，2 failed；都是撤销后旧 access 返回 200。
2. 接入后定向测试：4 suites / 43 tests passed（其余 80 项因 `-t` 未选择，不是修改跳过）。
3. 完整相关测试：16 suites / 1249 tests passed，114.5 秒，未 skip。
4. 最后补充迁移登记/全局基线故障及 SQL 标识符引用后：3 suites / 45 tests passed。
5. `tsc --noEmit --incremental false` 通过。
6. 补齐 `common/testing/http-harness.ts` 和 `collect-progress.spec.ts` 的撤销实体/服务及黑名单夹具接线：21 个使用通用 harness 的套件共 572 项相关测试已覆盖，其余 20 套件首轮通过，采集 SSE 修正旧缓存注入后 12/12 复测通过。
7. `backend/scripts/test-migrations.cjs` 的精确迁移/表数断言同步更新，新增真实数据库验收代码（永久基线、过期清理、多连接单调写入、存储错误和密码事务回滚）。仅 Node 22 `--check` 通过，未执行该脚本或连接数据库；最终迁移总数需随第 12/13 项一起核对。

人工实施事项：

- 安排维护窗口，备份并停止全部旧 backend 写入/签发，再执行新迁移和迁移检查，随后以新版本启动。不要让旧版本在全局基线建立后继续签发或撤销令牌；必须告知全员重新登录。
- 本次没有迁移或读取已有 Redis/数据库。全局基线是保守地撤销全部旧会话，不自动猜测或拷贝旧缓存内容。
- 不得删除全局基线、回滚至仍读取 Redis 的旧认证实现，或单独恢复过时撤销表；这些操作可能重新放行旧 JWT。新迁移 `down()` 明确拒绝删除表。若确需降级/恢复，先停写，人工制定全量令牌失效与凭据轮换方案。
- 尚未做真实 MySQL/MariaDB 迁移、多进程/多连接并发、生产负载或恢复验收；SQLite 实际行为和 SQL/迁移单测不能代替这些验收。

### 3. 本人改密覆盖管理员刚完成的重置 — 已修

- 确认成立：本人请求验证旧哈希后，最终只按用户 ID 更新；管理员路径没有参与本人改密锁。
- `AuthService.changePassword` 将已验证的旧哈希传给 `UserService.updatePassword`；同一事务内按 ID、旧哈希、未删除状态条件更新，要求 `affected === 1`。不匹配返回 409，不写新的撤销标记，不覆盖管理员新口令。
- 新增 `auth.security.spec.ts` 确定性交错：本人已验证旧密码后先完成管理员重置，再恢复本人更新。先红 1 failed（期望 409，实际 200）；修后本人返回 409、管理员新密码登录成功、在途本人拟设密码登录失败、旧 access/refresh 均拒绝。
- 核心定向回归 3 tests passed，覆盖冲突、正常改密及撤销写失败回滚；完整改密行为组再次运行 30 tests passed（其余 69 项因 `-t` 未选择）；最终 backend tsc 再次通过。
- 本项没有数据库结构或既有数据变更，无需单独人工数据迁移。

### 4. 自动备份未停写 — 部分修复（补丁待应用）

报告成立。现有后端没有请求排空机制，直接自动停止容器会打断媒体文件与数据库的两步写入。因此最小安全补丁要求 backend 已停止，否则在创建备份暂存目录、导出 SQL/文件前拒绝；不自行中断业务。`scripts/backup.sh` 写入同样被沙箱拒绝，补丁保存在 `docs/review-fixes-pending.patch`，当前实际脚本仍未改变。

新增 `backend/src/config/backup-quiescence.spec.ts` 两个行为用例，复制真实备份编排脚本到临时目录，替换容器与配置读取，验证 backend 运行时在收集前拒绝、已停止时能继续到收集阶段；不读取真实环境文件、不调用 Docker。新用例及既有备份校验套件 26 项全部受 `spawnSync C:\Program Files\Git\bin\bash.exe EPERM` 阻塞，未取得行为断言执行证据；未跳过或放宽断言，也没有执行真实备份或恢复。

人工需决定维护窗口及排空写入方式（含采集任务和外部数据库/文件写入），停止 backend 后执行备份；旧自动 cron 不具备停写能力。补丁应用后在线 cron 将明确失败，不能宣称仍有每天可恢复的备份。自动停写编排及恢复演练尚未完成。

### 5. 部署失败后遗漏初始化 — 部分修复

报告成立。`backend/scripts/seed-admin.js` 新增 `--bootstrap`：事务内检查 users，只有空表才按显式初始密码创建管理员；非空表只补系统角色，不新建默认账号、不认领旧账号；没有可用管理员时 CLI 失败并要求人工确认。CLI 保持 `--roles-only` 的原有非致命提示行为。

`seed-admin.spec.ts` 新增 3 个场景，其中 2 个修复前失败，修复后全部 20 项通过；随后新增 CLI main 的成功提交、缺管理员回滚拒绝、角色写失败回滚及 roles-only 兼容测试，最终 24/24 通过，dotenv/mysql 入口均为替身。待应用脚本补丁在 migration 检查后、启动服务前每次执行 bootstrap；cron 从 first_deploy 条件中移出，按本项目精确任务去重，保留其他项目的备份任务。`scripts/deploy.sh` 未能写入，生产调用尚未接上。已有卷但迁移未完成仍拒绝部署；非空库不自动运行新迁移，需维护人员按迁移手册恢复。

### 6. CI 部署未绑定检查过的提交 — 部分修复

报告成立。`.github/workflows/deploy.yml` 已传递 `${{ github.sha }}` 给 SSH 步骤；远端获取该 SHA，只允许干净工作区快进，校验 FETCH_HEAD、部署前后 HEAD。保留原流程对旧 `nginx.conf` 的一次性备份及恢复版本文件的兼容迁移；完成该步骤后，服务器领先目标、分叉或仍有本地改动时直接拒绝，不 reset、不强行覆盖其他改动；需要回滚/切换分支时由人工决定。自动部署持有 `backup/.operations.lock` 的 flock。

`deploy-revision.spec.ts` 新增 1 个绑定配置检查和 5 个假 Git 的 Bash 行为场景（成功快进、dirty、错误 fetch、分叉、服务器领先），不运行真实 Git 写操作。静态检查通过，5 个行为场景全部受 Bash 子进程 EPERM 阻塞，不能宣称执行通过。

`README.md` 同步精确提交部署流程说明，移除旧的自动部署直接 `git pull` 表述。

待应用补丁在 `deploy.sh` 加入同一锁、继承 FD 核验及 SHA 检查，`backup-common.sh` 中备份/恢复加入同一锁。当前手工部署和备份脚本仍未落地，因此自动与手动部署的完整互斥未完成；首次应用需要维护窗口避免旧脚本并行运行。Linux 运行环境需有 flock。已用 `git apply --check docs/review-fixes-pending.patch` 验证补丁可应用，仅检查，未应用、未部署。

### 7. 采集替换失败丢失旧播放数据 — 部分修复（业务补丁待应用）

报告成立。`collect-executor.spec.ts` 新增/调整回归后，原树 47 项中 4 项失败、43 项通过，复现主记录残留、缺少超长字段校验和第二集失败破坏旧数据。候选补丁在删除前检查线路名 100 字符、剧集标题 200 字符，单个影片及全部播放数据同事务，提交后才触发封面检测和门户缓存通知。

`collect-executor.service.ts` 的写入被主代理及辅助代理的正常 apply_patch 拒绝，原业务文件未改。实现已加入总待应用补丁。隔离 `.cache/review-fixes-candidate/backend` 仅复制源码/测试配置，依赖指向已有 node_modules，未复制环境文件或密钥；候选核心回归 47/47、tsc 通过，扩展采集 8 套件共 270 项有通过证据。扩展检查首次暴露的通用认证 harness 接线遗漏已经原树修复并复测。原树仍保留这 4 个失败回归，不能把候选结果称作原树通过，也未做真实 MySQL 验收。

### 8. 已发布内容误标为保存草稿 — 部分修复

报告成立。最小修法只改文案：已发布显示“保存修改（立即生效）”，归档显示“保存修改”，新建/草稿保留“保存草稿”，保持原提交与状态语义。`ContentForm.tsx` 已修改；MovieForm、NovelForm、ComicForm 各正常写入一次均被拒绝，对应修复保存在待应用 UI 补丁中。

`frontend/src/pages/save-action.test.tsx` 新增 16 个场景（四类表单 × 创建/草稿/已发布/归档）。原 Vitest 启动 esbuild 报 spawn EPERM，尚未执行断言，不能声称先红后绿；指定 Node 22 的 frontend tsc 通过。

### 9. 小说、漫画目录及相邻章节跨页失效 — 部分修复

报告成立。后端 `novel.service.ts`、`comic.service.ts` 的公开单章新增 `previousChapterId/nextChapterId`（ID 或 null），按同作品、已发布、`chapterNumber/createdAt/id` 稳定排序分别查询一个邻章；数据库内比较时间，保留微秒精度。两类 `*.controller.spec.ts` 在修复前 7 项失败，修复后 232/232 通过，覆盖 51 章、首尾、重复章号、相同时间、微秒、隐藏章节和跨作品隔离，后台和目录响应形状保持不变。

门户 `lib/types.ts` 已补类型；`lib/api.ts` 与两类作品的详情、阅读页共 5 个文件必须同时修改，因 4 个页面写入被拒绝，整体保留为 UI 候选补丁。候选保留目录分页 meta、接入既有 Pagination，第二页的“开始阅读”仍指第 1 章，阅读页消费后端邻章 ID。原页面行为尚未修复。

`portal/tests/fixture.cjs` 新增 51 章分页数据，`portal-regression.test.cjs` 新增两类作品跨页/相邻/直接访问/非法页浏览器场景；正常 Node 测试入口因 `spawn EPERM` 未执行断言，两个 CJS 文件语法检查通过。原树及隔离候选 portal tsc 均通过，不能代替浏览器验收。需在允许写入和创建子进程的环境应用补丁并执行门户回归。

### 10. 播放线路刷新覆盖未保存基本信息 — 部分修复（补丁待应用）

报告成立。MovieForm 的 `[movie, form]` effect 每次刷新都回填，而线路/剧集修改会刷新同一查询。候选用一个 `useRef` 保存已初始化 ID：首次或换记录才初始化，查询记录需与路由 ID 一致；同记录刷新保留编辑，返回新建清空上一记录。与第 8 项按钮文案合并为该文件唯一补丁，原始受限文件没有修改。

新增 `frontend/src/pages/movie-form-state.test.tsx` 4 项用例覆盖同记录保留编辑、换记录、迟到数据和返回新建再打开；正常 Vitest 入口因 esbuild `spawn EPERM` 未执行断言。当前及隔离候选 frontend tsc 均通过，完整 UI 补丁检查通过。需应用补丁后在允许子进程的环境正常运行测试；当前原树仍有该问题。

### 11. 章节并发写入导致父级计数漂移 — 已修

报告成立。`novel.service.ts`、`comic.service.ts` 的章节新增及父级计数现在同事务提交；小说编辑、删除按读取时的 `wordCount` 条件写入，实际影响行数必须为 1，过时请求返回 409。漫画删除同样检查实际行数，避免重复扣减。父聚合失败会回滚章节，缓存通知和审计在提交成功后执行。

两类 `*.controller.spec.ts` 使用真实内存 SQLite 确定性交错和故障注入，新增 7 项、更新 2 项用例，修前 9 失败 / 230 通过，修后 239/239 通过，覆盖并发编辑、编辑后删除、重复删除及新增/编辑/删除的聚合失败回滚。backend tsc 与四文件 diff 检查通过。没有修改请求成功响应或引入数据库列。

人工事项：代码防止后续这几条路径造成新漂移，不自动校准已有数据。维护窗口先只读比较每部作品的存储计数与所有章节（含未发布）的 `COUNT(*)`、小说 `SUM(wordCount)`，审核后决定是否另行修复；不要用 SQL `CHAR_LENGTH(content)` 替换现有 JavaScript UTF-16 字数语义。本次未连接数据库、未执行校准。

### 12. 分类父级双列映射不一致 — 部分修复（原树未登记迁移）

报告成立。新增回归在原树 3 项失败：metadata 仍使用两列、API 创建的子分类读不到 parent 关联、有子分类的父级删除返回 204 而非 409。`category.entity.ts` 正常写入被拒绝，候选将 `parentId` 属性映射到既有 `parent_id varchar(36)`，保留外键；`category.service.ts` 仅更新因此失真的注释。

新增 `1792713601000-CategoryParentColumn.ts`：先核对列/外键结构和全部父级关系，拒绝双列分歧（包括旧列非空而关联列为空）、超长、悬空和环；只在旧列为 null 或两列逐字符相同后删除冗余 `parentId`。不合并、不回填既有数据，保留 `parent_id`。仅大小写不同但数据库视为等价的双列值也拒绝，须人工确认。历史迁移未改，down 禁止自动恢复双列。

新增 `category-parent-column-migration.spec.ts`、`category-metadata.spec.ts`（metadata），修改 `category.http.spec.ts`；候选中同步 `data-source.ts`、`migration-management.spec.ts` 与 `backend/scripts/test-migrations.cjs`。为避免旧实体与删列迁移不兼容，迁移登记及精确 ledger 断言和实体一起保留在数据库补丁，原树仍登记 4 个迁移；完整候选已一起登记 6 个、表数 30。

候选验证 6 套件 / 219 项通过（分类、迁移、内容及 HTTP 授权），tsc 和补丁可应用性检查通过。MySQL CI 脚本新增安全迁移保留关系、冲突零修改和 ORM 外键验证，仅 Node `--check` 通过，未运行或连接数据库。

人工事项：先停写并核对两列，由业务负责人决定真实父级及修复冲突，之后应用完整实体/迁移补丁再运行 migration。DDL 与迁移 ledger 不能视为 MySQL 原子事务；若中断后旧列已删除但未登记，迁移会拒绝自动补记，须核验结构、数据和应用版本后处理。

### 13. 评论分页和查询索引 — 部分修复

报告成立，API 和门户行为已写入原树，索引实体及迁移登记仍待应用补丁。

- 后端修改 `modules/comment/comment.service.ts`、`comment.controller.ts`，新增 `dto/query-public-comment-page.dto.ts`。旧 `GET /comments/public` 保留 `json.data` 数组和公开字段，按 `createdAt,id` 稳定排序，最多选 100 条评论组树；完整浏览改用新入口。
- 新 `GET /comments/public/page?contentId=<UUID>&page=1&limit=20[&parentId=<UUID>]` 返回 `json.data = { data, meta }`，默认 20、上限 100，严格校验 UUID 和分页参数。无 parentId 时读根评论，包括父级隐藏/删除后仍公开的孤儿；有 parentId 时只读取同文章已审核父级的直系回复。每项 children 为空，不递归读全部正文；内容可见性和敏感字段白名单保持。
- `portal/components/CommentSection.tsx` 已接入根分页及按需递归展开直系回复，各层独立分页、取消过期请求。发表评论表单和审核语义保持；公开提交后刷新根第一页，标题不把根数误称为总评论数。
- 新增 `1792713602000-PublicCommentThreadIndex.ts`，只创建非唯一索引 `IDX_comments_public_thread(contentId,status,parentId,createdAt,id)`，不修改评论数据；校验列结构，已有同名/等价但未登记索引时拒绝自动采用。`comment.entity.ts` 写入被拒绝，其声明及第 12/13 项登记统一放入候选补丁，最终精确为 6 迁移 / 30 表，原树仍为 4 迁移。

测试：`comment.http.spec.ts` 新增 35 个场景；`comment.controller.spec.ts` 和 `common/authz/route-access.spec.ts` 同步 handler、访问矩阵与门户路径。先红 35 失败 / 74 通过，修后 API/路由相关 4 套件 / 757 项通过。稳定 ID 排序暴露旧定时发布夹具的同秒次序假设，已显式设置较早时间，未放宽结果断言。

新增 `comment-index.spec.ts` 原树先红 1 项；`public-comment-thread-index-migration.spec.ts` 含 14 项迁移测试。候选索引、迁移管理及分类迁移 4 套件 / 72 项通过，tsc 和 MySQL CI 脚本语法检查通过；未运行真实数据库脚本。门户 `fixture.cjs` 与 `portal-regression.test.cjs` 增加 21 根/21 回复、多层展开、按需请求、孤儿及原审核提交流程；CJS 语法和原/候选 portal tsc 通过，正常浏览器测试入口因 `spawn EPERM` 未执行断言。

人工事项：应用完整数据库补丁，完成分类数据核对后再迁移。该索引为过滤和直系回复查询提供结构基础；根孤儿 JOIN、旧接口排序是否使用索引及是否需要第二索引，须真实 MySQL/MariaDB `EXPLAIN` 和数据量验证。本次不声称索引构建锁影响、性能或浏览器交互已验收。

## 统一交付与剩余事项

13 项均确认成立，无“报告不成立”的跳过项。第 2、3、11 项已写入修复；其他项仍有受限文件补丁或人工实施部分。当前工作树不应当作全部修复完成或可直接部署的版本。

`docs/review-fixes-pending.patch` 已合并全部 18 个待应用目标，每个文件只有一份 diff；`git apply --check` 通过。它针对**当前未提交工作树**生成，依赖本次已写入的源码及新增文件，不能单独当作基于 bd46190 的完整修复补丁。未通过修改权限、重命名覆盖等方式绕过沙箱。

待应用文件清单（相对仓库根目录）：

| 编号 | 文件 |
| --- | --- |
| 1、5、6 | `scripts/deploy.sh` |
| 4 | `scripts/backup.sh` |
| 6 | `scripts/backup-common.sh` |
| 7 | `backend/src/modules/collect/collect-executor.service.ts` |
| 8、10 | `frontend/src/pages/Movie/MovieForm.tsx` |
| 8 | `frontend/src/pages/Novel/NovelForm.tsx`、`frontend/src/pages/Comic/ComicForm.tsx` |
| 9 | `portal/lib/api.ts` |
| 9 | `portal/app/novels/[slug]/page.tsx`、`portal/app/novels/[slug]/chapters/[chapterId]/page.tsx` |
| 9 | `portal/app/comics/[slug]/page.tsx`、`portal/app/comics/[slug]/chapters/[chapterId]/page.tsx` |
| 12 | `backend/src/modules/category/entities/category.entity.ts`、`backend/src/modules/category/category.service.ts` |
| 13 | `backend/src/modules/comment/entities/comment.entity.ts` |
| 12、13 | `backend/src/shared/database/data-source.ts`、`backend/src/shared/database/migration-management.spec.ts`、`backend/scripts/test-migrations.cjs` |

上述最后三个文件已写入第 2 项变更，但第 12/13 项的追加登记尚未落地。门户 API 和数据库登记配套文件一并保留在补丁，以免原树出现类型或结构不兼容。分项临时说明和拆分补丁已汇入本文及统一补丁，不作为独立交付。

剩余人工事项：

1. 在允许写入的环境检查并整体应用待应用补丁，重新跑回归；不要只启用第 12/13 项迁移而保留旧实体。
2. 既有数据库升级需停旧 backend 和全部写入、备份并核对迁移；持久撤销迁移使旧会话全部失效，通知全员重新登录，不恢复过时撤销状态或贸然切回旧认证实现。
3. 分类双列冲突和历史章节计数由人工核对、决定后处理，本次未读写任何实际数据库。
4. CI 采用精确 SHA；完成既有旧 nginx 配置备份迁移后，只允许干净工作区快进。远端领先、分叉、其余本地修改及降级由人工处理，不自动 reset 或覆盖。
5. 安排备份停写窗口和写入排空；在线 cron 会被安全拒绝。另需真实备份恢复演练，不能用校验和或本地测试代替。
6. 在允许子进程的环境运行 Bash、Vitest 和门户浏览器用例；在隔离 MySQL/MariaDB QA 库执行迁移/多连接故障验证及 EXPLAIN。当前没有这些运行证据。

## 最终组合验证

指定运行程序：`F:\METU\cms-project\.cache\node22-qa-20261013-212547-f7899a96\node-v22.23.3-win-x64\node.exe`。

已将当前源码与全部 18 个补丁目标组合到 `.cache/review-fixes-validation/candidate`，只复制版本文件、源码、配置和环境示例；排除真实环境及密钥文件，依赖链接已有 node_modules。该副本用于验证，未覆盖受限原文件。

原树与完整候选的 backend、frontend、portal 共 6 次 `tsc --noEmit --incremental false` 全部通过；最后调整数据库异常测试夹具后，两份 backend tsc 再次通过。

两份 backend 均使用正常全量 Jest `--runInBand --silent --json`，没有筛选、跳过或自定义 sequencer；结果均为退出码 1：

| 验证对象 | 套件通过 / 失败 / 总数 | 用例通过 / 失败 / 总数 | pending / todo |
| --- | --- | --- | --- |
| 当前原工作树 | 79 / 7 / 86 | 3517 / 41 / 3558 | 0 / 0 |
| 应用全部补丁的隔离候选 | 83 / 3 / 86 | 3527 / 33 / 3560 | 0 / 0 |

失败分类：

- 两树共有 33 项 Bash 子进程 `EPERM`：`config/backup-scripts.spec.ts` 26 项、`config/backup-quiescence.spec.ts` 2 项、`config/deploy-revision.spec.ts` 5 项。这些行为断言没有成功执行，不计为通过。
- 原树额外 8 项实际回归失败：`collect-executor.spec.ts` 4 项、`category.http.spec.ts` 2 项、`category-metadata.spec.ts` 1 项、`comment-index.spec.ts` 1 项，均对应未能写入的修复。完整候选中这 8 项全部通过。
- 候选比原树多 2 项，是补丁补齐的迁移登记检查；没有通过删除测试来减少失败。

首次组合运行还发现 SQLite 原生异常跨 Jest realm 的断言兼容问题：数据库读写确实拒绝并返回 `SqliteError`，但 `toThrow` 的 Error 身份检查失败。只把三处拒绝断言改为精确匹配 `name: SqliteError`、`code: SQLITE_ERROR` 和完整 `message: no such table: token_revocations`；Promise 仍必须拒绝，生产逻辑未改。用临时排序强制另一 SQLite 套件先执行的复现检查，两树均 2 套件 / 24 项通过，随后再用上述普通全量命令得到最终计数。临时排序只在忽略的 `.cache` 诊断文件中，没有修改项目 runner 配置。

frontend 两个新增 Vitest 文件在启动 esbuild 时 `spawn EPERM`，16 + 4 个场景均未执行断言；门户 `node --test tests/portal-regression.test.cjs` 在启动测试子进程时同样 `EPERM`，未启动 Next 或浏览器。这些结果不能由 tsc 通过替代。

最终静态检查：`git apply --check docs/review-fixes-pending.patch`、`git diff --check`、workflow YAML 解析通过；原树/候选 MySQL QA 脚本及修改的门户 CJS 文件 `node --check` 通过。未运行 MySQL QA 脚本、真实备份、恢复、部署或浏览器验收，未连接真实环境。

本地证据保留在 `.cache/review-fixes-validation/`：

- `actual-jest.json`、`actual-jest.log`：原树完整结果。
- `candidate-jest.json`、`candidate-jest.log`：完整候选结果。
- `actual-sqlite-realm-jest.json`、`candidate-sqlite-realm-jest.json`：异常夹具复现与验证。
- `candidate/`：用于上述验证的隔离源码，不是部署产物。

在允许文件写入及创建子进程的环境，先审核并应用统一补丁，再按以下入口复测。下列命令仅说明后续操作，本次没有在原树执行 `git apply` 写入：

```powershell
# 仓库根目录；必须连同本次所有未提交源码和新增文件一起保留
git apply --check docs/review-fixes-pending.patch
git apply docs/review-fixes-pending.patch

$reviewNode = 'F:\METU\cms-project\.cache\node22-qa-20261013-212547-f7899a96\node-v22.23.3-win-x64\node.exe'
Push-Location backend
& $reviewNode node_modules/jest/bin/jest.js --runInBand
& $reviewNode node_modules/typescript/bin/tsc --noEmit --incremental false
Pop-Location
Push-Location frontend
& $reviewNode node_modules/vitest/vitest.mjs run src/pages/save-action.test.tsx src/pages/movie-form-state.test.tsx
& $reviewNode node_modules/typescript/bin/tsc --noEmit --incremental false
Pop-Location
Push-Location portal
& $reviewNode --test tests/portal-regression.test.cjs
& $reviewNode node_modules/typescript/bin/tsc --noEmit --incremental false
Pop-Location
```

最终分支和 HEAD 保持 `codex/review-fixes-20261023` / `bd461905c055dcb92813d89860a3357d6339185b`；未 commit、push、部署，未读取或修改真实 `.env` 和密钥文件。当前仍有上述落地和验收缺口，本次交付不代表 13 项全部完成。

## 沙箱外复跑结果（2026-10-24）

在 Codex 沙箱外、本机 Windows 11 上执行：`git apply --check` 通过后直接 `git apply docs/review-fixes-pending.patch`（未用 `--3way`），18 个目标文件全部应用；补丁文件已移出仓库，保存在 `F:\METU\review-fixes-pending.patch`，不提交。运行程序为仓库缓存的 Node v22.23.3，Bash 测试使用 Git Bash。

说明：本机 `core.autocrlf=true`，`git apply` 把补丁目标文件写成了 CRLF 工作副本，导致 `jwt.spec.ts`、`registration-deploy-check.spec.ts` 按 `\n` 切分 `scripts/deploy.sh` 的静态断言首轮失败（4 + 1 项）。把这些工作副本的行尾恢复为 LF（与索引内容一致，`git diff` 无内容变化）后复跑全部通过。这不是代码改动，Linux CI 不受影响。

| 套件 | 命令 | 结果 |
| --- | --- | --- |
| backend Jest 全量 | `jest --runInBand` | 86 套件中 85 通过 / 1 失败；3560 用例中 3557 通过 / 3 失败；0 跳过 |
| backend tsc | `tsc --noEmit --incremental false` | 通过 |
| frontend Vitest | `vitest run` | 26 / 26 文件，489 / 489 用例通过（含新增 `save-action.test.tsx`、`movie-form-state.test.tsx`） |
| frontend tsc | `tsc --noEmit --incremental false` | 通过 |
| portal 回归 | `node --test tests/portal-regression.test.cjs` | 18 个场景中 16 通过 / 2 失败 |
| portal tsc | `tsc --noEmit --incremental false` | 通过 |

backend 3 项失败，均在 `config/backup-scripts.spec.ts`，都属于 Windows 环境差异：

- “SHA256 manifest 完全匹配”：Git Bash 的 `sha256sum` 输出 `hash *name`，与 Linux 格式不同（之前已知）。
- “退出时释放自己的备份锁”“已有锁时拒绝进入”：补丁让 `backup-common.sh` 依赖 `flock` 串行化备份与部署，Git Bash 没有 `flock`，脚本按设计报错 `flock is required`。Ubuntu CI 自带 util-linux `flock`。

此前受 EPERM 阻塞的 `backup-quiescence.spec.ts`（2 项）、`deploy-revision.spec.ts`（5 项）及备份校验其余 23 项，沙箱外全部通过。原树中对应未应用修复的 8 项（采集 4、分类 2、分类 metadata 1、评论索引 1）在应用补丁后全部通过。

portal 回归：本机 Playwright 1.63 需要的 headless shell 1243 未安装，改用已安装的 `chromium_headless_shell-1228`（通过 `PORTAL_TEST_BROWSER_EXECUTABLE` 指定）。输出目录放在仓库外的 `F:\METU\portal-test-tmp`，以免默认的 C: 盘临时目录与 F: 盘 `node_modules` 跨盘导致 Next webpack 构建解析失败。本批修复相关场景全部通过：第 50 章后的目录分页与邻章、评论根分页及多层回复按需加载、游客评论审核。失败的 2 项是 development 模式下“resume 经 Next rewrite”“搜索上报经 Next rewrite”，Next 开发错误浮层计数为 2。在 `bd46190`（未含本批修复）的临时 worktree 上用同样方式复跑，这 2 项同样失败（14 通过 / 2 失败），属于既有问题或本机开发模式环境问题，与本批修复无关，未修改。

本轮没有对源码做额外修改，没有跳过测试或放宽断言。没有连接真实数据库、Redis、Docker 或线上环境，也没有执行真实备份、恢复或部署。

## 后续修复（2026-10-25）

### 修改前的根因证据

本轮从 `codex/followups-20261025` / `cc31bd23cc8acbcc03569cc314e2e454906a851e` 的干净工作区开始。以下证据先于代码修改记录；未读取真实环境文件或密钥，未启动 Docker，未写 `.git`。

- 已读取既有沙箱外报告 `F:\METU\portal-test-tmp\portal-regression-i5Bwyb\result.json` 和两个 `development-*-failure.png`：resume 和 search 均显示橙色 **1 Insight**，页面没有可见红色错误框。两个场景的 `pageErrors`、`externalRequests` 均为空；search 的 `consoleErrors` 为空，resume 仅有已允许的 401 资源错误；两者上报均为 204。`development.log` 无编译错误。
- **不是健康 Dev Tools 菜单误匹配，也没有证据支持修改续播/搜索业务代码。** 本地 Next 16.4.0 的 `portal/node_modules/next/dist/compiled/next-devtools/index.js:3037` 对应 source map 中 `src/next-devtools/dev-overlay/components/errors/error-overlay/error-overlay.tsx:52–65,78–90`：build error 单独渲染；runtime errors 与 vulnerability insight 都没有时返回 null；否则 React `Activity` 即使 hidden 仍保留对话框 DOM。
- `index.js:3866,4098` 分别生成 `data-nextjs-dialog` 和 `data-nextjs-error-overlay-nav`。其 source map 原源码为 `components/dialog/dialog.tsx:84–94` 和 `components/errors/error-overlay-nav/error-overlay-nav.tsx:37–60`（均在上述 `src/next-devtools/dev-overlay/` 下）。普通菜单不生成这对元素；错误布局和 `components/vulnerability-insight/vulnerability-insight.tsx:57–95` 都会生成，后者另含 `data-nextjs-vulnerability-insight` 和安全升级说明。
- **两个匹配最符合安全升级 Insight 的隐藏导航和对话框，而不是两个错误。** `dist/server/config-shared.js:192` 默认 `agentUpgrade: 'security'`；`dist/server/lib/router-server.js:173–184` 将服务端公告评估 `kind === 'security'` 送入该 Insight；`dist/lib/upgrade/nudge.js:181–226` 根据公告匹配返回 security。harness 的子进程环境白名单没有传入强制测试 Insight 的变量。浏览器外部请求为空不能排除 Next 服务端的公告查询。
- 已用公开 npm bulk advisory 接口查询版本 `16.4.0 / 16.4.1 / 16.4.3`，返回的三项 Next 公告受影响范围均截止 `16.4.0`：`GHSA-p3m5-59mp-jv5r`、`GHSA-2464-fhr4-w9xw`、`GHSA-673q-mjm6-r5xr`。[Next 官方 2026-10-14 公告](https://nextjs.org/blog/nextjs-security-update-october-14-2026) 指定 `16.4.1` 为修复版本。这证明依赖版本告警有依据，不等于证明本站满足每项漏洞的利用条件。最小修复选择固定 `next@16.4.1`，保留原断言；不设置 CI/关闭 agentUpgrade 来隐藏提示。
- 旧报告未保存 outerHTML，所以具体 DOM 身份仍需新报告直接确认；下面增加仅失败时的诊断。上述源码行号针对修改前已安装的 **16.4.0**，source map 引用的是 `index.js.map` 的 `sources` / `sourcesContent`，不是仓库自有源码。

### 修改、验证结果与 portal 外部复跑

- `portal/tests/portal-regression.test.cjs`：保留原来的两个属性 `count() === 0` 断言，增加 `data-next-badge[data-error="true"]` / `[data-insights-only="true"]` 为零的断言，覆盖折叠的错误/Insight。依据 `index.js:3421` 的 source map `components/devtools-indicator/next-logo.tsx:80–103,438–442`；不只检测 `:visible`，也不把安全 Insight 排除。失败时 `entry.nextDevTools` 保存对话框、导航、badge、计数、vulnerability 标志的 `textContent` 与 `outerHTML` 片段；诊断异常单独记录，原始断言错误仍然抛出。没有删改业务断言、跳过测试或增加 `.skip/todo`。
- `docs/followups-20261025-next.patch`：准备了固定 `next@16.4.1` 的清单和锁文件补丁。锁文件通过隔离目录里的 npm `install next@16.4.1 --save-exact --package-lock-only --ignore-scripts --no-audit --no-fund` 生成，使用空 user/global npm 配置；仅 Next、`@next/env`、8 个配套 SWC 包变化，已有 sharp 满足新要求，无其他依赖升级。
- **落地阻塞**：沙箱对 `portal/package.json` 的普通写入和 `apply_patch` 均报拒绝写入。未尝试改权限、删除重建或提权；已恢复工作区原锁文件，保持清单/锁文件都为 16.4.0。升级候选保存在上述补丁，尚未安装或应用，不能声称两项失败已修复。其余测试诊断修改已直接落地。

本轮可执行检查：

| 检查 | 结果 / 成功标准 |
| --- | --- |
| Node 22.23.3 `--check portal/tests/portal-regression.test.cjs` | 退出 0；修改后的 CJS 语法通过 |
| 在 portal 执行 `node node_modules/typescript/bin/tsc --noEmit --incremental false` | 退出 0；使用当前已安装的 Next 16.4.0，只代表当前树静态检查 |
| `git apply --check docs/followups-20261025-next.patch` | 退出 0；只检查可应用性，没有写 `.git` 或应用补丁 |
| `git diff --check`、行尾及命令语法检查 | 退出 0；三个交付文件保持 LF，5 段 PowerShell 经 Parser 解析、2 段内嵌 JavaScript 经 `vm.Script` 解析通过；只验证语法，未执行数据库操作 |
| 公开 npm bulk advisory 分别查询 next 16.4.0 / 16.4.1 | 前者三项、后者空；这是版本公告查询，不是生产安全验收 |
| 完整 portal 回归 / Next build / 新版本浏览器检查 | 待沙箱外执行；已知子进程 `spawn EPERM`，本轮不重复启动这些受限程序，也没有通过改代码规避限制 |

**待沙箱外执行**（新开 PowerShell；补丁只修改工作区清单和锁文件，不使用 `--index` / `--cached`，不 commit/push）：

```powershell
Set-Location 'F:\METU\cms-project'
git apply --check docs/followups-20261025-next.patch
if ($LASTEXITCODE -ne 0) { throw '补丁检查失败，停止应用' }
git apply docs/followups-20261025-next.patch
if ($LASTEXITCODE -ne 0) { throw '补丁应用失败' }

$reviewNode = 'F:\METU\cms-project\.cache\node22-qa-20261013-212547-f7899a96\node-v22.23.3-win-x64\node.exe'
$env:Path = (Split-Path $reviewNode) + ';' + $env:Path
$env:NODE_OPTIONS = ''
$env:PORTAL_TEST_OUTPUT_DIR = 'F:\METU\portal-test-tmp'
$env:PORTAL_TEST_BROWSER_EXECUTABLE = Join-Path $env:LOCALAPPDATA 'ms-playwright\chromium_headless_shell-1228\chrome-headless-shell-win64\chrome-headless-shell.exe'
Set-Location portal
npm.cmd ci --ignore-scripts --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'portal 依赖安装失败' }
& $reviewNode -p "require('next/package.json').version"
& $reviewNode node_modules/typescript/bin/tsc --noEmit --incremental false
if ($LASTEXITCODE -ne 0) { throw 'portal tsc 失败' }
& $reviewNode --test tests/portal-regression.test.cjs
if ($LASTEXITCODE -ne 0) { throw 'portal 回归失败，请保留报告和日志' }
```

成功标准：实际安装输出 `16.4.1`；tsc 退出 0；原 18 个子场景全部通过，尤其两个 development 上报仍为 204，原错误浮层及新增 badge 断言均为零，`cleanupErrors=[]`。测试复制源文件时排除 `.env*`，Next build/dev/start 都在仓库外的隔离副本运行，因此无需读取 `portal/.env.local`。若仍失败，查看新 `result.json` 的 `nextDevTools` 和原 console/http 字段，不能把 Insight 计数改成允许值。旧证据、当前静态检查与升级后的真实复跑必须分别记录。

### 迁移验证准备（待沙箱外执行）

配置核查：`docker-compose.yml:11–62` 为本地 MySQL 8 / Redis 7，另有可选 Adminer（66–77）；下面只启动 mysql、redis。开发凭据来自该公开 compose 和 `backend/.env.example:16–22`，不是读取真实 `.env`。`backend/src/shared/database/data-source.ts:12–20` 注册六项迁移并只使用显式 `process.env`；`database-options.ts:8–18` 使用 `DB_TYPE`、`DATABASE_HOST/PORT/NAME/USER/PASSWORD`，关闭 synchronize/migrationsRun、事务模式为 `none`。迁移入口不加载 Nest 应用、JWT 或 dotenv，因此不用环境文件。

**现有工程没有 `npm run migration:revert`。** `backend/package.json:18–20` 只有 run/baseline/check，`migration-cli.ts:7–8` 也不支持 revert。以下使用 TypeORM `undoLastMigration()`，即 TypeORM `migration:revert` 的底层操作；每次只撤销最后一条，down 成功才删除历史（`node_modules/typeorm/migration/MigrationExecutor.js:294–328`）。不能伪造迁移记录或删表绕过拒绝。

| 迁移 | up / down 与验收 |
| --- | --- |
| `1792713600000` | 创建 token_revocations，主键 key、expiresAt 索引，插入永久全局撤销基线；down 明确抛错，避免旧 token 重新放行（迁移文件 11–27 行） |
| `1792713601000` | 核对父级双列、外键和数据一致性、孤儿、环后删除旧 parentId，保留 parent_id；down 明确拒绝自动恢复双列（11–56 行） |
| `1792713602000` | 创建 `IDX_comments_public_thread(contentId,status,parentId,createdAt,id)`；down 仅删除此索引，可再 up（8–25 行） |

因此不能要求三项都成功 down/up。下面先在空的隔离库运行到 0000，实测其 down 按设计拒绝；再完成所有 up，回退 2000，实测 1000 拒绝，最后重新 up 2000。不覆盖现有开发库，不删除卷，不连接线上。

```powershell
# 新开 PowerShell；外部先启动本机 Docker Desktop。
Set-Location 'F:\METU\cms-project'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$localDockerEndpoint = docker context inspect desktop-linux --format '{{.Endpoints.docker.Host}}'
if ($LASTEXITCODE -ne 0 -or $localDockerEndpoint -notlike 'npipe://*') { throw '必须先核实本机 Docker Desktop named-pipe context；不要改用远程 context' }
# 显式 env-file 防止 Compose 自动读取根目录真实 .env。
docker --context desktop-linux compose --env-file backend/.env.example -f docker-compose.yml up -d --wait mysql redis
if ($LASTEXITCODE -ne 0) { throw '本地依赖未就绪' }
docker --context desktop-linux exec -e MYSQL_PWD=root123 cms-mysql mysql -uroot -e "CREATE DATABASE cms_migration_verify_20261025 CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; GRANT ALL PRIVILEGES ON cms_migration_verify_20261025.* TO 'cms'@'%';"
if ($LASTEXITCODE -ne 0) { throw '隔离库创建失败；库已存在时请核查，不要覆盖或删除' }

$reviewNode = 'F:\METU\cms-project\.cache\node22-qa-20261013-212547-f7899a96\node-v22.23.3-win-x64\node.exe'
$env:Path = (Split-Path $reviewNode) + ';' + $env:Path
$env:NODE_OPTIONS = ''
$env:NODE_ENV = 'development'
$env:DB_TYPE = 'mysql'
$env:DB_SYNC = 'false'
$env:DATABASE_HOST = '127.0.0.1'
$env:DATABASE_PORT = '3306'
$env:DATABASE_NAME = 'cms_migration_verify_20261025'
$env:DATABASE_USER = 'cms'
$env:DATABASE_PASSWORD = 'cms123'
Set-Location backend
npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'backend build 失败' }
& $reviewNode -e "const a=require('node:assert/strict');const {DATABASE_MIGRATIONS:m}=require('./dist/shared/database/data-source');a.equal(m.length,6);a.deepEqual(m.slice(-3).map(x=>x.name),['PersistentTokenRevocation1792713600000','CategoryParentColumn1792713601000','PublicCommentThreadIndex1792713602000']);console.log('migration build verified');"
if ($LASTEXITCODE -ne 0) { throw '构建产物迁移列表不正确' }
```

本轮发现现有 `backend/dist/shared/database/data-source.js:9–11` 只注册两条旧迁移；上述 build 与六项列表断言不可省略。build 仅编译，不启动 Nest 应用或读取环境文件。

先验证 0000（继续在 backend、使用上面的进程变量）：

```powershell
@'
const assert = require('node:assert/strict');
const { migrationDataSource, DATABASE_MIGRATIONS } = require('./dist/shared/database/data-source');
(async () => {
  const ds = migrationDataSource();
  ds.setOptions({ migrations: DATABASE_MIGRATIONS.slice(0, 4) });
  await ds.initialize();
  try {
    await ds.runMigrations({ transaction: 'none' });
    const history = () => ds.query('SELECT id, timestamp, name FROM migrations ORDER BY id');
    const tokens = () => ds.query('SELECT * FROM token_revocations ORDER BY `key`');
    const before = await history();
    const beforeTokens = await tokens();
    assert.equal(before.at(-1).name, 'PersistentTokenRevocation1792713600000');
    assert.equal(beforeTokens.length, 1);
    assert.equal(beforeTokens[0].key, 'auth:valid-after:global');
    assert.equal(beforeTokens[0].expiresAt, null);
    await assert.rejects(ds.undoLastMigration({ transaction: 'none' }), {
      message: '撤销状态禁止自动删除或回滚；会重新放行旧 token，请停写并人工制定凭据轮换方案。',
    });
    assert.deepEqual(await history(), before);
    assert.deepEqual(await tokens(), beforeTokens);
    console.log('0000 up 成功；down 按设计拒绝，历史和撤销状态不变。');
  } finally { await ds.destroy(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
'@ | & $reviewNode -
if ($LASTEXITCODE -ne 0) { throw '0000 验证失败' }
npm.cmd run migration:run
if ($LASTEXITCODE -ne 0) { throw '剩余迁移 up 失败' }
npm.cmd run migration:check
if ($LASTEXITCODE -ne 0) { throw '迁移历史检查失败' }
```

再逐项 down / up（1000 拒绝后最后一条仍是 1000，再调用 revert 也不会退到 0000）：

```powershell
@'
const assert = require('node:assert/strict');
const { migrationDataSource } = require('./dist/shared/database/data-source');
(async () => {
  const ds = migrationDataSource();
  await ds.initialize();
  try {
    const history = () => ds.query('SELECT id, timestamp, name FROM migrations ORDER BY id');
    const index = () => ds.query("SHOW INDEX FROM comments WHERE Key_name = 'IDX_comments_public_thread'");
    assert.equal((await history()).at(-1).name, 'PublicCommentThreadIndex1792713602000');
    assert.deepEqual((await index()).sort((a, b) => a.Seq_in_index - b.Seq_in_index).map(row => row.Column_name),
      ['contentId', 'status', 'parentId', 'createdAt', 'id']);
    await ds.undoLastMigration({ transaction: 'none' });
    assert.equal((await index()).length, 0);
    const before = await history();
    assert.equal(before.at(-1).name, 'CategoryParentColumn1792713601000');
    const columns = () => ds.query('SHOW COLUMNS FROM categories');
    const beforeColumns = await columns();
    assert.ok(beforeColumns.some(column => column.Field === 'parent_id'));
    assert.ok(!beforeColumns.some(column => column.Field === 'parentId'));
    await assert.rejects(ds.undoLastMigration({ transaction: 'none' }), {
      message: '分类父级迁移不自动回滚双列；请停写并人工制定结构与应用版本的恢复方案。',
    });
    assert.deepEqual(await history(), before);
    assert.deepEqual(await columns(), beforeColumns);
    console.log('2000 down 成功；1000 down 按设计拒绝，历史和分类列不变。');
  } finally { await ds.destroy(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
'@ | & $reviewNode -
if ($LASTEXITCODE -ne 0) { throw '2000/1000 回滚验证失败' }
npm.cmd run migration:run
if ($LASTEXITCODE -ne 0) { throw '2000 重新 up 失败' }
npm.cmd run migration:check
if ($LASTEXITCODE -ne 0) { throw '迁移历史检查失败' }
npm.cmd run migration:run
if ($LASTEXITCODE -ne 0) { throw '重复 migration:run 失败' }
docker --context desktop-linux exec -e MYSQL_PWD=cms123 cms-mysql mysql -ucms cms_migration_verify_20261025 -e "SELECT id,timestamp,name FROM migrations ORDER BY id; SHOW CREATE TABLE token_revocations; SELECT * FROM token_revocations; SHOW CREATE TABLE categories; SHOW INDEX FROM comments WHERE Key_name='IDX_comments_public_thread';"
if ($LASTEXITCODE -ne 0) { throw '迁移结构检查失败' }
```

通过标准：所有命令退出 0（两个预期拒绝由 `assert.rejects` 验证）；六条历史完整、末三项顺序为 0000/1000/2000；撤销基线为毫秒时间戳且 expiresAt 为 NULL；categories 只有 parent_id 父列并保留原自引用外键；索引五列顺序正确、down 后消失、重新 up 后恢复；最后一次 run 输出“无待执行迁移”。本方案覆盖空库及回滚保护，不代表已有业务数据迁移验收。

### 公开评论分页 EXPLAIN（待沙箱外执行）

SQL 取自 `backend/src/modules/comment/comment.service.ts:193–220`，默认 limit=20（30–32 行），先核查内容已发布（201–203、347–351 行）。以下为评论查询的等价 SQL，page=1；第 2 页将 OFFSET 改为 20。根查询必须保留 LEFT JOIN + `parent.id IS NULL`，不能改成 `comment.parentId IS NULL`，否则会漏掉应作为根显示的已审核孤儿/隐藏父级子评论。join 下的去重计数来自 TypeORM `SelectQueryBuilder.js:1671–1699,1738`。

在上述**隔离测试库**准备有代表性的合成内容、父评论和回复，把示例 UUID 替换为实际存在的已发布内容及已审核父评论 ID。通过本机容器客户端进入测试库执行下面 SQL：

```powershell
docker --context desktop-linux exec -it -e MYSQL_PWD=cms123 cms-mysql mysql -ucms cms_migration_verify_20261025
```

```sql
ANALYZE TABLE comments;

-- 根评论。
EXPLAIN
SELECT `comment`.id, `comment`.contentId, `comment`.userId, `comment`.guestName,
       `comment`.body, `comment`.status, `comment`.parentId, `comment`.createdAt
FROM comments AS `comment`
LEFT JOIN comments AS `parent`
  ON `parent`.id = `comment`.parentId AND `parent`.contentId = `comment`.contentId
 AND `parent`.status = 'approved'
WHERE `comment`.contentId = '11111111-1111-4111-8111-111111111111'
  AND `comment`.status = 'approved' AND `parent`.id IS NULL
ORDER BY `comment`.createdAt ASC, `comment`.id ASC
LIMIT 20 OFFSET 0;

-- 直接回复。
EXPLAIN
SELECT `comment`.id, `comment`.contentId, `comment`.userId, `comment`.guestName,
       `comment`.body, `comment`.status, `comment`.parentId, `comment`.createdAt
FROM comments AS `comment`
INNER JOIN comments AS `parent`
  ON `parent`.id = `comment`.parentId AND `parent`.contentId = `comment`.contentId
 AND `parent`.status = 'approved'
WHERE `comment`.contentId = '11111111-1111-4111-8111-111111111111'
  AND `comment`.status = 'approved'
  AND `comment`.parentId = '22222222-2222-4222-8222-222222222222'
ORDER BY `comment`.createdAt ASC, `comment`.id ASC
LIMIT 20 OFFSET 0;

-- 根评论计数。
EXPLAIN
SELECT COUNT(DISTINCT `comment`.id) AS cnt
FROM comments AS `comment`
LEFT JOIN comments AS `parent`
  ON `parent`.id = `comment`.parentId AND `parent`.contentId = `comment`.contentId
 AND `parent`.status = 'approved'
WHERE `comment`.contentId = '11111111-1111-4111-8111-111111111111'
  AND `comment`.status = 'approved' AND `parent`.id IS NULL;

-- 回复计数。
EXPLAIN
SELECT COUNT(DISTINCT `comment`.id) AS cnt
FROM comments AS `comment`
INNER JOIN comments AS `parent`
  ON `parent`.id = `comment`.parentId AND `parent`.contentId = `comment`.contentId
 AND `parent`.status = 'approved'
WHERE `comment`.contentId = '11111111-1111-4111-8111-111111111111'
  AND `comment`.status = 'approved'
  AND `comment`.parentId = '22222222-2222-4222-8222-222222222222';
```

执行计划验收：保存四条原样 EXPLAIN，检查 comment 的实际 `key` 是否为 `IDX_comments_public_thread`，不能只看 possible_keys；parent 通常使用主键。回复固定索引前三列，后两列支持排序；根查询只固定前两列，可能仍有 `Using filesort`，不能要求其消失。空表、不存在的父级导致 `Impossible WHERE` 或小表扫描都不能当作索引使用通过；不使用 FORCE INDEX。若代表性数据下未选新索引，保留计划、行数和统计信息继续分析。

本轮只完成源码核查及命令准备，未执行上述 Docker、迁移、数据库 SQL、Next build 或浏览器流程；未部署、连接线上、读真实环境文件或密钥，也未 commit/push。

### 真实 MySQL 迁移验证发现

根因已核实：外部在全新 MySQL 8.0 上复现的 `varchar(255)` / `length: ''` 与本地 TypeORM 0.3.31 源码一致。`MysqlDriver.js:209` 定义 varchar 默认长度 255，`MysqlQueryRunner.js:1718–1721` 读取默认长度时将其归一化为空字符串；MySQL/MariaDB 共用此驱动。原有 1000/2000 迁移直接比较 `'255'`，因此误拒绝符合冻结基线的结构；原 spec 仅模拟显式 `'255'`，未覆盖驱动表示。

修改与逐项成功标准：

- `1792713601000-CategoryParentColumn`：仅在 varchar 长度比较中把精确的 `''` 视为 `'255'`。成功标准是旧 `parentId` 的默认长度表示能继续数据检查并执行原 DROP COLUMN；`'100'`、`'36'`、错误类型仍在任何数据查询或 DDL 前拒绝；`parent_id(36)` 不接受空长度。外键、可空性、父关系校验及拒绝自动 down 均不变。
- `1792713602000-PublicCommentThreadIndex`：采用相同的局部长度归一化，不新增辅助文件。成功标准是 `contentId` / `parentId` 分别或同时报告空长度时创建原五列索引；`'100'`、`'36'`、错误类型仍拒绝，`status(20)` / `id(36)` 不接受空长度。时间精度、重复索引守卫、DDL 及 down 行为不变。
- 两个现有迁移 spec 沿用 Table / QueryRunner 夹具，补充上述成功与拒绝场景。先加用例、未改迁移时：4 个空长度用例失败、48 个通过；修复后连同 persistent-token-revocation、migration-management 两个 spec，共 4 套、89 个测试通过。成功标准包含非法结构不产生查询或 DDL，不能只验证正常路径。
- 已排查 `1792713600000-PersistentTokenRevocation`、`schema-baseline.ts`、`migration-state.ts` 及其余迁移校验：未发现其他同类列长度比较。0000 只检查表是否存在并执行固定 DDL；baseline 比较 `SHOW CREATE TABLE` 与冻结 SQL；migration-state 检查迁移历史。这些文件无需修改。

本轮沙箱内实际验证（在 `backend/` 执行）：

```powershell
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/shared/database/category-parent-column-migration.spec.ts src/shared/database/public-comment-thread-index-migration.spec.ts src/shared/database/persistent-token-revocation-migration.spec.ts src/shared/database/migration-management.spec.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false -p tsconfig.json
```

两条命令均退出 0，本轮未遇到 `spawn EPERM`，未跳过测试或放宽检查。以上为模拟元数据的单元测试及类型检查，不代表真实数据库验收。

外部成功标准（待沙箱外复跑）：上述相关 Jest spec 通过；重新构建后，在全新本地 MySQL 8.0 空库按 `DATABASE_MIGRATIONS` 顺序执行六条迁移全部成功；`1792713602000` down 后索引消失、up 后原五列索引恢复；使用上节代表性数据与原样查询，EXPLAIN 的实际 `key` 使用 `IDX_comments_public_thread`，不能以 `possible_keys`、空表结果或 FORCE INDEX 替代。本轮未连接 MySQL/MariaDB，六条迁移、真实 down/up 和 EXPLAIN 尚未验证；未运行迁移 CLI、部署、连接线上、读取真实环境文件或密钥，也未 commit/push。

### 沙箱外落地与复跑结果（2026-10-25）

在 Codex 沙箱外、本机 Windows 11 上执行，Node v22.23.3。

**portal**：`git apply` 应用了上文的 `docs/followups-20261025-next.patch`（应用后补丁文件已删除，不提交），然后 `npm ci --ignore-scripts`，确认装上的是 `next@16.4.1`。回归 18 项全部通过，原来失败的两个 development 场景也通过了：原浮层断言、新增的 badge 断言都为 0，上报都是 204。portal tsc 通过。只升级 Next、不改业务代码就修好了，说明 16.4.0 下那 2 个匹配元素来自 Next dev tools 针对 16.4.0 安全公告给出的升级 Insight，不是产品缺陷。这次升级本身也修复了 [2026-10-14 官方公告](https://nextjs.org/blog/nextjs-security-update-october-14-2026) 中的 3 个漏洞。上文“落地阻塞”的说法到这里作废。

**真实 MySQL 迁移验证**：为了不覆盖已有的 `cms_mysql_data` 开发卷，没有使用 compose，而是另起一个临时容器 `mysql:8.0`。参数与 `docker-compose.yml` 相同（utf8mb4、STRICT_TRANS_TABLES 等），不挂卷，映射到 127.0.0.1:33306，用完已删除。凭据是 compose 里的公开开发值，没有读取任何 `.env`。

- 修复前：0000 能成功，到 1000 时被前置结构检查拒绝（原因见下一节），2000 根本没跑到。
- 修复后，在全新的空库上依次验证：
  - 先只迁到 0000：`token_revocations` 写入全局撤销基线（`expiresAt` 为 NULL）。对 0000 执行 down，按设计被拒绝。
  - 再执行剩余迁移：1000 和 2000 都成功，6 条迁移记录完整，`categories` 只剩 `parent_id`。`IDX_comments_public_thread` 的列顺序是 `(contentId,status,parentId,createdAt,id)`。
  - 对 2000 执行 down，索引消失；接着对 1000 执行 down，按设计被拒绝，迁移记录不变；再 up 2000，索引恢复。再跑一次迁移，结果是 0 条待执行。
- EXPLAIN：先写入 2 万条合成评论（50 篇内容，每篇约 1/3 是回复，1/5 是 pending），执行 `ANALYZE TABLE`，再对第 2 页（`LIMIT 20 OFFSET 20`）做 EXPLAIN，comment 表实际使用的 key 都是 `IDX_comments_public_thread`：
  - 根评论分页：`ref=const,const`、rows≈400、`Using filesort`（只固定了前两列，符合上文预期）。parent 走 PRIMARY，`Not exists`。
  - 直接回复分页：`ref=const,const,const`、rows=1、`Using index condition`，不需要 filesort。
  - 根评论计数和回复计数：都是 `Using index`，即覆盖索引。

| 套件 | 修改前（cc31bd2） | 修改后 |
| --- | --- | --- |
| backend Jest | 3557 / 3560 | 3572 / 3575（新增 15 项迁移用例，仍是 `backup-scripts.spec.ts` 的 3 项 Windows 环境失败：`sha256sum` 输出格式、没有 `flock`） |
| backend tsc | 通过 | 通过 |
| frontend Vitest | 489 / 489 | 489 / 489 |
| frontend tsc | 通过 | 通过 |
| portal 回归 | 16 / 18 | 18 / 18 |
| portal tsc | 通过 | 通过 |

没有部署，没有连接线上环境或真实数据库，没有 push。