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