# CMS 项目维护计划（2026-08-26）

> 输入：58 条经对抗性验证确认成立的维护问题。本计划做了去重（若干条描述的是同一缺陷）、按"能一起改、一起测、一起提交"重新编组，并标出本轮应当跳过的项。

---

## 执行进度

最后更新：2026-10-08

### 批次 0 —— 已完成 ✅

| 提交 | 内容 | 验证 |
|---|---|---|
| `17ce53f` | `.gitignore` 行内注释导致 `.env.prod` 未被忽略（含真实密钥，仓库为 PUBLIC）；顺带补上 `backup/`、`scripts/renew-ssl.sh` | `git check-ignore -v` 逐项确认；确认该文件从未进入历史 |
| `3c08131` | portal 构建失败：删除 `PlayClient.tsx` 三个重复的局部 interface，改用 `@/lib/types` | `tsc --noEmit` EXIT=0（原 2）；`npm run build` EXIT=0，16 路由全出 |
| `17c5522` | 启用 Express `trust proxy`，恢复按 IP 限流 | `npm run build` EXIT=0 |
| `ed214ca` | 生产不再挂载开发用 initdb 脚本（硬编码 `cms_dev`，生产库为 `cms_prod`） | compose 解析确认挂载已移除，开发端未受影响 |
| `498e102` | 新增三端构建门禁，`deploy` 改为 `needs: verify`；无 secrets 时优雅跳过 | CI 首次全绿 |
| `634b0e5` | actions 升 v7，消除 Node 20 弃用告警 | CI 全绿且零 annotation |

**结果**：项目恢复可部署。CI 自 2026-05-07 建立以来第一次通过。

### 批次 0 未完成项 —— 需在服务器上操作

- **`DB_SYNC=true` + 零 migration**（本文档第三节）。这是唯一"什么都不做也会出事"的项，
  但修复顺序不能反：必须先备份、先取证当前 schema、先手工补列，最后才关 `DB_SYNC`。
  直接改成 `false` 重启会让影视模块与续播功能立刻 500。
  当前本地 `.env.prod` 的 `DOMAIN=http://localhost`，且 GitHub 未配置任何部署 secret
  （`gh secret list` 为空），即目前不存在真实生产环境 —— 此项在真正上线前必须先解决。

### 批次 1 —— 进行中

| 提交 | 内容 | 验证 |
|---|---|---|
| `0485f75` | **1-A** 统一黑名单 key（sha256）、三处 TTL 改毫秒、Redis 换 Keyv 适配器 | 实测往返：logout 后校验命中、未注销 token 不误伤；旧 TTL 写法 1.1 秒即过期 |
| `11f1b6a` | **1-B** watch-history 改 Passport 可选守卫 + DTO 改 class | 实测 ValidationPipe：真实 payload 放行，6 类脏数据全部 400 |
| `5dabf5c` | **限流三修** ttl 单位、SSR 豁免、getTracker 防伪造 | 实测四种请求形态 + tracker 取值全 PASS |

**审计计划中一条会造成生产事故的建议已被拦下**：计划 1-B 第 3 点建议「顺带把
`RATE_LIMIT_TTL` 改成 60000」。直接照做会打挂全站 —— portal 的 SSR 用
`BACKEND_INTERNAL_URL` 直连 `backend:3001` 绕过 nginx，这些请求源 IP 恒为 portal
容器地址，全站页面渲染共用一个桶；窗口一旦变成真正的 60 秒，每页 2~4 次 API 调用，
全站每分钟几十次访问就会开始 429。已改为「先加 SSR 豁免，再改单位」。

**真实环境验证（2026-10-08 补齐，见下方端到端实测）**
- 1-A：Redis 黑名单生效。注意 Keyv 会给键加命名空间，`redis-cli KEYS 'blacklist:*'` 恒为空，
  正确命令是 `redis-cli -a "$REDIS_PASSWORD" --no-auth-warning --scan --pattern '*blacklist:*'`
  （实际键形如 `keyv::keyv:blacklist:token:<sha256>`）；注销后旧 token 返回 401「Token已被注销」
- 1-B：游客与登录用户真实上报均 2xx；夹带 `userId` 字段返回 400
- 限流：经 nginx 的 150 次 SSR 页面请求全部 200（SSR 豁免生效）；外部 API 第 101 次起后端返回 429

### 批次 1-C / 1-D / 1-E —— 已完成 ✅（2026-10-08，本地 24 个提交）

| 提交 | 内容 |
|---|---|
| `d97a00c` | **1-C** 关闭 Next 图片优化器（`/_next/image` 不再是公网抓取代理）、删死 rewrite、`poweredByHeader: false`、Dockerfile 修 clone 后缺 `public/` 导致镜像构建失败 |
| `a54658b` | **1-C** next 14.2.5 → 14.2.35（advisory 35→23，critical 3→2；剩余 critical 之一是图片优化器 AVIF RCE，已由上一条缓解） |
| `eea7e8d` `93806fe` | **1-D** multer 2.4.0 去重为单份、limits 在解析阶段生效且走配置（≤11MiB 与 nginx 12M 耦合）、按 code 映射 multer 错误（2.4.0 改文案导致 500）；扩展名改由 mimetype 白名单决定 |
| `af6f527` `8ee91df` | admin 上传前端预检与真实错误展示、批量上传并发上限 3、401 跳转带 `/admin/` 基路径；413 文案只用于文件上传 |
| `24b919e` | seed-admin 幂等创建并分配 admin 角色（此前全新部署的唯一管理员没有任何角色） |
| `b8ecddf` `97ff96e` `4b0d2d8` | **1-E #29** 评论公开接口字段白名单（不再泄露游客邮箱/IP）、管理端 8 个接口加 `RolesGuard('admin','editor')`；守卫元数据回归测试；列表缺省分页不再 500 |
| `07cd90b` | CI 增加后端单元测试 |
| `e354b31` | **1-E #53** CORS_ORIGIN 归一化 + 启动日志 |
| `c7a35a9` | **1-E #52** 删除遗留 Postgres 编排 `deploy/`、`database/init.sql`，README 写明唯一生产入口 |
| `8445a02` `a485219` | **1-E nginx** `server_tokens off`、隐藏 X-Powered-By、/api 限流桶（burst 100）与登录严格桶（10r/m）、nginx 自身 429 返回 JSON、/uploads 安全头继承、最小 CSP、`client_max_body_size 12M`、屏蔽 `/_next/image`；拒绝路径含 `\` 或 `#` 的请求（堵登录桶绕过） |
| `56db7b9` `e2a6084` `6f676a0` `1ab2e72` `8999c03` `6cb210e` `17c130c` | **部署流程** nginx 生效配置改为未跟踪的生成物 `nginx/nginx.active.conf`（彻底消除 setup-ssl 改写受跟踪文件导致 git pull 中止）；部署前（桩主机）与部署后（真实网络）两道 `nginx -t`；deploy.sh 自更新 re-exec；CI 部署直接复用 deploy.sh；CI 新增 nginx 配置门禁（两种模式 `nginx -t` + 两份配置镜像校验）；旧 HTTPS 服务器迁移失败自动还原；setup-ssl 续签任务提前安装；**每日备份 cron 此前从未执行**（`backup/` 不存在时 cron 打不开日志重定向目标）已修 |
| `323ef9c` `9aa35b9` | 限流配置按数值读取（此前字符串拼接导致 `Retry-After` ≈ 570 万年）、窗口上下限校验 |

**验证方式**

- 每个提交由实现代理跑完门禁才提交（三端构建、后端 48 个单测、portal standalone 实测 404、multer 运行时矩阵、
  nginx 在 Docker 里的真实请求测试）；之后三轮对抗性审查（应用正确性 / 部署与 nginx / 安全绕过）+ 两轮复审。
- **端到端实测**：克隆仓库，数据卷全部改名 `prism_verify_*`、只发布 `127.0.0.1:39080`，用仓库自己的
  `scripts/deploy.sh` 完成首次部署与二次部署，22 项检查通过 20 项；未通过的两项（评论列表缺省分页 500、
  `Retry-After` 垃圾值）均为本批之前的存量问题，已在 `4b0d2d8`、`323ef9c` 修复并在独立 harness 复测通过。
  实测后环境已复原，用户原有容器/数据卷/镜像前后对比一致。
- 二次部署时 nginx 重建造成的中断约数秒（已在 docs/deploy.md 记录为可接受代价）。

### 批次 1-F —— 下一批：后台接口鉴权收口（审查中发现的存量高危）

审查 1-E 时发现，「只校验登录、不校验角色」不是评论接口独有，而是后台接口的普遍问题；
加上 `POST /auth/register` 对所有人开放，注册即可调用大部分后台 API。**还没有真实生产环境，所以没有现网暴露，
但必须在任何部署之前完成。**

| 严重度 | 问题 |
|---|---|
| 高 | `PUT /site-settings/:key`、`POST /site-settings/batch` **完全没有鉴权**，匿名即可改站名/logo/开关 |
| 高 | `GET /audit-logs` 任何注册用户可读，含全站邮箱、管理员登录 IP，以及管理员改密时写入的 bcrypt 哈希 |
| 高 | 采集源「测试连接」是带回显的 SSRF（可读云元数据/内网服务前 200 字符），注册用户可用，DTO 是 interface 零校验 |
| 高 | 匿名可读草稿：content/movie/novel/comic 公开接口不按发布状态过滤 |
| 中 | collect、advertisements、menus、notices、stats、media 等管理接口同样只挂 `AuthGuard('jwt')` |
| 中 | 登录限流后端侧失效：`@Throttle` ttl 按秒写、方法级 ThrottlerGuard 与全局重复计数、`login_attempts` 用可伪造的 XFF 最左值；生产暂由 nginx 登录桶兜住 |
| 中 | `role.service.ts` 角色分配是 Postgres 语法（MySQL 上报错）；`enable_register` 开关后端从未执行 |
| 低 | 登录响应与 JWT 里没有 roles（Dashboard 显示不出角色）；评论 `isRegistered`/`ipAddress` 可由客户端自报 |

#### 清点结果（2026-10-08，7 个只读代理逐个 controller 清点 + 汇总）

全量 **143 条路由**：29 条完全无守卫，85 条只校验登录不校验角色。逐条的现状与目标访问级别见
[`docs/access-matrix.md`](access-matrix.md)（目标态：admin 45 / staff:admin,editor 61 / optional-auth 12 /
public-filtered 8 / public 6 / authenticated 3 / 删除 8）。共发现 67 个问题（critical 3、high 19、medium 18、low 27），
除上表外，清点新增的最严重几条：

| 严重度 | 问题 |
|---|---|
| critical | `GET /media`、`/media/:id` join 完整上传者实体，**bcrypt 密码哈希与邮箱**对任意登录用户可见；`GET /users*` 用 `{...user}` 展开使 `@Exclude` 失效 |
| critical | JWT 密钥在配置缺失时回退到仓库里公开的默认值，且启动不报错 —— 可伪造任意用户 token |
| critical | content/movie/novel/comic 的新建/更新 DTO 是 interface（零校验）：可伪造 authorId、直接置为已发布、刷 viewCount、级联写章节 |
| high | refresh token 与 access token 同密钥且不校验类型，refresh 可当 access 用；logout/改密不吊销 |
| high | 后台存储型 XSS：菜单 url 不限协议，`javascript:` 链接在 admin 列表可点，token 存 localStorage |
| high | 角色分配前后端路由不一致（前端调 `/users/:id/roles`，后端是 `/assign-roles`）且 SQL 是 Postgres 语法 —— 角色分配功能完全不可用 |
| medium | 改密接口对所有人都 500（前后端字段名不一致），部署文档要求的「首登改默认密码」做不到 |
| medium | `POST /site-settings/batch` 的 DTO 缺校验装饰器，后台「系统配置」保存必然失败 |

#### 决策

- **默认拒绝**：RolesGuard 是 fail-open（无 `@Roles` 即放行），靠人记得挂守卫已被证明不可靠。目标形态是全局 AccessGuard，
  未声明访问级别的路由按仅 admin 处理；分两步落地 —— 先逐方法挂守卫并建立覆盖全部路由的矩阵测试，测试变绿后再翻转为全局守卫，
  同一套测试保证前后语义等价。
- **注册**：产品上没有注册的消费方（portal 无登录 UI），后端强制执行 `enable_register`、默认关闭；但所有后台接口的角色守卫
  不以「注册已关闭」为前提（纵深防御）。关闭前必须先修好角色分配、补上后台「新建用户」，否则无法再造号。
- **角色模型**：只用基于角色名的 RBAC，固定 admin / editor 两个系统角色；permission 表从未被任何守卫使用，不再每请求查询。
  内容类（content/movie/novel/comic/category/tag/media/comment/notice）给 admin+editor；
  用户/角色/审计/系统配置/采集/菜单/广告/友链给 admin。

#### 拆成三小批，各自实测、各自推送

| 小批 | 范围 | 风险 |
|---|---|---|
| **1-F-1** | 全部写接口与管理接口按矩阵加角色守卫（删除 8 条无消费方的接口，含匿名可写的 `PUT /site-settings/:key`）；密码哈希不出库；JWT 密钥启动校验 + refresh/access 分离；审计日志脱敏与存量清洗；采集 SSRF 拦截内网；登录限流单位/重复计数/IP 取值；角色分配修复；**覆盖全部路由的访问矩阵回归测试** | 低：portal 从不带 token，收紧写权限对门户透明 |
| **1-F-2** | 公开读接口强制只返回已发布、剥离内部字段；content/movie/novel/comic 等 DTO 改 class 校验；评论身份改由服务端填 | 中：与 portal 字段有部署顺序约束 |
| **1-F-3** | 翻转为全局默认拒绝；admin 403 提示与按角色显示菜单；后台「新建用户」；关闭注册 | 中：改动面广，靠矩阵测试保证语义等价 |

### 批次 1-F-1 —— 已完成 ✅（2026-10-09，37 个代码提交 `9951f50`..`ee9470e`）

| 方面 | 结果 |
|---|---|
| 访问控制 | 新增 `Access(level)` 装饰器；`RolesGuard` 改为 fail-closed（无角色元数据即拒绝，原来是放行）。全部 135 条路由按矩阵声明访问级别，删除 8 条无消费方的接口（含匿名可写的 `PUT /site-settings/:key`）。`route-access.spec.ts` 枚举所有 controller（含继承来的 handler），未声明级别、未登记、级别不符、admin 前端调用了不存在或无权的路由都会让 CI 变红 |
| 密码哈希 | `select: false`，用户与所有关联查询只取安全字段；`GET /media` 不再带出上传者的哈希与邮箱 |
| token | 生产环境 JWT 密钥启动校验（缺失/占位符/过短/结构上像按规律生成/已泄露清单），部署前用新镜像里的同一套规则预检，不合格不动任何容器；access 与 refresh 分密钥、分类型；改密、管理员重置密码吊销旧 token；注销黑名单按验签后的 jti；Authorization 头只接受一种写法 |
| 登录防护 | 后端 `@Throttle` 改毫秒并去掉重复计数；IP 取 `req.ip`；失败计数按库里的用户 ID（堵住 unicode_ci 等价写法绕过）；账号级锁定不锁成功登录过的 IP；登录/注册/后台建用户只收 ASCII 邮箱；改密猜当前密码有独立上限 |
| 审计日志 | 写入时脱敏（密码/哈希/token/凭据类键、采集源 URL 只留 host）、截断；列表分页上限 100 且不再返回 old/newValues；附存量清洗脚本 `backend/scripts/scrub-audit-logs.js`（默认预演） |
| 采集 SSRF | 所有出站请求经 `safe-fetch`：只允许公网 http(s)，逐跳校验重定向，拦截回环/私网/链路本地（云元数据）/保留网段，错误不回显响应体 |
| 角色 | 角色分配改 MySQL 语法并与前端路由对齐（此前功能完全不可用）；改角色立即生效（鉴权每请求查库，不再读缓存）；admin/editor 为不可改删的系统角色；`seed-admin.js --roles-only` 只补角色、绝不自动授予 admin |
| 其他 | 后台「系统配置」保存恢复可用；改密接口恢复可用（此前所有人 500）；登录响应带角色；退出登录立即生效；限流提示中文；nginx 健康检查不再恒为 unhealthy |

**验证**：6 个实现代理按序实现，三轮对抗性审查（越权绕过 / 功能回归 / 新代码安全）共发现并修复 19 条问题；
两轮隔离 Docker 端到端实测（用仓库自己的 `deploy.sh` 首次 + 例行部署）：**按路由逐条、5 种身份（匿名、伪造 token、
无角色用户、editor、admin）共 675 次请求，0 处与矩阵不符**；17 项专项检查全部通过。后端单测 1555 个。

**处置了一次密钥泄露**：批次 0 附注曾写出本地 `.env.prod` 两把 JWT 密钥的前缀与生成规律（2026-08-26 进入公开历史）。
已删除该文本、用随机值轮换本地两把密钥（该文件未入库、从未部署到生产），并把整族规律与两把原值的哈希加入启动校验。
已核实 `.env.prod` 其余密钥从未出现在仓库或历史中。

**升级须知**：见 `docs/deploy.md` 5.3 —— 部署本版本前须确认 JWT 密钥是随机值；所有已登录会话需重新登录一次。

**留给 1-F-2 / 1-F-3**：公开读接口过滤草稿与内部字段、content/movie/novel/comic 等 DTO 改 class（当前空 body 会 500）、
评论身份由服务端填写、全局默认拒绝、editor 的后台菜单与「个人资料」保存（目前 editor 改自己资料会 403）、新建用户 UI、关闭注册。

### 批次 1-F-2 —— 已完成 ✅（2026-10-09，39 个提交 `c52e639`..）

| 方面 | 结果 |
|---|---|
| 严格可选登录 | `Access('optional')`：不带凭据按游客；带了但无效（过期、已注销、已吊销）一律 401，后台 token 过期时会跳登录，而不是静默看到游客视图。内容 / 影视 / 小说 / 漫画列表、章节、友链、发评论改挂可选登录 |
| 草稿不再外泄 | 游客与无角色用户：列表强制只看已发布且已到发布时间（定时发布到点才可见）、未删除；详情、章节、漫画页面图、评论都按同一规则；小说 / 漫画的章数、字数、最后更新只按已发布章节计算；出参按白名单（不再有 authorId、采集内部字段等）。后台角色视图不变 |
| 批量赋值 | content/movie/novel/comic 及章节、线路、剧集，category/tag/menu/notice/role/advertisement/friend-link/comment/user 的请求体全部改为 class 校验，服务端逐字段写库；嵌套数组每项必须是对象（此前 `{settings:[[]]}` 会清空第一条站点配置）；新建影视放进事务；编辑用户不再顺带把禁用账号改回启用 |
| XSS 面 | 菜单 / 友链地址只收 http(s) 与站内路径；采集来的剧集地址丢弃危险协议，公开视图只给 http(s) / 站内地址，门户外部播放器链接只渲染 http(s)；海报 / 封面的协议白名单只校验改过的值（采集旧值不再挡住后台编辑） |
| 评论 | 身份与 IP 由服务端决定，评论开关 / 审核开关在后端生效；游客昵称规范化后不能与注册用户重名；门户标出「注册用户 / 游客」 |
| 其他 | 分类 / 菜单成环检查按小写 UUID；公开接口查询参数类型校验（数组 / 对象参数此前会进 SQL）；仪表盘不再返回最近用户邮箱与草稿标题；门户单章缓存缩到 60 秒、单条取数校验键格式 |

**验证**：5 个实现代理按序实现，三路对抗性审查（未发布数据外泄 / 功能回归 / 批量赋值）两轮；MySQL 才能复现的问题
（大小写不敏感排序、undefined 条件匹配首行）都在一次性 MySQL 8 容器里先复现再验证修复。两轮隔离 Docker 端到端实测
（每类内容各造已发布 / 草稿 / 定时 / 未发布章节，匿名与无角色用户在 110 条读接口上一条草稿都拿不到；82 个批量赋值探测；
后台前端全部页面按真实请求体重放；门户 31 个页面冒烟；路由矩阵 5 种身份全量扫描）全部通过。后端单测 2806 个。

**已知**：
- `0d84a43` 单独检出时后端测试不过（门户取数改写后路由扫描找不到调用点），紧随其后的 `ee64113` 修复；不影响 main 的最终状态，二分查找时跳过即可。
- 门户撤回发布后最多再显示约 60 秒，以及「404 也缓存」的落盘问题，正确做法是按标签的按需失效（docs/api.md「附：门户缓存窗口」）。
- 游客昵称与注册用户重名会被拒绝，可借此探测注册用户名（已记入 docs/api.md 的已知取舍）。

### 批次 1-F-3 —— 已完成 ✅（2026-10-09，25 个提交 `cd42e0c`..）

| 方面 | 结果 |
|---|---|
| 全局默认拒绝 | 新增 `AccessGuard` 作为全局守卫（排在限流之后），`Access(level)` 只声明元数据；**没声明访问级别的路由按仅 admin 处理**，以后新加接口忘了写也不会意外公开。翻转前后对 135 条路由 × 6 种身份逐条比对，0 处差异 |
| 后台按角色 | 菜单与页面按角色显示（editor 只看到内容相关菜单，进 admin 页面显示 403 页）；没有后台角色的账号登录后直接拒绝；请求错误保留状态码，4xx 不再重试，403 显示中文原因，列表读取失败显示错误状态而不是空表 |
| 账号 | 新增 `PATCH /auth/me`（只能改昵称与头像），editor 改自己资料不再 403；后台「新建用户」（含角色选择）；**后端执行 `enable_register`，新装默认关闭公开注册**；自助注册与后台建号、改密共用一套口令策略；显示名「一个名字只属于一个账号」（昵称规范化后查重，清空昵称时回落的用户名也查） |
| 修掉的老问题 | 系统配置只改基本设置就保存，会把注册 / 评论 / 审核开关全部写成关闭（标签未打开导致）；改密后同一标签页换账号会串上一个账号的资料；另一个标签页换账号后本页沿用旧账号的菜单与缓存；新建用户的审计把被创建者记成操作人；生产镜像里带着测试文件 |

**验证**：4 个实现代理按序实现，两轮对抗性审查（权限语义等价 / 后台界面回归）；两轮隔离 Docker 端到端实测，
**这一批首次加入无头浏览器**（一次性 Playwright 容器连到隔离栈）：以 editor / admin 真实登录后台，核对菜单、改密后换账号、
存量仿冒昵称账号的停用降权、系统配置保存、新建用户等流程。后端单测 3132 个、前端单测 393 个。

**升级须知**：「默认关闭注册」只对新装生效。已有站点库里 `enable_register` 是 `'true'`，升级后注册仍开着 ——
backend 启动日志和例行部署都会提示，关闭方法见 `docs/deploy.md` 5.3 ⑥（不会自动修改）。

**已知**：`53b58e9`、`c5596e9`、`b6e8b0f` 单独检出时前端有 1 个测试不过（前端测试读取后端提示文案，`7329e2b` 修复），
连同 1-F-2 的 `0d84a43`，二分查找时跳过。

---

### 批次 1 总结（2026-10-08 ~ 10-09）

批次 1 原计划是 1-C/1-D/1-E 三项硬化；动手前的核查与过程中的审查又挖出了后台接口普遍缺鉴权（1-F）。最终：

- **后台接口**：143 条路由逐条确定访问级别，全局默认拒绝；草稿、密码哈希、审计里的凭据、内部字段不再外泄；
  请求体全部校验，杜绝批量赋值；采集出站请求拦截内网；登录防护（限流、锁定、吊销）在后端真正生效。
- **部署**：从 clone 构建镜像不再失败；nginx 配置改动真正生效且部署前后两道校验；每日备份 cron 此前从未执行，已修；
  JWT 密钥启动与部署前双重校验；CI 增加 nginx 门禁与前后端单测。
- **一次密钥泄露的处置**：见 1-F-1。

**仍需你本人处理**：GitHub Support 清理旧提交缓存、联系 `kk778956` 删除 fork（见上文「邮箱暴露处置」）；
本地 `backend/.env` 的 `CORS_ORIGIN` 加上 `http://localhost:3002`（本地开发评论区跨域）。

**转入后续批次的已知项**：门户撤回发布后约 60 秒的缓存窗口（正确做法是按标签的按需失效）；用户编辑 / 删除 / 分配角色等
审计仍记 `system` 而非真实来源；JSON 请求体 100kb 上限导致超长章节保存 413；全局隐式类型转换下不可转字符串的对象返回 500；
`prism_nginx_logs` 卷不持久化日志；helmet 与 nginx 安全头重复；漫画章节上传无并发上限；上传文件不落盘（媒体功能不可用）；
nginx 镜像未锁版本；前端「页面用到的接口」对照表为手写。

### 批次 2 / 3A —— 交叉核查后的修订方案（2026-10-09）

第五节（批次 2）与第六节 3A 原文写于两个月前，动手前用 4 个只读代理（backend / frontend / portal / 构建与 CI）
逐个包对照当前代码核实，并在一次性容器里实测了镜像构建、bcrypt 6、better-sqlite3 预编译包、typeorm 升级后的建表差异。
**以本节为准**，第五、六节原文仅作背景。

**原文照做会出事的两处**

- **前端构建会被打坏**：`echarts-for-react` 的产物 `import` 了 `tslib`，自己却没声明这个依赖，一直靠 Storybook、
  pro-components、react-dropzone 间接装进来。照原文删掉这三者后 `vite build` 报 `Could not resolve "tslib"`（tsc 和 vitest 照样能过）。
  → 先单独提交显式声明 `tslib`，再删。
- **部署会挂在 docker build**：原文的 `npm update` 会把 `better-sqlite3` 从 12.9.0 抬到 12.11.1，而 12.10.0 起的版本
  只有 Node 22 的预编译包，`node:20-alpine` 里没有 python / 编译工具，回落源码编译直接失败；CI 跑在 ubuntu 上照样变绿。
  → `npm update` 之前先 `npm i better-sqlite3@12.9.0 --save-exact`，升 Node 22 之后再解除。

**其他更正**

- backend 零引用的不止原文 6 个：还有 `uuid`（媒体上传已改用 `crypto.randomUUID`）、`passport-local`、`@nestjs/mapped-types`，
  以及只注册了空调度器的 `@nestjs/schedule`（全仓零 `@Cron`；以后要定时任务装 `^6` 即可）。
- `.env.example` 的 PostgreSQL 残留已在 1-E 修过；`dotenv` 只有 `migrate-sqlite-to-mysql.js` 是无保护的 require，声明 `^16.6.1`（不能用 17.x，默认打印注入日志）。
- `database.module.ts` 的 SQLite 分支**从来没跑通过**（`NovelChapter.content` 是 longtext），`DB_TYPE` 白名单只留 mysql / mariadb 并删掉该分支；`better-sqlite3` 仍保留给 12 个测试夹具与迁移脚本。
- `uuid` 那条公告不必等 Nest 11：删 `@nestjs/schedule` + typeorm 升级把 uuid 带到 11.1.1 即清掉。
- 「bcrypt 6 根除唯一 CRITICAL」不准确：backend 有 3 个 critical（tar、handlebars、proxy-addr），`npm update` + bcrypt 6 一起才归零。
  bcrypt 6 的 npm 包自带 musl 预编译，镜像构建不再需要从 github.com 下载；旧哈希、两个方向的回滚、真实 MySQL 登录均已验证。
- `@nestjs/*` 10.x 没有补丁可升（10.4.22 即最后一版）；实际变化是 typeorm 0.3.31（含一条 SQL 注入修复）、mysql2 3.24.5、proxy-addr 2.0.8 等。
- frontend：vitest 现在有 16 个文件 393 个用例，**必须保留**；`@vitest/ui`、`@playwright/test` 与三个本来就坏的测试脚本删除；
  另有 `vite-plugin-pwa`、`vite-plugin-compression` 从未注册；tailwind 与 `react-hot-toast` 在产物里不起作用。axios 目标改为 `^1.20.0`（1.19 仍剩 10 条）。
- portal：next 14.2.35 已在 1-C 完成；postcss 用 `"overrides": {"postcss": "$postcss"}` 统一掉 next 内嵌的 8.4.31（写字面量范围会 EOVERRIDE），生产依赖的 audit 只剩 next 一项。
- 审计门禁不能用 `--audit-level`（next 14 的 critical 没有修复版本，会永远红），改为**按 GHSA 编号登记、带到期日的例外清单**，放在独立 workflow（放进 deploy.yml 的定时触发会真的去部署）。
- npmmirror 陷阱的准确描述：`npm audit` 走 npmmirror 会报错退出；真正不出声的是 `npm install/ci` 不打印漏洞、并把 npmmirror 地址写进 lock（backend 现有 4 条）。

**提交顺序**：docs → backend lock 源修正 → backend 删 9 个零引用依赖并声明 dotenv → 删 database.config 与 SQLite 分支、DB_TYPE 白名单 →
删 `@nestjs/schedule` → 锁 better-sqlite3 后范围内升级 → bcrypt 6 → frontend 先加 tslib → 删 Storybook → 删 react-query v3 →
删 13 个零引用依赖 → 删未接入的 devDependencies 与坏脚本 → 删 tailwind / react-hot-toast → 前端安全补丁 →
portal postcss 与 override → portal 构建期依赖刷新 → 新增依赖审计 workflow 与例外清单、README 说明 → docs 收尾。
每个触及 backend 运行时依赖的提交都要在一次性容器里实际构建生产镜像；bcrypt 6 之后做一次跨版本登录冒烟（旧哈希、回滚）。

**预期**（2026-10-09 公告库）：三端 audit 177 → 约 91，生产依赖 39 → 约 14，critical 10 → 3（剩 vitest/tinypool 在开发依赖、
next 14 在生产但已有缓解）；backend 生产镜像 635MB → 约 403MB。

**本批不做**：NestJS 11、Next 16 / React 19、vite 6 + vitest 4、react-router 7（登记例外）、tailwind 4、Node 22（建议作为下一个独立 PR，
Node 20 已停止维护）、`@nestjs/swagger` 去留（87 个文件在用装饰器但从未挂载文档，需单独决策）、任何 `npm audit fix` / 全量 `npm update`。

**其他已记录、未排期**：JSON 请求体 100kb 上限导致超长章节无法保存（413）；`prism_nginx_logs` 卷里只有指向
stdout 的符号链接，实际不持久化日志；helmet 与 nginx 安全头重复、nginx 的 Referrer-Policy 覆盖了 helmet 的
`no-referrer`；漫画章节上传无并发上限且页序按完成顺序；上传字节不落盘（媒体功能不可用）；frontend 的
`vitest` 无测试文件即失败（CI 测试步骤暂只跑 backend）；nginx 镜像未锁版本。

### 批次 1-C / 1-D / 1-E —— 交叉核查后的修订方案（2026-10-08）

第四节的 1-C/1-D/1-E 原文写于 6 周前，动手前用 5 个领域代理 + 1 个交叉核查代理逐条对照**当前代码**
重新核实（只读，在 scratch 副本里实测构建、audit、运行时）。原文有多处照做会失败或无效，以本节为准。

**原文需要更正的地方**

| 原文 | 实际情况 | 更正 |
|---|---|---|
| 1-D：`overrides: {"multer": "2.2.0"}` | 保留顶层 `^1.4.5` 时 npm 报 `EOVERRIDE`，直接失败；2.2.0 本身仍有 2 条 high | 顶层改 `"multer": "2.4.0"` + `"overrides": {"multer": "$multer"}`，全树去重为一份 |
| 1-D：升级后只需改前端文案 | multer 2.4.0 改了 `LIMIT_UNEXPECTED_FILE` 文案，Nest 10.4.22 按文案匹配 → 字段名错误变 500 | 新增按 `code` 映射的 `MulterExceptionFilter` |
| 1-D：「上传需有效 JWT，不是匿名可打」 | `POST /auth/register` 公开，注册即得 JWT；上传只挂 `AuthGuard('jwt')` | 缓解说法作废，limits 是在为近似匿名的攻击面兜底 |
| 1-C：nginx 改动「不依赖重新构建」 | `nginx.conf` 是单文件 bind mount，`git pull` 换 inode，容器仍读旧文件；`up -d --build` 不重建 nginx | 部署流程新增「一次性容器 `nginx -t` → `force-recreate nginx`」 |
| 1-C：`location /_next/image` 要放在 `location /` 之前 | 前缀 location 取最长匹配，与书写顺序无关 | 改用 `location ^~ /_next/image`，防将来的正则 location 抢先 |
| 1-C：rewrite 可保留 dev-only 版本 | 开发/生产都零消费方 | 整段删除 |
| 3A #9：next 升级「33→21，critical 1→0」 | advisory 库已更新：35→23，critical 3→2；剩余的 `GHSA-2xp9`（图片优化器 AVIF RCE）14.x 不修 | 关掉图片优化器是 14.x 上唯一缓解；next 升级提前到 1-C 一起做 |
| 3A：缓存投毒 `gp8f` 当下可打 | 只影响 Pages Router，本站纯 App Router | 删除该说法 |
| 1-E #29：只改公开接口 | 管理端 `GET /comments` 等 8 个接口只要 JWT 不看角色，自助注册即可拉全表 `guestEmail` | 同时给管理端加 `RolesGuard('admin','editor')` |
| 1-E #50：在 `/uploads/` 里逐条重申安全头 | 删掉那条 `add_header Cache-Control` 即可恢复继承；`expires 7d` 自己会输出 `Cache-Control` | 直接删除 |
| 1-E #51：`burst=20`、`location = /api/v1/auth/login` | admin 媒体库无并发上限上传，30 个文件约 9 个会 429；Express 路由大小写不敏感且容忍尾斜杠，精确匹配可绕过 | api 桶 `burst=100`（对齐后端 100/60s）；登录用 `~* ^/api/v1/auth/(login\|register)/?$`；nginx 自身 429 返回 JSON |
| 1-E #54：先上 CSP Report-Only 跑一周 | 没有 report-uri，Report-Only 只打到访客控制台，无从观察 | 完整 CSP 推迟；本批只上零风险的 `object-src 'none'; base-uri 'self'; frame-ancestors 'self'` |

**核查中新发现、必须同批处理的**

- `portal/public` 不在 git 里，从 clone 构建镜像会在 `COPY --from=builder /app/public` 失败 —— 1-C 的改动根本部署不上去。
- `seed-admin.js` 不分配任何角色，`role.service.ts` 的角色分配又是 Postgres 语法（在 MySQL 上报错）。
  全新部署后唯一的管理员没有 admin 角色：发布内容、用户/角色管理全部 403，加了评论 RolesGuard 后评论管理也会 403。
- 已跑过 `setup-ssl.sh` 的服务器上，`nginx/nginx.conf` 是本地生成物（受 git 跟踪），任何改它的提交都会让部署卡在 `git pull`。
  新增 `scripts/render-nginx-conf.sh`，pull 前还原、pull 后按 HTTP/HTTPS 模式重新生成。
- admin 的 401 跳转写死 `/login`，没带 `/admin/` basename，生产环境输错密码会被带到门户 404。

**提交顺序**

| # | 提交 | 要点 |
|---|---|---|
| C1 | `fix(portal)` 关闭图片优化器、删 rewrite、修 clone 后镜像构建缺 public | `images.unoptimized`、`poweredByHeader: false`、Dockerfile `mkdir -p public` |
| C2 | `chore(portal)` next 14.2.5 → 14.2.35 | 官方源，lock 一并提交 |
| C3 | `fix(media)` multer 2.4.0 去重、limits 走配置、按 code 映射错误 | 启动期校验上限 ≤ 11MiB，与 nginx 12M 耦合 |
| C4 | `fix(media)` 扩展名改由 mimetype 白名单决定 | 防将来补上落盘后的同源存储型 XSS |
| C5 | `fix(admin)` 上传前端预检、展示后端错误、401 跳转带 basename | |
| C6 | `fix(seed)` seed-admin 幂等创建并分配 admin 角色 | C7 的前置 |
| C7 | `fix(api)` 评论公开接口字段白名单 + 管理端角色校验 | 附回归测试 |
| C8 | `fix(api)` CORS_ORIGIN 归一化 + 启动日志 | |
| C9 | `chore` 删除遗留 Postgres 部署编排 `deploy/`、`database/init.sql` | README 写明唯一生产入口 |
| C10 | `fix(deploy)` nginx 配置按模式生成、部署时校验并重建 nginx | 修正部署文档中的过期描述 |
| C11 | `chore(nginx)` server_tokens、限流、/uploads 头继承、最小 CSP、12M、屏蔽 `/_next/image` | 两份配置归一化 diff 作门禁；推送前须 `nginx -t` |

**推迟到 1-F（紧接本批，不拖到批次 2）**

- **匿名可读草稿**：`GET /contents?status=draft` 及 `/contents/:id`、`/slug/:slug` 不按发布状态过滤，movie/novel/comic 同理。
  修复需 JwtOptionalGuard 按角色过滤，并先改 portal 三处 `(nickname||username).charAt(0)`，有部署顺序要求。
- content 等公开接口的字段白名单（`authorId` 等），与上一条合并成「公开读 / 后台读分离」。
- 登录限流实际失效：`auth.controller.ts` 三处 `@Throttle` 的 ttl 仍按秒写（60/300/60，在 throttler v5 下是毫秒），
  且方法级 `ThrottlerGuard` 与全局 APP_GUARD 重复计数；`auth.module` 的 short/medium 两个 throttler 是死配置。
  本批 nginx 登录桶先兜住生产环境。
- `role.service.ts` 的 Postgres 语法改 MySQL；`enable_register` 开关后端从未执行；
  `getClientIp` 取 XFF 最左值导致审计 IP 可伪造。
- 上传接口的角色收敛（谁能上传）需要产品决定。

**推迟到更后**：完整 CSP；next 15/16 大版本（3B）；setup-ssl 改为生成未跟踪的配置文件；
上传字节实际不落盘（`/uploads/*` 恒 404，媒体功能不可用）属功能缺陷，另立任务。

---

### 邮箱暴露处置 —— 已完成技术侧，剩余两步需人工

**背景**：仓库为 PUBLIC，此前 13 个提交的 author 与 committer 邮箱均为真实 gmail。
根因是本仓库 local 的 `user.email` 覆盖了全局已配置好的 GitHub noreply 邮箱。

**已完成**

| 动作 | 结果 |
|---|---|
| 移除 local `user.email` 覆盖，回落全局 noreply | 此后新提交不再暴露 |
| `git filter-repo --mailmap` 重写全部 20 个提交的 author + committer | HEAD tree 哈希前后一致（`8833bff…`），文件内容一字未改；提交数 20 未变 |
| `git push --force-with-lease` | 远程 20 个提交经 GitHub API 复核，100% 为 noreply |
| CI 复跑 | 重写后的历史上三端构建仍全绿 |

本地备份：`~/prism-pre-email-rewrite.bundle`（627KB，`git bundle verify` 通过，含完整旧历史）。
**该备份不要推送到任何远程**，否则等于把旧邮箱又送回去。

**未完成 —— 只能由仓库所有者操作**

重写**不能**彻底清除。实测证据：force push 之后，从本仓库自己的 URL 仍能取到旧提交并读出 gmail：

```
GET /repos/FUDAHA99/Prism/commits/ad4fc26  ->  fuxiaoha@gmail.com
GET /repos/FUDAHA99/Prism/commits/fad110c  ->  fuxiaoha@gmail.com
```

原因是 GitHub 官方行为：fork 网络内任一仓库持有的提交，可从网络内其他仓库按 SHA 访问；
且旧提交还存在于 GitHub 的缓存视图中。本仓库存在 1 个 fork：`kk778956/Prism`（公开，
2026-04-29 创建）。

因此还需两步：

1. **联系 GitHub Support**（https://support.github.com/contact）请求 GC 与清除缓存视图。
   请求要点：仓库 `FUDAHA99/Prism`，已重写历史移除提交元数据中的私人邮箱，
   请求 run garbage collection 并 dereference 受影响的缓存引用。
2. **联系 fork 所有者 `kk778956`**，请其删除 fork 或同样重写。
   注意：GitHub 文档明确说明，即使 fork 被删除，来自该 fork 的贡献仍可能对仓库网络保持可访问 ——
   所以第 1 步的 GC 请求不能省。

**风险量级判断（避免过度投入）**：该邮箱自 2026-04-27 起公开约 4 个月，仓库有 3 星 1 fork。
GitHub 提交元数据被第三方大规模抓取，实际上应假定该邮箱已被采集。
上述两步是收敛残留可见面，真正有效的是已完成的"阻断未来暴露"。
若判断不值得投入，可只做第 1 步（免费、约 5 分钟）而跳过第 2 步。

**2026-10-08 复查**：`ad4fc26`、`fad110c` 经 API 仍返回 gmail；`kk778956/Prism` 的分支历史仍完整保留该邮箱
（最后推送 2026-05-09），属于对方仓库主动持有，GC 请求清不掉，只能由对方删除或同步 fork。
另有新 fork `aoooeg/Prism`（2026-10-03 创建，晚于历史重写），其历史只含 noreply，无需处理。

---

## 一、现状判定

**这个项目现在不能部署，而且已经有 4 个月不能部署了，只是没人发现。**

三句话概括：

1. **发布链路是断的。** `portal` 的 `npm run build` 因为一个类型错误（TS2322）失败，退出码 1。`portal/Dockerfile:24` 就是 `RUN npm run build`，`docker-compose.prod.yml:135-138` 用它构建 portal 服务，`.github/workflows/deploy.yml:35-36` 推 main 后在服务器上跑 `docker compose up -d --build`（脚本首行 `set -euo pipefail`）。这个错误由 2026-04-29 的 `fad110c` 引入，CI/CD 流水线 2026-05-07 才建立（`3974c9d`），**这条自动部署流水线从建立那天起就从未成功构建过 portal**。修复只需要改一个字符串：`posterUrl?: string` → `posterUrl?: string | null`。
2. **根因是零门禁。** 仓库唯一的 workflow 只有 SSH 部署一个 job，全文没有 `npm ci` / `npm run build` / `tsc --noEmit` / `lint` / `test` 任何一步，checkout 那步的注释自己写着"仅用于获取 commit 信息"。三个子项目的 lint 全部不可用（无 ESLint 配置文件），测试文件数为 0（`npm test` → `No tests found`）。所以一个编译错误能在 main 上躺 3.5 个月，而且是"推 main 直达生产"，无 PR 检查、无分支保护。
3. **有一个真正的生产事故引信：`.env.prod:16` 是 `DB_SYNC=true`。** `scripts/deploy.sh:12` 用 `--env-file .env.prod`，`database.module.ts:41` 的条件是 `DB_SYNC === 'true' || !isProd` —— 也就是**无视 NODE_ENV 强制开启 TypeORM synchronize**。这是首次部署时 `deploy.sh:37-41` 临时 export 的值被写进配置后没人关掉（脚本只 warn，从不回写）。而项目**零 migration**（全仓无 migration 目录、无 data-source.ts、package.json 无任何 typeorm CLI 脚本），整个 schema 完全托管给 synchronize。这意味着每次 backend 容器启动，TypeORM 都会拿实体定义去 ALTER 生产库；改个字段类型、删个 `@Column`、重命名属性都会静默 DROP 列并丢数据。MySQL 侧还是 `STRICT_TRANS_TABLES`。

**最致命的两件事，排序明确：**

- **第一：`portal` 构建失败。** 它是所有其他修复的前置阻塞项——本报告里剩下 57 条无论修得多好，只要 portal 编译不过，`docker compose build` 就会整体失败，一行代码都上不了线。工作量：trivial，改一个类型标注。
- **第二：生产 `DB_SYNC=true` + 零 migration。** 这是唯一一个"什么都不做也会出事"的项。前一个是发布不了，这一个是可能丢数据。但**修它的顺序不能反**：不能直接把 `DB_SYNC` 改成 false 就重启——如果生产库当前正靠 synchronize 兜着 Phase 1-A/1-B 新增的三个列和 `watch_history` 表，关掉之后影视模块和续播功能会立刻 500。必须先备份、先取证、先补列，最后才关。

其余量级判断：

- **认证层有三处真实缺陷**（watch-history 三个接口手工 base64 解 JWT 不验签、logout 黑名单读写 key 不匹配、缓存 TTL 单位差 1000 倍导致登录限流从 15 分钟缩成 0.9 秒），单个都不到 critical，但都是"功能看起来在、实际不起作用"。
- **一个自我 DoS**：没开 `trust proxy`，全站限流退化成"每接口 100 次/60 秒、全体访客共用一个桶"，几个用户刷首页就能让第 101 个访客吃 429。
- **`/_next/image` 是个对公网开放的无鉴权 https 抓取代理**，而全站一个 `next/image` 都没用，功能收益为零。
- **约 300MB 死依赖**（backend 的 prisma 93MB + aws-sdk 108MB，frontend 的 storybook 70MB + 13 个零引用包 15MB），既拖慢每次 `npm ci`，又把 audit 报告污染成几十条噪音，让真正需要处理的告警被淹没。

---

## 二、批次划分总览

| 批次 | 主题 | 条目数（去重后） | 预估工时 | commit 策略 |
|---|---|---|---|---|
| **0** | 阻断性：恢复可部署 + 消除数据事故风险 | 6 | 0.5–1 人日（+ 服务器操作窗口） | 拆 4 个 commit |
| **1** | 安全修复 | 11 | 2–3 人日 | 拆 5 个 commit |
| **2** | 依赖瘦身 | 9 | 0.5 人日 | 按子项目 3 个 commit |
| **3A** | patch 级安全升级（范围内） | 8 | 0.5 人日 | 按子项目 3 个 commit |
| **3B** | major 升级（单独评估，本轮多数跳过） | 5 | 见下 | 每项独立分支 |
| **4** | 半成品收尾 + 质量基建 | 9 | 3–4 人日 | 按功能拆 |

**批次间强制顺序：0 → 1 → 2 → 3A → 4**。批次 3B 全部独立分支，不进主线节奏。

---

## 三、批次 0：阻断性问题（必须最先做）

### 包含条目

| 原编号 | 问题 | 严重度 |
|---|---|---|
| #1 / #2（同一缺陷） | portal `npm run build` 因 TS2322 失败，Docker 镜像构建不出来 | critical |
| #13 | `.env.prod:16` `DB_SYNC=true`，生产跑 TypeORM synchronize | high |
| #15 | 零 migration，schema 完全托管 synchronize；存量库/新库两头都有风险 | high |
| #17 | `database/init/00-init.sql` 硬编码 `cms_dev`，全新部署 MySQL 初始化失败 | high |
| #14 | 未开 `trust proxy`，全局限流退化成自我 DoS | high |
| #11 | CI 无任何构建/类型检查关卡 | high |

**预估工时**：本地改动 2–3 小时；服务器取证与数据库操作另需一个 1 小时的维护窗口（含备份）。

**能否合并成一个 commit**：不能，拆 4 个：
- `fix(portal): 修复 PlayClient 局部 Movie 类型与 lib/types 不一致导致的构建失败`
- `fix(db): 生产环境关闭 DB_SYNC，修正 init SQL 库名`
- `fix(backend): 启用 Express trust proxy，恢复按 IP 限流`
- `ci: 在部署前增加三端构建与类型检查门禁`

**验证方式（全部必须通过）**：
```bash
cd /f/METU/cms-project/portal   && npx tsc --noEmit --incremental false && npm run build   # 均需 EXIT=0
cd /f/METU/cms-project/backend  && npx tsc --noEmit -p tsconfig.json && npm run build       # 均需 EXIT=0
cd /f/METU/cms-project/frontend && npm run build                                             # EXIT=0
```

---

### 批次 0 完整逐步操作清单

#### 步骤 0.0：建立安全网（先做，不可跳过）

```bash
cd /f/METU/cms-project
git status --porcelain          # 应为空；不为空先处理掉
git checkout -b fix/batch-0-unblock-deploy
```

服务器侧（在动任何数据库配置之前）：
```bash
# 在生产服务器上
bash scripts/backup.sh
# 确认备份文件已生成且大小合理，再继续
```

---

#### 步骤 0.1：修复 portal 构建（最高优先级，5 分钟）

**改动文件**：`F:/METU/cms-project/portal/app/movies/[slug]/play/[srcIdx]/[ep]/PlayClient.tsx`

第 24 行（在局部 `interface Movie` 内，行 20-26）：

```diff
 interface Movie {
   id: string
   slug: string
   title: string
-  posterUrl?: string
+  posterUrl?: string | null
   sources?: Source[]
 }
```

**为什么这样改是安全的（已实测）**：
- 权威类型 `portal/lib/types.ts:121` 就是 `posterUrl?: string | null`，`page.tsx:36` 把它传给 `PlayClient`，两边不兼容才报 TS2322。
- 下游无影响：`portal/components/HlsPlayer.tsx:7` 的 prop 本身就声明为 `poster?: string | null`，第 108 行已做 `poster={poster ?? undefined}` 归一化，`PlayClient.tsx:150` 的 `poster={movie.posterUrl}` 不会因放宽类型而新增错误。这正是改完 `tsc` 能归零的原因。
- 已实测：改后 `npm run build` EXIT=0，16 条路由全部产出，standalone 构建成功。

**更干净的可选做法**（同样已核对字段兼容性，二选一）：删掉 `PlayClient.tsx:8-26` 的三个局部 interface，改为
```ts
import type { Movie, MovieSource, MovieEpisode } from '@/lib/types'
```
并把 Props 里的 `Source` → `MovieSource`、`Episode` → `MovieEpisode`。已逐字段核对：PlayClient 用到的 `episode.id/.title/.url`、`source.id/.name/.episodes`、`movie.id/.slug/.title/.posterUrl/.sources` 全部存在于 `lib/types.ts` 的 `MovieEpisode(87-95)` / `MovieSource(97-105)` / `Movie(107-136)` 中，属超集关系。
> 注意：不要被"要确认 `friendlySourceName(source)` 入参签名兼容 MovieSource"这个说法误导——实际签名是 `friendlySourceName(name: string, index: number)`（`lib/movie-utils.ts:16`），PlayClient 在 :169/:218/:228 也是这么调的，不存在该问题。

**验证**：
```bash
cd /f/METU/cms-project/portal
npx tsc --noEmit --incremental false ; echo "TSC EXIT=$?"     # 必须 0
npm run build ; echo "BUILD EXIT=$?"                          # 必须 0
ls .next/standalone .next/BUILD_ID                            # 必须存在（Dockerfile:40-41 要 COPY 它们）
```

**提交**：
```bash
git add "portal/app/movies/[slug]/play/[srcIdx]/[ep]/PlayClient.tsx"
git commit -m "fix(portal): PlayClient 局部 Movie 类型补 null，修复 next build TS2322"
```

---

#### 步骤 0.2：修正 init SQL 库名（防止下一次全新部署被卡死）

**改动文件**：`F:/METU/cms-project/database/init/00-init.sql`

当前内容硬编码 `cms_dev`（这份文件本是开发用的，被生产原样复用了；`docker-compose.yml:19` 开发库确实叫 `cms_dev`）。而 `docker-compose.prod.yml:38` 把 `./database/init` 挂进生产 MySQL 的 `/docker-entrypoint-initdb.d`，`docker-compose.prod.yml:24` 是 `MYSQL_DATABASE: ${MYSQL_DATABASE:-cms_prod}`，`.env.prod:5` 就是 `MYSQL_DATABASE=cms_prod`。

**推荐做法：给生产单独建一份 init 目录**，不动 dev 那份。

```bash
cd /f/METU/cms-project
mkdir -p database/init-prod
cat > database/init-prod/README.md <<'EOF'
生产 MySQL 初始化目录。
库与用户由 MYSQL_DATABASE / MYSQL_USER 环境变量自动创建并授权，
此处无需再写 CREATE DATABASE / GRANT，否则会在库名不匹配时中断 entrypoint。
EOF
```

然后改 `docker-compose.prod.yml:38`：
```diff
-      - ./database/init:/docker-entrypoint-initdb.d:ro
+      - ./database/init-prod:/docker-entrypoint-initdb.d:ro
```

**若坚持复用同一份文件**，则删掉 `00-init.sql` 里所有 `cms_dev` / `cms_test` 相关的 `ALTER DATABASE`（第 5 行）与 `GRANT`（第 11-12 行）——MySQL 镜像的 entrypoint 已经根据 `MYSQL_DATABASE`/`MYSQL_USER` 建库并授权，这两行本来就是冗余的。

**为什么必须修**：`mysql:8.0` 的 entrypoint 是 `set -eo pipefail`，`ALTER DATABASE cms_dev` 在库不存在时报 ERROR 1049 直接中止 init。datadir 此时已初始化完毕，容器重启后会跳过 init 正常起来——**但那一次 `docker compose up -d` 会因为 backend 的 `depends_on: mysql: condition: service_healthy`（compose:120-124）而失败返回**，`deploy.sh`（`set -euo pipefail`）死在第 45 行。运维重跑时 `docker volume inspect prism_mysql_data`（deploy.sh:37）已经成功 → `FIRST_DEPLOY=false` → 既不 `export DB_SYNC=true` 建表，也不跑 `seed-admin.js`。最终得到一个空 schema + 没有管理员账号、却"看起来部署成功"的实例。

**顺带加固 `scripts/deploy.sh` 的首次部署判定**（可选但强烈建议）：把第 37 行的 `docker volume inspect prism_mysql_data` 换成实际探测 schema——
```bash
# 起 mysql 后执行
SELECT 1 FROM information_schema.tables WHERE table_schema='cms_prod' AND table_name='users';
```
查不到就走首次部署分支。否则任何一次首启失败都会把项目永久锁进"空库 + 无管理员"状态。

---

#### 步骤 0.3：处理生产 `DB_SYNC=true`（顺序绝不能反）

> ⚠️ 这一步涉及生产数据库。必须在维护窗口内、备份完成后执行。

**0.3.1 先取证，再决定走哪条路**（在服务器上）：
```bash
cd <项目目录>
grep -n DB_SYNC .env.prod
docker compose -f docker-compose.prod.yml --env-file .env.prod exec backend printenv DB_SYNC

# 检查 Phase 1-A/1-B 的 schema 是否已经存在
docker compose -f docker-compose.prod.yml --env-file .env.prod exec mysql \
  mysql -ucms -p"$MYSQL_PASSWORD" cms_prod -e "
    SHOW COLUMNS FROM movies LIKE 'aliases';
    SHOW COLUMNS FROM movies LIKE 'posterBroken';
    SHOW COLUMNS FROM movies LIKE 'titleCleaned';
    SHOW TABLES LIKE 'watch_history';
  "
```

**0.3.2 若列/表缺失，先补齐**（类型严格对齐 `movie.entity.ts:153-163` 与 `watch-history.entity.ts`）：
```sql
ALTER TABLE movies
  ADD COLUMN aliases VARCHAR(1000) NULL,
  ADD COLUMN posterBroken TINYINT NULL DEFAULT NULL,
  ADD COLUMN titleCleaned TINYINT(1) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS watch_history (
  id CHAR(36) NOT NULL PRIMARY KEY,
  userId VARCHAR(36) NULL,
  guestId VARCHAR(64) NULL,
  contentType VARCHAR(20) NOT NULL,
  contentId VARCHAR(36) NOT NULL,
  episodeId VARCHAR(36) NULL,
  srcIdx INT NOT NULL DEFAULT 0,
  epIdx INT NOT NULL DEFAULT 0,
  progressSec INT NOT NULL DEFAULT 0,
  durationSec INT NULL,
  createdAt DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updatedAt DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  INDEX (userId, contentType, contentId),
  INDEX (guestId, contentType, contentId),
  INDEX (userId, updatedAt),
  INDEX (guestId, updatedAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```
> `movies` 表大时 `ADD COLUMN` 在 MySQL 8 多数是 INSTANT，但执行前确认一次；备份已在步骤 0.0 完成。

**0.3.3 关掉 DB_SYNC**：
```bash
# 服务器上
sed -i 's/^DB_SYNC=true$/DB_SYNC=false/' .env.prod
grep -n DB_SYNC .env.prod                       # 确认已是 false
docker compose -f docker-compose.prod.yml --env-file .env.prod restart backend
docker compose -f docker-compose.prod.yml --env-file .env.prod logs -f backend  # 确认无 Unknown column
```

**0.3.4 让 deploy.sh 不再留下这个坑**：`scripts/deploy.sh:75-77` 目前只打印"建议手动改回 false"，从不回写。改成部署完成后自动 `sed -i 's/^DB_SYNC=true$/DB_SYNC=false/' .env.prod`。

**0.3.5 代码层硬防护 —— 本轮不做，登记为批次 4 前置**：把 `database.module.ts:41` 改成 `synchronize: !isProd` 是正确方向，但**必须先有 migration 基线**，否则新环境起不来。现状是：无 migration 目录、无 typeorm CLI 脚本；`database/init.sql` 是 202 行 PostgreSQL 语法（第 5-7 行 `CREATE EXTENSION uuid-ossp/pg_trgm`），与 MySQL 栈完全不兼容；真正挂载的 `00-init.sql` 一张表都不建。生成 migration 基线必须在"库结构已与实体对齐之后"再做，否则 `migration:generate` 会产出一堆 DROP。

---

#### 步骤 0.4：启用 trust proxy（恢复按 IP 限流）

**改动文件**：`F:/METU/cms-project/backend/src/main.ts`

在 `NestFactory.create<NestExpressApplication>(AppModule)` 之后（第 13 行下方）插入：

```ts
  // nginx 是唯一入口（docker-compose.prod.yml 中 backend 未 publish 端口），
  // 只信任 1 跳，避免客户端自带 XFF 污染限流 tracker
  app.set('trust proxy', 1);
```

**为什么是 1 而不是 true**（已用项目自带 express 4.22.1 实测）：默认状态下带 `X-Forwarded-For: 1.2.3.4, 5.6.7.8` 请求，`req.ips` 为 `[]`；设 `trust proxy: 1` 后为 `['5.6.7.8']`（即 nginx 追加的真实客户端 IP）；发送 `X-Forwarded-For: evil-spoof, 9.9.9.9` 得到的仍是 `['9.9.9.9']`，攻击者无法伪造。设 `true` 则会信任整条链，可被污染。

**顺带加兜底**，`backend/src/common/guards/throttler-behind-proxy.guard.ts:7`：
```diff
-    return req.ips?.length ? req.ips[0] : req.ip;
+    return (req.ips?.length ? req.ips[0] : req.ip) ?? 'unknown';
```

**注意一个仍未解决的口径问题**：portal 的 SSR 请求走 `docker-compose.prod.yml:149` 的 `BACKEND_INTERNAL_URL: http://backend:3001` 直连，完全绕开 nginx，即使加了 trust proxy 这部分流量仍会以 portal 容器 IP 共用一个桶。处理方式二选一：给 SSR 请求转发真实客户端 IP，或对内网来源用 `@SkipThrottle` 排除。本轮可先只做 trust proxy，SSR 那部分登记到批次 1。

**另需留意**：`trust proxy: 1` 会让 `req.protocol` 反映 `X-Forwarded-Proto`。当前代码无任何地方依赖 `req.protocol`（已 grep 确认），但后续加强制 HTTPS 跳转时要记得这一点。

---

#### 步骤 0.5：挂上 CI 构建门禁（必须在 0.1 之后）

**改动文件**：`F:/METU/cms-project/.github/workflows/deploy.yml`

> ⚠️ **不要**新建 `ci.yml` 然后给 deploy job 加 `needs: [ci]`。GitHub Actions 的 `needs` 只能引用**同一个 workflow 文件内**的 job，跨文件引用会得到 `Job 'deploy' depends on unknown job 'ci'` 的校验错误，部署直接跑不起来。

在现有 `deploy` job **之前**新增一个 job，并给 `deploy` 加 `needs`：

```yaml
jobs:
  build-check:
    name: Build & Typecheck
    runs-on: ubuntu-latest
    timeout-minutes: 20
    strategy:
      fail-fast: false
      matrix:
        dir: [backend, frontend, portal]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: npm
          cache-dependency-path: ${{ matrix.dir }}/package-lock.json
      - run: npm ci
        working-directory: ${{ matrix.dir }}
      - run: npx tsc --noEmit
        working-directory: ${{ matrix.dir }}
      - run: npm run build
        working-directory: ${{ matrix.dir }}

  deploy:
    name: SSH Deploy
    needs: [build-check]        # ← 新增这一行
    runs-on: ubuntu-latest
    # ...以下保持原样
```

**三条硬约束**：
1. **必须先完成步骤 0.1**，否则 main 立刻被门禁锁死，无法部署任何东西。
2. **不要把 `npm run lint` 放进 CI**。三个子项目的 lint 目前全部不可用（backend/frontend 无 ESLint 配置直接退出码 2，portal 连 eslint 都没装），加进去 CI 必然红。等批次 4 补齐配置后再单独接入。
3. **不要现在加 `npm test`**。项目零测试文件，`npm test` 直接 `No tests found, exiting with code 1`。

**分支保护是补充而非替代**：`on: push: branches: [main]` 意味着 required status checks 拦不住直接 push。若要彻底管住，需要额外配置"禁止直接推 main"的 push 限制。本轮可先只加 job 门禁。

---

#### 批次 0 附注（不属于 58 条正式清单，但取证过程中确认成立）

`.env.prod` 的 `JWT_SECRET` / `JWT_REFRESH_SECRET` 熵极低、可被人工推演（原文曾在此给出前缀与规律，已于 2026-10-08 删除并轮换密钥，见执行进度 1-F-1）。既然本批次已经要动 `.env.prod` 并重启 backend，建议顺手用 `openssl rand -hex 32` 各生成一份替换。**副作用**：所有现存 token 立即失效，全体用户需重新登录——请安排在低峰期，并与 0.3.3 的重启合并成一次。

---

## 四、批次 1：安全修复

### 1-A：认证与缓存三件套（必须同批，缺一个都拿不到可用能力）

| 原编号 | 问题 |
|---|---|
| #5 | logout 黑名单写入 `blacklist:token:<末20字符>`，`jwt.strategy.ts:29` 读的是 `blacklist:<完整JWT>`，永不命中 |
| #4 | cache-manager v5+ TTL 改毫秒，三处调用点仍按秒传，TTL 被缩短 1000 倍 |
| #3 | `cache-manager-redis-store` 的 `.default` 恒为 undefined + `@nestjs/cache-manager` v3 只读 `options.stores`（复数），生产 Redis 从未生效，静默降级为进程内 Map |

**为什么必须一起**：只修 key 不修 TTL → 黑名单条目只活 7 秒；只修 TTL 不修 Redis → 单实例内存里的 TTL，重启即失；只接 Redis 不修 key → 依然不吊销任何 token。

**具体改动**：

1. **黑名单 key 统一**。在 auth 模块导出共享构造器（建议直接上 sha256，避免末 20 字符的碰撞面）：
   ```ts
   export const accessBlacklistKey = (t: string) =>
     'blacklist:token:' + crypto.createHash('sha256').update(t).digest('hex');
   ```
   `auth.service.ts:158` 与 `jwt.strategy.ts:29` 同时改用它。

2. **TTL 全部改毫秒**：
   - `user.service.ts:24` → `private readonly CACHE_TTL = 300_000;`
   - `auth.service.ts:33` → `private readonly LOGIN_BLOCK_TIME = 15 * 60 * 1000;`
   - `auth.service.ts:154-156` → `const ttl = (decoded?.exp ? decoded.exp - Math.floor(Date.now()/1000) : 7200) * 1000;`（:157 的 `if (ttl > 0)` 仍成立）
   - `redis.module.ts:23,31` → `ttl: 300_000`

3. **Redis 换 Keyv 适配器**：
   ```bash
   cd backend
   npm rm cache-manager-redis-store @redis/client
   npm i @keyv/redis keyv
   ```
   重写 `src/shared/redis/redis.module.ts`：生产分支 `return { stores: [new Keyv({ store: new KeyvRedis(url) })], ttl: 300_000 }`，开发分支 `return { ttl: 300_000 }`。删掉两处 `max: 100`（v7 的无-stores 分支只透传 ttl/refreshThreshold/nonBlocking，`max` 从头到尾没被读过）。把 `isGlobal: true` 从 `useFactory` 返回值移到 `CacheModule.registerAsync` 顶层（`cache.module.js` 只从顶层读 `global: options.isGlobal`）。给 Keyv 实例挂 `.on('error', e => logger.error(e))` 做启动自检。
   > ⚠️ 顺序约束：**不能先删 `cache-manager-redis-store` 而不改 `redis.module.ts:16` 的 `await import(...)`** —— 虽然它的返回值本来就没生效，但 import 语句本身会在 `NODE_ENV=production` 时抛 MODULE_NOT_FOUND，把"静默降级"变成"启动崩溃"。两处改动必须同一个 commit。

4. **配套已知缺口**：`role.service.ts:76` 的 `assignPermissionsToRole` 改的是角色权限，不会失效持有该角色的所有用户缓存。TTL 真正生效后这里会出现最长 5 分钟的权限滞后，需单独处理。另 `user.service.ts:54` 的无参 `clearUserCache()` 因 `if (userId)` 守卫实际是空操作（:302-306）。

**工时**：0.5–1 人日。**commit**：`fix(auth): 统一黑名单 key、修正缓存 TTL 单位、接入 Keyv Redis`（三处强耦合，合成一个 commit 更安全）。

**验证**：
```bash
cd backend && npx tsc --noEmit -p tsconfig.json
# 手工回归（暂无自动化测试）：
# 1) 登录 → logout → 用同一 token 请求受保护接口，应 401
# 2) 连续 5 次密码错误 → 第 6 次应被锁定，等待 <15min 内重试仍被锁
# 3) redis-cli --scan --pattern '*blacklist:*' 能看到条目（证明真的写进 Redis 了；
#    Keyv 给键加了 keyv::keyv: 前缀，KEYS 'blacklist:*' 恒为空）
```

---

### 1-B：watch-history 认证绕过与入参校验

| 原编号 | 问题 |
|---|---|
| #12 / #16（同一缺陷） | 三个接口手工 `JSON.parse(Buffer.from(authHeader.split('.')[1],'base64url'))`，不验签、不验 exp、不查黑名单，可任意伪造 userId |
| #31 | `ReportProgressDto` 是 **interface** 不是 class，全局 ValidationPipe 完全跳过，DTO 无任何校验 |

**改动**：

1. 新建 `JwtOptionalGuard extends AuthGuard('jwt')`，`handleRequest(err, user) { return user || undefined }`；`watch-history.controller.ts` 的三条路由（report / findProgress / findRecent，位于 29-44、51-66、92-106 行）挂 `@UseGuards(JwtOptionalGuard)`，`userId` 改从 `req.user?.id` 取（`jwt.strategy.ts:43` 返回的字段名确实是 `id`）。签名、过期、黑名单、用户禁用状态全部由现成 JwtStrategy 复用。
   > **不需要**给 `WatchHistoryModule` 引入 `PassportModule`/`AuthModule`——`'jwt'` 策略由 AppModule 引入的 AuthModule 全局注册到 passport，`media.module.ts` 和 `comment.module.ts` 都没引入任何 auth 模块照样正常使用 `AuthGuard('jwt')`。

2. `ReportProgressDto` 改 class + class-validator：
   ```ts
   @IsIn(['movie','novel','comic']) contentType: string;
   @IsUUID() contentId: string;
   @IsOptional() @IsUUID() episodeId?: string;
   @IsInt() @Min(0) srcIdx: number;
   @IsInt() @Min(0) epIdx: number;
   @IsInt() @Min(0) @Max(604800) progressSec: number;   // 86400 对长影片偏紧
   @IsOptional() @IsInt() @Min(0) durationSec?: number;
   @IsOptional() @IsString() @MaxLength(64) guestId?: string;
   ```
   > ⚠️ 改成 class 后 `forbidNonWhitelisted: true` **首次真正生效**。`PlayClient.tsx:83-92` 发送的 8 个字段必须与 DTO 完全对齐（已核对是一致的），但上线前必须实测一次上报，任何多余字段都会 400。GET 侧建 Query DTO 时注意 `main.ts:57` 开了 `enableImplicitConversion`，数值形参会自动转型。

3. 顺带修全局限流单位：`docker-compose.prod.yml:105` 的 `RATE_LIMIT_TTL: 60` 在 throttler v5 下是 60 **毫秒**，应改成 `60000`。否则给 report 挂 `@Throttle` 也只是继承同样错误的单位。

**工时**：0.5 人日。**commit**：`fix(watch-history): 改用 Passport 可选守卫 + DTO 校验，修复身份伪造与脏数据`。

---

### 1-C：portal 攻击面收敛

| 原编号 | 问题 |
|---|---|
| #10 | `next.config.js` 的 `hostname:'**'` + 全站零 `next/image`，`/_next/image` 变成对公网开放的 https 抓取代理 |
| #44 | `/proxy-api/:path*` rewrite 是死配置，零引用，白留 rewrites 走私 advisory 适用面 |

**改动 1** — `F:/METU/cms-project/portal/next.config.js`：
```diff
 images: {
-  remotePatterns: [
-    { protocol: 'http',  hostname: 'localhost' },
-    { protocol: 'https', hostname: '**' },
-  ],
+  unoptimized: true,   // 全站使用原生 <img>，不需要 Next 图片优化器
 },
```
零功能影响：`grep -rn 'next/image'` 零命中，8 处图片全是原生 `<img>`。生效路径已核实：`next-server.js:166-169` 的 `if (imagesConfig.loader !== 'default' || imagesConfig.unoptimized) { render404() }`。

真实攻击面（已实测收敛版本，比原报告描述小一半）：明文 http 只匹配 `hostname:'localhost'` 那条，跨容器的 `backend:3001`/mysql/redis 打不到，云元数据 169.254.169.254 只监听 http 也打不通。**仍然成立的是**：任意 **https** URL 的无鉴权出站抓取、portal 容器内 localhost 端口扫描（`next-server.js:204-207` 会把上游状态码原样回吐，是现成的盲 SSRF oracle）、以及 `image-optimizer.js:579-586` 先 `arrayBuffer()` 全量落 Buffer 才在 626/650 行校验类型且无大小上限——一个请求指向大文件即可把 Node 打 OOM。端点无鉴权、公网直达（`nginx.conf:100` 全量代理、无限流）。

**改动 2** — 删掉 `next.config.js:14-22` 整个 `rewrites()` 方法（已 grep 全仓确认零引用）。若要保留开发期便利：
```js
async rewrites() {
  if (process.env.NODE_ENV === 'production') return []
  return [{ source: '/proxy-api/:path*', destination: 'http://localhost:3001/api/v1/:path*' }]
}
```
（`next build` 会自行把 NODE_ENV 设为 production，判断成立。）

**改动 3（纵深防御，不依赖重新构建）** — `nginx/nginx.conf` 与 `nginx/nginx-ssl.conf` 在 `location /` 之前加：
```nginx
location /_next/image { return 404; }
```

**验证**：`npm run build` 后检查 `.next/routes-manifest.json` 的 `rewrites` 数组为空。

**工时**：1 小时。**commit**：`fix(portal): 关闭图片优化器并移除死 rewrite，收敛公网攻击面`。

---

### 1-D：文件上传加固

| 原编号 | 问题 |
|---|---|
| #6 / #30（同一缺陷） | 运行时实际解析 multipart 的是 `@nestjs/platform-express@10.4.22` 精确锁定的嵌套 `multer@2.0.2`，落在 GHSA-72gw-mp4g-v24j（`<2.2.0`，cvss 7.5）范围内；且 `MulterModule.register` **完全没有 limits** |

> **原报告的版本归属是错的，照做无效**：顶层 `multer@1.4.5-lts.2` 只被 `media.module.ts:4` 的 `memoryStorage` 导入用到，不是运行时解析的那个。`npm i multer@^2` 解决不了嵌套副本。

**改动**：

1. **加 limits（这是独立缺陷，也是本轮真正的收益）** — `media.module.ts:14`：
   ```ts
   MulterModule.register({
     storage: memoryStorage(),
     limits: { fileSize: 10*1024*1024, files: 1, fields: 20, parts: 25, fieldNameSize: 100 },
   })
   ```
   当前 `media.controller.ts:74` 的 `if (file.size > MAX_FILE_SIZE)` 是在整个文件已缓冲进内存**之后**才检查，约束不了内存占用。`src/config/configuration.ts:27` 虽然解析了 `UPLOAD_MAX_SIZE`，但从未传给 multer。
   > 报错映射**不需要**动 HttpExceptionFilter：`@nestjs/platform-express/multer/multer/multer.utils.js:11-12` 已经把 `LIMIT_FILE_SIZE` 映射成 `PayloadTooLargeException(413)`，前端只会从 400+中文提示变成 413，改文案即可。

2. **用 overrides 顶掉嵌套的 2.0.2**（不升 NestJS 主版本的前提下唯一有效的做法），`backend/package.json`：
   ```json
   "overrides": { "multer": "2.2.0" }
   ```
   然后 `npm install`，**必须用 `npm ls multer --all` 确认 platform-express 下的嵌套副本已变成 2.2.0**，光看顶层版本不算数。2.0.2→2.2.0 同主版本，storage engine 接口不变。

3. **nginx 收口**：`nginx/nginx.conf:33` 与 `nginx-ssl.conf:27` 的 `client_max_body_size 100M` 降到 `12M`（当前与后端 10MB 上限错配）。

**当前缓解事实**（决定这条不是 critical）：`media.controller.ts:37` 的 `@UseGuards(AuthGuard('jwt'))` 挂在整个 Controller 上，需有效 JWT；且 `grep -rn "writeFile|createWriteStream|fs\." src/modules/media/` 零命中、`backend/uploads` 目录不存在——上传功能只写 DB 记录不落盘。所以这是"已认证用户可触发的内存耗尽"，不是匿名可打。

**工时**：0.5 人日。**commit**：`fix(media): 上传加 multer limits，overrides 顶掉受影响的嵌套 multer`。

---

### 1-E：nginx 与信息泄露（低风险硬化，可合并一个 commit）

| 原编号 | 问题 | 备注 |
|---|---|---|
| #29 | `GET /api/v1/comments/public` 无鉴权返回完整实体，泄露游客邮箱 | 真实 PII |
| #50 | `/uploads/` 里的 `add_header` 覆盖掉 server 级全部安全头 | 当前 /uploads/ 永远 404，纯前置硬化 |
| #51 | 缺 `server_tokens off`、缺 `limit_req` | 纵深防御 |
| #53 | `CORS_ORIGIN` 为空时得到 `['']`，fail-closed 但无日志、难排障 | 可用性 |
| #54 | helmet CSP 只作用于 API 容器，真正吐 HTML 的 portal/admin 无 CSP | 硬化 |
| #52 | `deploy/docker-compose.yml` 遗留 Postgres 架构，暴露 5432/6379 + 明文口令 | 孤儿陷阱文件 |

**改动要点**：

- **#29**：`comment.service.ts:53` 加 select 白名单 `['id','contentId','userId','guestName','body','status','parentId','createdAt']`，**保留 userId 仅供判断**，构树时映射成 `{...rest, isRegistered: !!userId}` 并删除 userId，前台 `portal/components/CommentSection.tsx:17-20` 的 `displayName()` 改读 `isRegistered`。
  > ⚠️ 不要走 `@Exclude + ClassSerializerInterceptor` 这条路：service 第 62 行 `{...c, children: []}` 已把实体展开成普通对象，拦截器对普通对象不生效。
  > 真正泄露的是 `guestEmail`（`CommentSection.tsx:58-59` 强制要求填写，是真实 PII）。`userId` 线上实际恒为 NULL（portal 从不提交、后端从不回填），`ipAddress` 也只来自客户端自报、不是真实 IP。
  > 若要连带堵住 UUID 枚举，真正的入口是 `content.controller.ts:44-71` 三个无 Guard 的公开接口直接返回 Content 实体，其中 `authorId`（`content.entity.ts:52`）是真实注册用户 UUID——给 content.service 的三个公开查询也加 select 白名单。

- **#50**：nginx 的 `add_header` 规则是"当前层级一旦出现 add_header 就完全不继承上层"。**加 `always` 参数解决不了继承问题**（`always` 只控制是否对非 2xx/3xx 响应输出）。唯一办法是在 `location /uploads/` 内逐条重申 `X-Frame-Options` / `X-Content-Type-Options` / `Referrer-Policy`（ssl 版再加 HSTS），保留原有的 `Cache-Control`。
  同时把 `media.controller.ts:78` 的扩展名改为按 mimetype 反查白名单后缀（`image/jpeg→.jpg`），当前用 `path.extname(file.originalname)` 直接拼，扩展名来自攻击者且不与 mimetype 白名单交叉校验——一旦补上落盘逻辑就是同源存储型 XSS。

- **#51**：http 块加 `server_tokens off;` 和 `limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;`，`location /api/` 内 `limit_req zone=api burst=20 nodelay;`，登录路径另建 `rate=1r/s` 的 zone。
  > 前提：必须在 trust proxy（步骤 0.4）之后再评估阈值，否则应用层与边缘层计数口径不一致会互相误判。先 `limit_req_status 429` + 观察 access.log 一周再收紧。若前面还有云厂商 LB，`$binary_remote_addr` 不是真实客户端 IP，需配 `set_real_ip_from`。

- **#53**：`main.ts:39-45` 过滤空项 + 启动期打印生效白名单：`logger.log('CORS 白名单: ' + corsOrigins.join(', '))`。删掉 `docker-compose.prod.yml:110` 提到的幽灵变量 `DOMAIN_EXTRA`（全仓只有这条注释本身命中）。
  > 安全上无风险——已用真实 cors@2.8.5 实测：`origin:['']` 和 `origin:[]` 都不下发 `Access-Control-Allow-Origin`，是 fail-closed 不是全开。修的是排障成本。

- **#54**：CSP 落点改到 `nginx/nginx.conf` 与 `nginx-ssl.conf` 的 server 块（加 `always`），凡是内部又写了 `add_header` 的 location（两份配置的 `/uploads/`）必须把 CSP 一起重申。backend 的 helmet CSP 保留（对 `/uploads/` 静态响应仍有增益）。
  > **必须先上 `Content-Security-Policy-Report-Only` 跑一周**，确认 Next.js hydration 内联脚本与 Ant Design 动态样式的实际需求后再转正。切勿直接上强制模式。
  > 已澄清：portal/admin 的 HTML 从不经过 backend（nginx 直接 proxy 到独立容器），所以"backend 的 CSP 会拦住 Next.js SSR 内联脚本"这个担心不成立；也不存在 Swagger UI 问题（满仓 `@ApiTags` 装饰器但从未 `SwaggerModule.setup()`）。

- **#52**：`rm -rf F:/METU/cms-project/deploy/`。已确认零引用（`.github/`、`scripts/`、`README.md`、`docs/`、所有 compose 文件均无命中），且它引用的 `./nginx.conf` 根本不存在、后端也早已不支持 Postgres。若要留档改名为 `.deprecated` 并在文件头加警告。顺带在 README 写明唯一生产入口是 `scripts/deploy.sh` + `docker-compose.prod.yml`。

**工时**：1 人日（CSP 的 Report-Only 观察期另计）。**commit**：拆成 `fix(api): 评论公开接口收敛字段` 和 `chore(nginx): 安全头/限流/CSP 硬化，删除遗留 deploy 目录` 两个。

---

## 五、批次 2：依赖瘦身

**共同特征**：零引用已用"全项目 grep（含 Dockerfile / compose / workflow / .env）+ 符号名二次确认 + package-lock 反查引用方"三重交叉验证；删除均为非 breaking；收益是 `npm ci` 速度、镜像体积、以及**把 audit 报告从几十条噪音降到可读**。

**预估工时**：0.5 人日（含验证）。**commit**：按子项目 3 个。

### 2-A：backend（约 200MB）

```bash
cd /f/METU/cms-project/backend

# Prisma：无 schema.prisma、src 零引用、三个 npm script 100% 失败
# @prisma/client 在 dependencies(82MB)，npm prune --production 剪不掉，直接进生产镜像
npm rm @prisma/client prisma
# 手动删掉 package.json 里 prisma:generate / prisma:migrate / prisma:studio 三个 script

# AWS SDK：零引用，实际存储是本地磁盘（memoryStorage + /uploads/）
# aws-sdk v2 = 99MB 且已 EOL；@aws-sdk/client-s3 = 9MB
npm rm aws-sdk @aws-sdk/client-s3

# csurf：零引用，上游已归档，audit 给的"修复"是降级到 1.2.2（等于无法修复）
npm rm csurf

# pg：零引用（grep 到的 'pg' 全是采集接口的分页参数）
npm rm pg
```

配套代码删除：
- `src/config/database.config.ts` 整个删除（读的是 `DB_HOST/DB_PORT/DB_USERNAME/...` 一套无人消费的键名，默认值还是 PostgreSQL 5432/postgres），同时删 `app.module.ts:10` 的 import 和 `:42` load 数组里的 `databaseConfig`。
  > ⚠️ **只能删 `databaseConfig`，绝不能动同一数组里的 `configuration`** —— `jwt.strategy.ts:20` 用的是 `configService.get('app.jwt.secret')`，两个一起删会让 JWT secret 变成 undefined、整个登录挂掉。
- `.env.example:9` 的 `DATABASE_PORT=5432` 改成 3306，删掉 `:13` 那行无人读取的 `DATABASE_URL=postgresql://...`。**不要**去改 `.env.example` 里的 `DB_*` 键名——那些键在 `.env.example` 里根本不存在，它用的就是正确的 `DATABASE_*`。
- `database.module.ts:61` 的 fallback 前加校验，把"拼错 DB_TYPE 静默降级到 SQLite"变成启动失败：
  ```ts
  if (!['mysql','mariadb','sqlite'].includes(dbType)) throw new Error(`不支持的 DB_TYPE: ${dbType}`);
  ```

**补一个缺失声明**（是加不是删，同批做）：
```bash
npm i dotenv@^16     # 装进 dependencies，脚本要在生产镜像里跑
```
`scripts/migrate-sqlite-to-mysql.js:19` 与 `scripts/seed-admin.js:10` 直接 `require('dotenv')`，但 package.json 两边都没声明，今天能跑纯靠 `@nestjs/config` 提升上来的副本。这两个脚本会进生产镜像（`Dockerfile:35` COPY scripts），而 seed-admin 正是首次部署初始化管理员的那一步。

**不要删**：`mysql2`（TypeORM mysql 分支 + 三个 script 在用）、`better-sqlite3`（database.module.ts:62 的 fallback + 迁移脚本）。

**收益说明（诚实口径）**：删完能消掉 `fast-xml-builder` 两条 HIGH、`aws-sdk` 一条 moderate、`csurf` 两条 low。**`uuid` 那条 cvss 7.5 不会消失**——它同时挂在 `@nestjs/schedule@3.0.4 → uuid@9.0.1` 上，只有升 `@nestjs/schedule` 到 6.x（属批次 3B）才能清掉。

### 2-B：frontend（约 85MB）

```bash
cd /f/METU/cms-project/frontend

# Storybook 全套：无 .storybook 目录、无任何 .stories 文件、不参与 build
# 独家拖进 13 条 audit 告警（含唯一那条 tar CRITICAL）
npm rm storybook @storybook/addon-essentials @storybook/addon-interactions \
       @storybook/addon-links @storybook/addon-onboarding @storybook/blocks \
       @storybook/react @storybook/react-vite @storybook/testing-library
# 删掉 package.json:23-24 的 storybook / build-storybook 两个 script

# react-query v3：27 处调用全部用 @tanstack/react-query v5，v3 零引用
# 陷阱在于 IDE 自动导入会补成 'react-query'，tsc 和 vite build 都能过，运行时抛 "No QueryClient set"
npm rm react-query

# 13 个零引用 dependencies（约 15MB）——分两批提交便于回滚
npm rm crypto-js react-window react-virtualized-auto-sizer js-cookie lodash-es \
       zod react-hook-form @hookform/resolvers react-dropzone react-markdown rehype-sanitize
npm rm @ant-design/pro-components @tanstack/react-query-devtools
npm rm @types/js-cookie @types/lodash-es   # package.json:66/67
```

**逐条已确认**：token 全走 localStorage（js-cookie 零命中）；表单全用 antd 的 `Form.useForm`（react-hook-form/zod 零命中）；Markdown 用 `@uiw/react-md-editor`（root 的 react-markdown@9.1.0 是孤儿，`@uiw/react-markdown-preview` 自带 ~10.1.0 继续工作）。`js-cookie@3.0.5` 和 `@ant-design/pro-components` 各带一条 direct HIGH，是白背的锅。

**绝对不要删 `echarts`** —— `echarts-for-react` 把它声明为 peerDependency（`^3.0.0 || ^4.0.0 || ^5.0.0 || ^6.0.0`）。

**`@tanstack/react-query-devtools` 实装是 5.100.1**（不是某些描述里的 0.x），与 react-query v5 同线。若想保留作为开发工具，移到 devDependencies 并在 `main.tsx` 按 `import.meta.env.DEV` 条件挂载。

**测试基建三件（vitest / @vitest/ui / @playwright/test）**：本轮**先不删**，见批次 4 决策点。它们贡献一条 CRITICAL（`GHSA-5xrq-8626-4rwp`），但触发条件是 `vitest --ui` 服务在监听，而项目零测试文件、该服务永不会被拉起，真实暴露面接近零。

### 2-C：执行顺序提示

**先删 Storybook 再升 vite**。删掉后 `@storybook/react-vite` 对 vite 4/5 的 peer 约束消失，批次 3B 的 vite 升级路径会干净很多；`esbuild GHSA-67mh-4wv8-2f99` 的 effects 里也明确列着 `@storybook/builder-manager` / `@storybook/core-common`。

### 2-D：验证

```bash
cd backend  && npx tsc --noEmit -p tsconfig.json && npm run build
cd frontend && npm run build     # dist 体积应基本不变（这些包本来就不进 bundle）
# audit 复核必须带官方源！本机默认 registry 是 npmmirror，它对 audit 端点返回
# 404 [NOT_IMPLEMENTED]，不加参数会得到"没有漏洞"的假象
npm audit --registry=https://registry.npmjs.org
```

> **这条 registry 提醒请写进 README 和 CI 脚本**，它是本次审计中最容易导致误判的一个环境陷阱。

---

## 六、批次 3：版本升级

### 3A：patch 级安全升级（全部在已声明 semver 范围内，`npm update` 即可）

这一批的共同点是：修复版本**早就在 package.json 声明的 caret 范围内**，只是 lockfile 停在 4 个月前（backend 的 `package-lock.json` mtime = 2026-04-26）。等于"一次干净的 npm install 本来就会得到的结果"。

| 原编号 | 包 | 当前 → 目标 | 收益 |
|---|---|---|---|
| #36 / #37 | typeorm 及 backend 15 个包 | 0.3.28 → 0.3.31 等 | GHSA-9ggv-8w38-r7pm 等，4 个月上游补丁 |
| #21 | bcrypt | 5.1.1 → 6.0.0 | 根除全项目唯一 CRITICAL（tar 链 12 条公告） |
| #8 | axios | 1.15.2 → 1.19.0 | 18 条公告（7 HIGH / 10 MODERATE / 1 LOW） |
| #41 | echarts | 6.0.0 → 6.1.0 | GHSA-fgmj-fm8m-jvvx（XSS） |
| #42 | postcss / react-router-dom（frontend） | 8.5.10 → 8.5.26 / 6.30.3 → 6.30.6 | postcss 3 条全清，router 2/4 条 |
| #43 / #45 | postcss / nanoid（portal） | 8.5.10 → 8.5.26 / 3.3.11 → 3.3.18 | postcss 4 条 + nanoid 2 条 |
| #9 | next（portal） | 14.2.5 → 14.2.35 | 33 条 → 21 条，critical 1 → 0 |

**命令**：
```bash
cd backend
npm update --registry=https://registry.npmjs.org   # ← 必须用官方源，否则 aws-sdk 会被 npmmirror 的
                                                    #    陈旧版本视图往回降一个版本（若 2-A 已删则无所谓）
npm i bcrypt@^6.0.0

cd ../frontend
npm i axios@^1.19.0 echarts@^6.1.0
npm i -D postcss@^8.5.26
npm i react-router-dom@^6.30.6
# 同步抬高 package.json 下限，防止后续 npm i 回落：axios 改 "^1.19.0"

cd ../portal
npm i next@14.2.35 --save-exact    # package.json 是精确锁定，npm update next 不会动它
npm i -D postcss@^8.5.26           # 必须单独做，见下方说明
```

**四个必须说清楚的预期口径（都是原报告里被夸大或说错的地方）**：

1. **`npm i next@14.2.35` 消掉的是 12 条，不是 30 条。** 已在纯净工程实测：next advisory 33 → 21，critical 1 → 0，audit total 3 → 2。critical 归零的唯一来源是 `GHSA-f82v-jwr5-mffw`（9.1，middleware 授权绕过），而本项目根本没有 middleware 文件、该条当前不可利用。真正当下可打的是 7.5 档的 Server Components DoS（`GHSA-mwv6-3258-q52c` / `GHSA-5j59-xgg2-r9c4`）和缓存投毒（`GHSA-gp8f-8m3g-qvj9`）。

2. **`npm i next@14.2.35` 不会带动内部 postcss。** `next@14.2.35` 精确 pin `"postcss": "8.4.31"`（已实测），升完 audit 里 postcss 依旧 4 条、fixAvailable 跳到 `next@16.3.3`。所以顶层的 `npm i -D postcss@^8.5.26` 必须单独做。若要连 next 内嵌那份也清掉（仅当 CI 有 `--audit-level=high` 门禁时才值得），在 `portal/package.json` 加 `"overrides": { "postcss": "^8.5.26" }`，但因为是强行覆盖 Next 的 pin，必须跑完整 `npm run build` 并肉眼比对 CSS 产物。

3. **`npm i react-router-dom@^6.30.6` 不会让 audit 清零。** 只能消掉 `GHSA-jjmj-jmhj-qwj2` 和 `GHSA-2j2x-hqr9-3h42` 两条；`GHSA-wrjc-x8rr-h8h6` 和 `GHSA-337j-9hxr-rhxg` 的 range 都是 `<7.18.0`，6.x 线上没有任何版本能修。**建议留着并登记例外**，依据是已核实的事实：全部 `navigate`/`Navigate` 目标为静态字面量或数字 id 模板；侧栏菜单 key 来自 `MainLayout.tsx:72/80` 的**文件内静态数组**而非后端 Menu 接口（这点专门查过，因为项目有 Menu CRUD 模块，如果 key 来自后端就会变成真实开放重定向）；项目为纯 CSR，`GHSA-337j` 的 SSR hydration 路径不存在。把这个结论写进 `CLAUDE.md`，避免下次审计重复纠结。

4. **bcrypt 6 有一个部署侧前置验证**：它改用 prebuild/node-gyp-build 分发，而 Dockerfile 用的是 `node:20-alpine`（musl）。**必须先在本地 `docker build` 一次确认能拿到 musl 预编译包**——builder 阶段没装 python3/make/g++，回落源码编译会直接失败。Node 版本前提满足（本机 24.15、镜像 20，engines 要求 `>= 18`）。API 完全兼容，已有 `$2b$` 哈希继续可验证，DB 里的密码无需重算。

**工时**：0.5 人日（不含 bcrypt 的 docker build 验证）。

**验证**：
```bash
cd backend
npx tsc --noEmit -p tsconfig.json
node -e "const b=require('bcrypt'); b.compare('x', b.hashSync('x',10)).then(console.log)"   # true
node scripts/seed-admin.js --dry-run 2>/dev/null || echo "手工确认 seed-admin 可 require"
cd ../frontend && npm run build      # 然后浏览器打开 Dashboard 确认折线图/饼图正常、console 无报错
                                     # 手动走：登录 → 跳首页 → 侧栏切页 → 401 自动登出
cd ../portal && npm run build        # 冒烟访问 9 个动态路由
```

---

### 3B：major 级升级（每项独立分支，本轮多数跳过 —— 详见第七节）

| 原编号 | 升级 | 本轮建议 |
|---|---|---|
| #7 | vite 4.5.14 → 6.4.3（frontend） | **做**，但排在批次 2 删完 Storybook 之后 |
| #22 / #46 / #47 | ESLint 8 → 9 + flat config（三个子项目） | **做一半**：先补配置让 lint 能跑，暂不升 v9 |
| #20 | NestJS 10 → 11 全家桶 | **跳过本轮** |
| #28 | Next 14 → 16 | **跳过本轮**，登记为下一轮首要项 |
| #23 | vitest 0.34 → 4.x + 建立测试基线 | **决策点**，见批次 4 |

**#7 vite 升级的正确姿势（原报告的临时缓解措施两条都是错的，别照做）**：

```bash
cd frontend
npm i -D vite@^6      # 解析到 6.4.3
npm run build         # 验证
```
- **一步到位 `^6` 即可，不需要分两步。** 7 条公告里 range 最高的是 `<=6.4.2`，6.4.3 全部覆盖。
- **不需要动 `@vitejs/plugin-react`**：实装 4.7.0，peer 是 `vite: ^4.2.0 || ^5.0.0 || ^6.0.0 || ^7.0.0`，直接兼容。
- **不需要改 Dockerfile**：`vite@6.4.3` engines 是 `node: ^18 || ^20 || >=22`，`node:20-alpine` 满足。（只有升到 vite 8 才要 `^20.19.0 || >=22.12.0`。）
- **esbuild `GHSA-67mh-4wv8-2f99` 不需要等 vite 8**：vite 6 的 esbuild 是 `^0.25.0`，已高于公告 range `<=0.24.2`。
- **两条常见的"临时缓解"是无效的**：`server.host: '127.0.0.1'` 没用（vite 4 默认就绑 localhost，而攻击是恶意网页从本机浏览器发起跨源请求打 localhost:5173）；"显式关闭 editor 集成"这个配置项不存在（已读打包后的中间件链，`/__open-in-editor` 是无条件 `middlewares.use` 挂载的）。若因故无法立即升级，唯一可行的临时缓解是在 `vite.config.ts` 的 plugins 数组**首位**加：
  ```ts
  { name: 'block-open-in-editor', configureServer(server) {
      server.middlewares.use('/__open-in-editor', (_req, res) => { res.statusCode = 403; res.end() })
  }}
  ```
- **为什么值得做**：这几条漏洞全部命中 Windows（团队开发机是 Windows 11）。开发者跑 `npm run dev` 期间，浏览器访问任意恶意网页即可触发 launch-editor 命令注入，在开发机上执行任意命令；`server.fs.deny` 反斜杠绕过让任意站点读取项目根目录外的本地文件；UNC 路径处理还能外泄 NTLMv2 哈希。**这是开发者工作站被直接接管的路径，不是生产运行时问题**——生产构建产物本身不受影响。

**#22/#46/#47 lint 配置（三条是同一类问题，合并处理）**：

三个子项目都装了整套 ESLint 工具链却没有任何配置文件，`npm run lint` 全部退出码 2（portal 更彻底，连 eslint 都没装）。**本轮只做"让它能跑"，不升 ESLint 9**，因为：`eslint-plugin-tailwindcss` v3 不兼容 ESLint 9 flat config，且首轮清理成本高（frontend 61 个源文件、backend 116 个源文件从未 lint 过）。

分步：
1. **backend**：新建 `.eslintrc.js`（NestJS schematic 标准版），**务必加 `root: true`**（否则 ESLint 会向 `F:/METU` 及更上层回溯查找配置，行为不可预测；已确认上层无任何共享配置兜底）。
2. **先补 `.prettierrc` 再跑 lint** —— 这一步比看起来重要：`extends` 里的 `plugin:prettier/recommended` 会把"与 Prettier **默认值**的差异"全部当成可自动修复的 error，而仓库里没有任何 prettier 配置。首次 `--fix` 会按 `singleQuote: false` 等默认值重排全部 116 个源文件。
3. **把 `backend/package.json:15` 的 `"lint": "eslint \"src/**/*.ts\" --fix"` 拆成只读的 `lint` 和显式的 `lint:fix`**（frontend 已经是这种写法，可参照 `frontend/package.json:14-15`）。当前这个带 `--fix` 的脚本一旦有人补上配置后首次运行，会在毫无预期的情况下批量重写全部后端源码。
4. **frontend**：新建 `.eslintrc.cjs`，同样加 `root: true`，extends 顺序 `['eslint:recommended','plugin:@typescript-eslint/recommended','plugin:react-hooks/recommended','prettier']`（prettier 必须最后）。首次摸底用命令行覆盖阈值：`npx eslint src --ext ts,tsx`（不带 `--max-warnings 0`），**不要改 `package.json:14` 的阈值**（改了容易忘记改回）。`eslint-plugin-tailwindcss` 要么加上 `plugin:tailwindcss/recommended` 启用，要么删掉，别留幽灵依赖。
5. **portal**：`npm i -D eslint eslint-config-next` 或者干脆删掉 `package.json:10` 的 `"lint": "next lint"`。
   > 澄清一个曾被误报的点：`next lint` 在非交互环境下**不会挂起**，实测 EXIT=1 / ELAPSED=1s（两种非 TTY 场景都是），加进 CI 是正常的 fail-fast 而非卡死 20 分钟。所以这条与 backend/frontend 属于同一类问题，不需要特殊对待。
6. **首轮报错清理必须人工判断**：`lint:fix` 先自动修一轮，剩下的 `react-hooks/exhaustive-deps` 盲目按提示补依赖数组可能引入无限重渲染。frontend 有 27 个文件在用 `useQuery`/`useMutation`，这正是最需要人工过目的部分。
7. 清理完再考虑接进 CI（批次 0 的门禁里刻意没放 lint）。

**工时**：vite 升级 0.5 人日；lint 配置 + 首轮清理 1.5–2 人日。

---

## 七、明确"先别动"的部分

以下项**本轮跳过**，理由逐条写明。跳过不等于不重要，而是当前投入产出比不合适或缺少前置条件。

### 1. NestJS 10 → 11 全家桶（原 #20）

**跳过理由**：这是本轮唯一的大工程，且**目前是零安全网状态**——`npm test` 实测 `No tests found, exiting with code 1`，`src` 下 116 个文件零个 `.spec.ts`，`test:e2e` 指向的 `./test/jest-e2e.json` 连目录都不存在（package.json 里那个 80% `coverageThreshold` 是摆设）。迁移面包括 Express 4→5（路由通配符 `*` → `*splat`）、`@nestjs/throttler` 6（配置结构变化 + ttl 单位改毫秒）、`@nestjs/config` 4、`@nestjs/schedule` 6。

**它主要挡着什么**：`multer` 的彻底解决（platform-express ≥ 11.1.28 才带 multer 2.2.0；11.1.24-11.1.27 仍是受影响的 2.1.1）、以及 `@nestjs/schedule → uuid@9.0.1` 那条 cvss 7.5。**但批次 1-D 的 `overrides` 已经把 multer 顶到 2.2.0**，所以最紧迫的那部分已被覆盖。

**前置条件**：为 auth（登录/logout/黑名单）、user（缓存）、media（上传）三条关键路径补最小回归测试，再动主版本。**没有测试就不要碰。**

**反面证据（好消息）**：`npm ls --all` 无任何 invalid peer；`@nestjs/typeorm@11.0.1` 声明 `^10.0.0 || ^11.0.0`、`@nestjs/cache-manager@3.1.2` 声明 `^9 || ^10 || ^11`，两者已为 11 准备好，届时无需改动。

### 2. Next 14 → 16（原 #28）

**跳过理由**：迁移量已量化——13 个文件共 **47 处** 同步访问 `params.` / `searchParams.`，全部会在 Next 15 的 async params 下报错；另有 10 个文件的 `generateMetadata` 要改；`lib/api.ts:45` 的 `revalidate = 30` 在 Next 15+ 新缓存默认语义下需重新验证；rewrites 行为变化（若批次 1-C 已删除则无需）。工时 1-2 人日，**且必须有构建门禁 + 完整回归（9 个动态路由 / 分页 / 播放页 / 评论）才能上线**。

**代价评估**：升 14.2.35 后仍剩 21 条 advisory 无补丁（含 `GHSA-c4j6-fc7j-m34r` CVSS 8.6 的 WebSocket upgrade SSRF、`GHSA-wfc6-r584-vfw7` RSC 缓存投毒），且 Next 14 线的安全回溯已经停了（`npm view next dist-tags` → `next-14: 14.2.35` 是终点，backport 只做到 15.5.24）。**这确实是个必须做决策的岔路口，但不是本轮**——批次 0 都还没落地，先把能部署这件事解决。

**登记为下一轮首要项**，并纠正两个常见误解以免届时走弯路：
- **React 19 不是硬前提**：`npm view next@16.3.3 peerDependencies` 实测接受 `react ^18.2.0 || ^19.0.0`。建议先只升 Next、保持 React 18.3.1 跑通，把 React 19 作为独立的第三步。
- **`react-markdown` 不必为此升到 10**：9.1.0 的 peer 已是 `react >=18`。
- 迁移用 `npx @next/codemod@latest next-async-request-api .`，但 13 个文件的 codemod 结果必须人工复核。
- 运行环境满足：`next@16.3.3` engines = `node >=20.9.0`，`node:20-alpine` OK。

### 3. React 18 → 19（frontend 与 portal）

**跳过理由**：与 Next 16 耦合，且会同时引入 `@types/react` 18→19、antd / react-markdown / rehype-highlight / hls.js 的兼容验证。两个大版本变量不应耦合在一次发布里。

### 4. vite → 8（原 #7 的 fixAvailable 指向）

**跳过理由**：升到 6.4.3 已经清掉全部 7 条公告。vite 8 会把 Node 下限抬到 `^20.19.0 || >=22.12.0`，需要同步改 `Dockerfile:4` 为 `node:22-alpine`。没有安全收益却引入部署变量，不值得。

### 5. react-router-dom → 7.18.0

**跳过理由**：为两条**已确认当前不可利用**的 MODERATE（`GHSA-wrjc` / `GHSA-337j`）付一次带 breaking change 的大版本迁移（数据路由 API、future flags）不划算。**登记例外并写进文档**即可。
**触发条件（写进文档）**：一旦引入任何从查询参数或后端数据读取跳转目标的逻辑（登录后 `returnUrl`、后端驱动的动态菜单），这两条立刻变成真实风险，届时 v7 迁移变为必须。

### 6. `strictNullChecks` / `noImplicitAny` 全面开启（原 #48）

**跳过理由**：开启 `strictNullChecks` 属于编译期 breaking——会让当前能过的构建立刻失败，实测产生 **20 个 error**（`configuration.ts` 8、`user.service.ts` 5、`auth.service.ts` 4、`collect-source.service.ts` / `jwt.strategy.ts` / `database.config.ts` 各 1）。必须一次性改完才能合入，应作为独立 PR。

**好消息（值得记录）**：本轮新增代码是干净的——`watch-history` 整个模块、`collect-cleaner.ts`、`poster-checker.service.ts` 在开启 `strictNullChecks` 后**零报错**。所以这不是"新债"，是历史债。

**将来做的时候注意一个陷阱**：不要把 `configuration.ts:7` 的 `parseInt(process.env.APP_PORT, 10) || 3000` 改成 `parseInt(process.env.APP_PORT ?? '3001', 10)` —— 尾部已有 `|| 3000` 兜底，那样写会让同一个默认值出现在两个位置。**保持语义完全不变的最小改法是兜底放空串**：`parseInt(process.env.APP_PORT ?? '', 10) || 3000`（`''` 经 parseInt 得 NaN，仍走原分支，运行时逐字节一致）。9 处同理。

### 7. 完整测试基建（原 #23 的方案 A）

**跳过理由**：这是"从零建立"而非"补一个测试"，工时 large。但**它是 NestJS 11 / Next 16 迁移的硬前置**，所以不能无限期跳过。见批次 4 的决策点。

### 8. 对象存储迁移 / Prisma 迁移

**跳过理由**：路线图上没有既定计划就不要留着占位依赖。若确有 S3 计划，保留 `@aws-sdk/client-s3`（9MB）只删 `aws-sdk` v2（99MB）也能拿到九成收益；后续接 S3 只装 v3 子包，**绝不回引 v2**。

---

## 八、批次 4：半成品收尾与质量基建

### 4-A：Phase 1-A 的两个坏功能（站长点下去结果是错的）

| 原编号 | 问题 |
|---|---|
| #33 | 后台"封面状态"筛选三个选项全部失效 |
| #34 | `PosterCheckerService.batchCheck()` 和 `/movies/broken-posters/list` 都无调用方 |

**#33 的正确修法（不要改 DTO 为 class）**：原方案想把 `QueryMovieDto` 从 interface 改成 class，但那会让 `main.ts:54-55` 的 `whitelist:true / forbidNonWhitelisted:true` **首次真正介入这条路由**，`page`/`limit` 还需要 `@Type(() => Number)` 配合，回归面很大——为修一个下拉筛选不值当。

改成字符串枚举，前后端各改几行、零风险：
- `frontend/src/pages/Movie/index.tsx:117-120`：直接把 `filters.posterBroken` 原样传下去（`'broken' | 'ok' | 'unchecked' | undefined`），不要再映射成 boolean/null。
- `frontend/src/api/movie.ts:74`：`posterBroken?: boolean | null` → `posterBroken?: 'broken' | 'ok' | 'unchecked'`。
- `backend/movie.service.ts` 的 `QueryMovieDto` 同步改类型，`findAll` 改显式分支：
  ```ts
  if (posterBroken === 'unchecked') qb.andWhere('m.posterBroken IS NULL');
  else if (posterBroken === 'broken') qb.andWhere('m.posterBroken = 1');
  else if (posterBroken === 'ok')    qb.andWhere('m.posterBroken = 0');
  ```
- 顺带修 `movie.service.ts:187-189` 的 `isFeatured`/`isVip` 同一个坑（字符串 `'true'`/`'false'` 与 TINYINT 比较都会被 MySQL 转成 0，两个选项返回同样结果）。目前 `getMovies` 没传这两个字段，属潜伏问题，`String(x) === 'true'` 归一化即可。

**#34 的关键更正**：原方案"加 @Cron 每天扫 200 条"**解决不了它自己声称要解决的问题**。`poster-checker.service.ts:29-33` 的 where 是 `posterBroken: IsNull()`，只捞从没检测过的行——挂上 cron 后存量 backlog 排空就再也扫不到东西了，它是**一次性回填**不是周期复检。
- 想回填存量 → 加手动触发接口 `@Post('movies/posters/batch-check') @UseGuards(AuthGuard('jwt'))`，前端在筛选栏加按钮，先用 `limit=20` 灰度确认出网策略与图床限流。
- 想周期复检 → 必须先给 movie 实体加 `posterCheckedAt`，where 改为 `posterCheckedAt IS NULL OR posterCheckedAt < :cutoff`。这又是一次 schema 变更，要和下面 4-C 合并。
- 确定不做 → 删干净：`poster-checker.service.ts:28-58`、`movie.controller.ts:60-66`、`movie.service.ts` 的 `findBrokenPosters`、`frontend/src/api/movie.ts:214-217`。

**工时**：0.5 人日。

### 4-B：Phase 2-A 别名搜索（写了一半，纯负债）

原编号 #32。`aliases` 列每条采集都在写（`collect-executor.service.ts:262`），但**全代码库零处读取**——`movie.service.ts:177` 的搜索条件仍是 `title/originalTitle/director/actors`，没有 aliases。roadmap.md:230-236 明确要求加 `m.aliases LIKE :s`。后台既看不到也改不了这个字段。

最小闭环（比原方案多补前端两处）：
1. `movie.service.ts:174-179` 搜索条件加 `OR m.aliases LIKE :s`。
2. `movie.service.ts` 的 `CreateMovieDto` 加 `aliases?: string`（它是 interface，ValidationPipe 不介入，加字段即可透传）。`QueryMovieDto` 不需要加——别名是搜索内容不是筛选维度。
3. **前端要改两个文件**：`frontend/src/api/movie.ts` 的 `CreateMovieData` interface 加 `aliases?: string`（否则 TS 会拦下），再在 `frontend/src/pages/Movie/MovieForm.tsx` 加 `<Form.Item label="别名" name="aliases">`。

**若选回滚路线**：删掉 entity 里的列后生产库那一列不会自动消失（DB_SYNC 已关），需手写 `ALTER TABLE movies DROP COLUMN aliases`，等于又是一次 schema 变更，必须和 4-C 一起排期。novels/comics 建议直接从 roadmap 划掉，不要为了"一致性"再加两张表的死列。

**工时**：0.5 人日。

### 4-C：schema 变更批次（必须一次做完，不要分次改表）

把下面三件合并成**一次** migration，并在此之前先生成 migration 基线：

1. **建立 typeorm migration 基线**（批次 0 步骤 0.3.5 的延续）：先确保库结构与实体对齐，再 `npx typeorm migration:generate` 产出首版 schema，**人工逐条 review**（否则会生成一堆 DROP），纳入镜像/启动流程，最后把 `database.module.ts:41` 改成 `synchronize: !isProd`。
2. **#56 watch_history 唯一约束**：加 `ownerKey` 列（`userId ?? 'g:' + guestId`，写入时计算）→ 清理线上重复行（按 `ownerKey+contentType+contentId` 保留 `updatedAt` 最新的一条）→ 建 `@Unique(['ownerKey','contentType','contentId'])` → report 改用 `repo.upsert(record, { conflictPaths: [...] })`。
   > MySQL 唯一索引不去重 NULL，现有 `userId`/`guestId` 二选一为 NULL 的设计没法直接加联合唯一键，`ownerKey` 是正确解法。
   > 进度回退保护用 `GREATEST` 时注意：**换集场景（epIdx/srcIdx 变化）需要覆盖而不是取大值**，否则换集后进度会被旧集的大值卡住。
3. **#34 的 `posterCheckedAt` 列**（如果决定做周期复检）。

**可以先上的零风险部分（#56 第一步）**：`watch-history.service.ts` 的三个 `findOne` 全部加 `order: { updatedAt: 'DESC' }` —— 不只是 `findProgress()` 的 :90 和 :93，**`report()` 里 38-46 行的那个也要加**，否则并发产生重复行后 report 可能一直在更新旧记录，进度看起来永远不涨。

**工时**：1–1.5 人日（含线上数据清理）。

### 4-D：开发体验与文档

| 原编号 | 问题 | 修法 |
|---|---|---|
| #55 | portal 续播请求硬编码 `/api/v1`，本地 dev 必然 404 且被静默吞掉 | 在 `portal/lib/api.ts` 导出 `API_BASE`（或封装 `getWatchProgress`/`reportWatchProgress`），`ResumeButton.tsx:53` 与 `PlayClient.tsx:77` 改用它 |
| #27 | Dashboard chunk 因整包引入 echarts 达 1.15MB（gzip 383KB），只用了折线图和饼图 | 改 `echarts/core` 按需注册 |
| #57 | roadmap.md 三个半月没更新，与代码事实严重脱节 | 更新总览表 + 加"当前实际状态"摘要 |

**#55 的一个更正**：不用担心"改成绝对地址会把生产改挂"。`docker-compose.prod.yml:139-141` 的 `NEXT_PUBLIC_API_BASE: ${DOMAIN}` 就是站点自己的公网域名，浏览器侧改成绝对地址后生产依然同源，不引入跨域。真正需要配的只有本地开发：`.env` 里把 `http://localhost:3000` 写进 `CORS_ORIGIN`。等价路径是改走已有的 `/proxy-api` 前缀，dev/prod 都能通且完全不涉及 CORS，改动更小——但那与 1-C 删除 rewrite 冲突，二选一。
> 顺带解释了一个现象：这两个请求在本地 dev 下必然 404，上报被 `PlayClient.tsx:98-100` catch 静默吞掉、ResumeButton 静默降级成"立即观看"，开发者看不到任何报错——**这就是为什么整个 Phase 1-B 的问题一直没被发现**。

**#27 的执行顺序陷阱**：`manualChunks: { echarts: ['echarts'] }` **在改用 core 入口之前加是无效的**——当前 src 里根本没有 `from 'echarts'`，入口是 `echarts-for-react`，manualChunks 按模块 id 匹配不到边界。正确顺序：先改 `src/pages/Dashboard/index.tsx:29` 为按需注册（`LineChart/PieChart` + `TooltipComponent/LegendComponent/GridComponent` + `CanvasRenderer`），两处 `<ReactECharts>`（:371、:380）补 `echarts={echarts}`，构建验证体积下降后再决定是否单独切 chunk。
> 量化依据：`node_modules/echarts/dist/echarts.esm.min.js` = 1,117,713 B，占该 chunk 1,149,950 B 的约 **97%** —— 这个 chunk 几乎就是一整个 echarts。根因是 `echarts-for-react/lib/index.js` 的 `var echarts = __importStar(require("echarts"))` 把命名空间对象整体挂到实例属性，rollup 无法 tree-shake。
> 一处措辞更正：Dashboard 是懒加载路由 chunk（`App.tsx:9` 是 `lazy()`），不是严格意义的"首屏"，真正的入口是 54kB 的 `index-*.js`。但它是登录后的落地路由，管理员每次登录必然立刻拉取，实践影响成立。
> **顺带澄清一个曾被误报的关联项**：nginx 是开了 gzip 的（`nginx/nginx.conf:31-32`、`nginx-ssl.conf:25-26`，`gzip_types` 同时含 `application/javascript` 和 `text/javascript`），且 frontend 容器没有 ports 映射、所有流量必经主 nginx。所以不存在"3.8MB 全裸传输"的问题，别去给 `frontend/nginx.conf` 加 gzip 修一个不存在的问题。（`vite-plugin-compression` / `vite-plugin-pwa` 确实装了但没接进 `vite.config.ts` —— 那只是两个约 333K 的死 devDependency，可在批次 2 顺手删掉。）

**#57 的标注要求（避免制造新的假信息）**：
- **1-A 不能只标 ✅**：要把"batchCheck 无调用方（存量封面永不检测）"和"后台封面筛选三个选项全错"写进 caveat，否则下一个人看到 ✅ 会直接跳过。
- **1-B 同理**：标出 watch-history 三条路由未验签这个安全缺陷。
- **2-A 要具体**：写"aliases 列 + 采集填充已完成（夹在 `138a802` 里），搜索条件 / 后台表单 / DTO / novels-comics 未做"，并引用 `roadmap.md:230-236`。
  > 这里有个容易漏掉的历史事实：Phase 2-A 的数据库列和采集填充是**混在 Phase 1-A 的提交里**进去的（`git log -S` 只命中 `138a802`），提交历史上完全看不出 2-A 已经开了个头——这是最容易被漏掉的部分。

**工时**：0.5 人日。

### 4-E：测试基建 —— 决策点（原 #23）

**必须现在拍板，二选一：**

**方案 A：做。** 
```bash
cd frontend
npm i -D vitest@^4 @vitest/ui@^4 jsdom @testing-library/react@^16 @testing-library/jest-dom
# 注意：@vitejs/plugin-react 已装 4.7.0，不要重复安装
```
`vite.config.ts` 加 `test: { environment: 'jsdom', globals: true, setupFiles: './src/test/setup.ts' }`；e2e 侧补 `playwright.config.ts` + `npx playwright install chromium`。首批优先覆盖 `src/api/client.ts:26-35` 的 401 清理跳转逻辑和 `src/stores/authStore.ts` 的 token 生命周期。backend 侧先为 auth / user / media 三条路径补最小回归。
> 风险在工时而非破坏性：vitest 0.34 → 4.x 跨 4 个大版本，但因为没有任何存量测试和配置，等于全新接入，无迁移包袱。`@testing-library/react` 要与 React 18 对齐（`^14` 或 `^16`，不要装为 React 19 准备的版本）。

**方案 B：不做，删干净。**
```bash
cd frontend && npm rm vitest @vitest/ui @playwright/test   # 顺带删 package.json:18-22 五个 script
```

**建议选 A，但只做最小集**。理由：一个 61 文件、26 个业务页面全 CRUD 的管理后台 + 一个内容门户，自动化测试覆盖率是 0；而 NestJS 11 和 Next 16 两个必做的大版本迁移都以"有回归网"为前提。**不要为了消 audit 告警去单独升 vitest**——那条 CRITICAL 的触发条件是 `vitest --ui` 服务在监听，零测试文件时永不可达。

---

## 九、执行节奏建议

| 周次 | 内容 | 里程碑 |
|---|---|---|
| 第 1 周（前 2 天） | **批次 0** 全部 | 发布链路恢复；`docker compose build` 三端全绿；生产 DB_SYNC 关闭；CI 门禁生效 |
| 第 1 周（后 3 天） | **批次 1** 的 1-A / 1-B / 1-C | 认证吊销真正可用；限流按 IP 生效；portal 攻击面收敛 |
| 第 2 周（前 2 天） | **批次 1** 的 1-D / 1-E + **批次 2** 全部 | audit 报告从几十条噪音降到可读；镜像瘦身约 300MB |
| 第 2 周（后 3 天） | **批次 3A** + vite 6 升级 | 全部范围内的安全补丁落地；唯一 CRITICAL 消除 |
| 第 3–4 周 | **批次 4**（含 lint 配置与首轮清理） | 半成品收尾；migration 基线建立；质量门禁补齐 |
| 下一轮 | Next 16 迁移（优先）→ NestJS 11 | 需先有测试基线 |

**最后一条提醒，写进 README 和 CI 脚本**：本机默认 registry 是 `registry.npmmirror.com`，它**不支持 audit 接口**（实测 `404 [NOT_IMPLEMENTED] POST /-/npm/v1/security/advisories/bulk`）。所有 `npm audit` 必须显式加 `--registry=https://registry.npmjs.org`，否则会得到"没有漏洞"的假象。同一镜像源还会让 `npm update` 把 `aws-sdk` 往回降一个版本。这是本次审计中最容易导致误判的环境陷阱。