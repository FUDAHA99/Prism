# Prism CMS 优化路线图

> 从「maccms 替代品」到「明显更好的选择」
>
> 最后更新：2026-10-17

---

## 背景与目标

以重度 maccms v10 用户的迁移临界点为出发点，聚焦三类改动：

- **高价值改进**：解决 maccms 长期存在但无法修复的核心痛点
- **差异化功能**：做 maccms 生态里几乎没人做好的功能
- **体验细节**：让竞品在对比中显得落后

**用户迁移的两个关键杠杆**：
1. 采集数据质量（站长最痛的点）
2. 用户数据留存（续播记录让用户走不掉）

---

## 总览

| 阶段 | 主题 | 优先级 | 预计工期 |
|------|------|--------|--------|
| Phase 1-A | 采集数据自动清洗 | 🔴 最高 | 2 天 |
| Phase 1-B | 续播记录系统 | 🔴 最高 | 3 天 |
| Phase 2-A | 别名搜索增强 | 🟠 高 | 1 天 |
| Phase 2-B | 采集 SSE 实时进度 | 🟠 高 | 2 天 |
| Phase 3-A | 线路健康度检测 | 🟡 中 | 2 天 |
| Phase 3-B | 搜索词统计 | 🟡 中 | 1 天 |

上表为原始阶段划分与估算，不是当前完成状态。当前已核对的范围：

- **Phase 1-B**：门户续播、开发路由、数据库迁移与并发一致性已经完成本地验证，见[维护记录](maintenance-plan.md)。
- **Phase 2-A（仅影视）**：既有别名字段与采集填充已接通后台编辑、输入校验和列表搜索，验收范围见下节。
- **Phase 2-B**：采集详情接入 SSE 统计快照、断线恢复和终态日志刷新；补充同源互斥及重启中断状态处理。适用单后端进程，本地验证记录见[维护记录](maintenance-plan.md)。
- **Phase 3-A（首批）**：后台单线路手动 HTTP 诊断已实现，结果仅保留在当前页面；持久化、巡检及自动切换留待后续设计，本地验收见[维护记录](maintenance-plan.md)。
- **Phase 3-B**：现状核查完成，搜索入口和统计尚未实现；下一批先补影视门户搜索入口，再接入明确提交动作的次数榜，见下节。
- **封面三态筛选**已在此前修复；历史维护计划中的“筛选失效”不是当前待办。
- 其他阶段下文仍保留设计方案，不能据此推断已实现或已部署。小说 / 漫画别名不纳入本次范围。

---

## Phase 1-A：采集数据自动清洗

### 目标
采集入库的数据做自动清洗，消除脏标题、广告简介、挂掉的封面图。

### 新增文件

**`backend/src/modules/collect/collect-cleaner.ts`**

纯函数工具集，无副作用：
```
cleanTitle(raw: string): string
  - strip 正则：/【[^】]*】|\[[^\]]*\]|（[^）]*）/g
  - strip 分辨率标签：/\b(720|1080|4K|HDR|BD|BluRay|WEB-DL|中字|国语|粤语|字幕组)\b/gi
  - trim 首尾空格和特殊符号

cleanIntro(raw: string): string
  - 命中广告词（"本站","www.","http","复制网址","官方"）时截断
  - 超过 2000 字截断

cleanActors(raw: string): string
  - split(',') → trim → 过滤空串 → 去重 → rejoin

isValidImageUrl(url: string): boolean
  - 检查协议是否 http/https
  - 排除已知挂掉域名黑名单
```

**`backend/src/modules/collect/poster-checker.service.ts`**

```
checkAndMark(movieId, url): Promise<void>
  - HEAD 请求，超时 5s
  - 失败 → movieRepo.update({ posterBroken: true })
  - 成功 → 确保 posterBroken = false

batchCheck(limit=100): Promise<void>
  - 查询 posterBroken IS NULL 且 posterUrl IS NOT NULL（最多 100 条）
  - 并发 checkAndMark（concurrency=10）
```

### 数据库变更

```sql
ALTER TABLE movies
  ADD COLUMN posterBroken  TINYINT(1) NULL     DEFAULT NULL COMMENT 'NULL=未检测，0=正常，1=异常',
  ADD COLUMN titleCleaned  TINYINT(1) NOT NULL DEFAULT 0   COMMENT '是否已做标题清洗';
```

TypeORM Entity 新增：
```ts
@Column({ type: 'tinyint', nullable: true, default: null })
posterBroken?: boolean | null

@Column({ type: 'boolean', default: false })
titleCleaned: boolean
```

### 改动现有文件

**`collect-executor.service.ts` → `upsertMovie()`**
- 构造 data 时接入清洗：`cleanTitle / cleanIntro / cleanActors`
- 置 `titleCleaned = true`
- 入库后异步触发 `posterChecker.checkAndMark()`（不阻塞主流程）

**`movie.controller.ts` 新增接口**
```
GET  /movies/broken-posters?page=1&limit=50   查询封面异常影片列表
PATCH /movies/:id/poster  body: { posterUrl }  更新封面并重置检测状态
```

### 管理后台改动

**`frontend/src/pages/Movie/index.tsx`**
- 筛选栏新增"封面状态"下拉（异常 / 正常 / 未检测）
- 列表新增封面状态图标列（红色警告 / 绿点 / 灰色未检测）
- 操作列新增"修复封面" → Modal 输入新 URL

---

## Phase 1-B：续播记录系统

### 目标
用户（含游客）播放进度持久化，详情页显示"继续看第N集"，形成用户数据留存。

### 新增数据库表

```sql
CREATE TABLE watch_history (
  id          CHAR(36)     PRIMARY KEY,
  userId      VARCHAR(36)  NULL     COMMENT '登录用户ID，游客为NULL',
  guestId     VARCHAR(64)  NULL     COMMENT '游客唯一标识（localStorage fingerprint）',
  contentType ENUM('movie','novel','comic') NOT NULL,
  contentId   VARCHAR(36)  NOT NULL,
  episodeId   VARCHAR(36)  NULL,
  srcIdx      INT          NOT NULL DEFAULT 0,
  epIdx       INT          NOT NULL DEFAULT 0,
  progressSec INT          NOT NULL DEFAULT 0 COMMENT '播放到第几秒',
  durationSec INT          NULL,
  updatedAt   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_user_content  (userId,  contentType, contentId),
  INDEX idx_guest_content (guestId, contentType, contentId),
  INDEX idx_user_recent   (userId,  updatedAt),
  INDEX idx_guest_recent  (guestId, updatedAt)
);
```

### 新增后端模块

新建目录：`backend/src/modules/watch-history/`
```
entities/watch-history.entity.ts
watch-history.service.ts
watch-history.controller.ts
watch-history.module.ts
```

**接口设计（无需 admin 权限，前台公开）**

```
POST /watch-history/report
  body: { contentType, contentId, episodeId?, srcIdx?, epIdx?, progressSec, durationSec?, guestId? }
  逻辑：有 JWT → 写 userId；否则写 guestId
  upsert：同 userId+contentId 或 guestId+contentId 冲突时更新
  规则：新进度 > 旧进度才更新（防止倒退）

GET  /watch-history?contentType=movie&contentId=xxx
  - 优先 JWT 查 userId，否则用 query.guestId
  - 返回：{ srcIdx, epIdx, progressSec, durationSec, episodeId }

GET  /watch-history/recent?limit=10
  - 最近观看列表（接口先备用）
```

### 前台改动

**播放页拆分为 Server + Client**

`portal/app/movies/[slug]/play/[srcIdx]/[ep]/page.tsx`（保持 Server Component，负责数据获取）
→ 渲染 `<PlayClient movie={movie} srcIdx={srcIdx} epIdx={epIdx} />`

`portal/app/movies/[slug]/play/[srcIdx]/[ep]/PlayClient.tsx`（新建，Client Component）
```
'use client'
- mount 时读/生成 localStorage cms_guest_id
- 每 15 秒调用 POST /api/v1/watch-history/report 上报进度
- 视频结束时立即上报
- 携带 Authorization header（读 localStorage access_token）
```

`portal/components/HlsPlayer.tsx` 改动
- 新增 prop：`onTimeUpdate?: (currentTime: number, duration: number) => void`
- 在 video timeupdate 事件里调用

**详情页"继续看"按钮**

`portal/app/movies/[slug]/page.tsx`（Server Component，新增）
```tsx
<ResumeButton movieId={movie.id} movieSlug={movie.slug} />
```

`portal/components/ResumeButton.tsx`（新建，Client Component）
```
mount 时 GET /api/v1/watch-history?contentType=movie&contentId=xxx
progressSec > 30：显示"▶ 继续看第 N 集（mm:ss）"，跳转播放页并传入时间戳
否则：显示"▶ 立即观看"（原逻辑）
```

---

## Phase 2-A：别名搜索增强

### 当前范围（仅影视，本地实现）

`movies.aliases` 已有 nullable `varchar(1000)` 列，采集的 `upsertMovie()` 已通过
`buildAliases(cleanedTitle, it.vod_sub)` 填充。本批直接使用已有字段，不改表，也不新增小说或漫画字段。

- 列表搜索将 `aliases LIKE :s` 加入与标题 / 原名 / 导演 / 主演相同的括号 OR 条件，继续使用绑定参数。
- 新建和编辑 DTO 接受 ≤ 1000 字符的原始字符串；拒绝数字、布尔、数组、对象及超长值。
  更新时省略字段保留原值，`null` 或空串清空；其余内部字段继续禁止客户端写入。
- 后台表单回填、修改、保存和清空别名，API 类型同步，搜索提示列出别名。
- 公开查询沿用发布时间、发布状态和软删除限制；公开响应仍不返回 `aliases` 字段。

### 验收与边界

验证别名独立命中、分页和组合筛选、管理员 / 编辑与普通用户 / 游客的不同可见范围，
以及表单回填、保存后重开、清空、新建和搜索操作。测试证据见[维护记录](maintenance-plan.md)。
本批只做本地验证与提交，不代表已部署到服务器。

不改分词、模糊匹配规则或采集覆盖策略；再次采集仍可能用上游别名覆盖手工值。
小说 / 漫画别名另行规划，不执行旧草案中的两个新增列语句。

---

## Phase 2-B：采集 SSE 实时进度

### 当前实现（2026-10-17，本地）

- 任务详情使用带 Bearer 头的 fetch 读取 SSE，替换原 2 秒详情轮询。显示已处理条数、当前页与分类统计；
  成功率单独展示，不再把它当完成百分比。日志列表仍每 3 秒刷新运行中记录，展示已保存的统计。
- `GET /api/v1/collect/logs/:id/stream` 继承全局管理员鉴权。运行任务按 logId 隔离，保留一个最新快照，
  开始、每 10 条、开始请求新页和页末推送；失败 / 跳过条目也计入已处理数。重新连接立即获取最新快照。
- 执行收尾时，最终日志与现存源统计的事务提交成功后推送 `done` 并结束监听，前端重新读取最终详情及列表。任务完成后删除内存状态；
  客户端关闭抽屉、切换任务或离开页面只取消监听，后台采集继续。
- 每条连接最多 30 秒，10 秒发送一次心跳；下一条连接重新检查 token 和当前角色，已建立连接的鉴权变化
  最迟在 30 秒内收口。网络 / 5xx 连续失败最多重试 3 次，单次连接 45 秒超时，401 / 403 / 404 停止重试。
- 已保存终态（含历史任务和重启恢复的记录）可直接回放。数据库仍为 `running` 但当前进程没有任务，或收尾事务未确认提交时返回
  `unavailable` 并停止自动重连，界面显示说明，不伪造完成或失败状态。

本批不新增依赖、数据库字段、持久化任务队列或跨实例消息。重启不会恢复采集任务，过程快照不入库，
不支持在多个后端实例间任意切换连接。协议详见 [API 文档](api.md)。

### 任务可靠性补充（单后端进程）

- 同源任务从创建日志到源统计收尾期间互斥，重复启动返回 `409`；不同源可并行。
  累计采集数通过数据库增量更新，不再用任务开始时的旧快照覆盖。
- 终态日志、现存源累计数与最近运行时间一起提交；收尾事务不包含已入库内容，也不自动重试增量。
  提交前中断回滚收尾写入；提交成功但通知前中断，重连回放已保存终态，重启不再次累加。
- 启动接受请求前，将遗留 `running` 日志改为 `failed` 并注明中断；保留已有计数和耗时，
  不假定这些统计完整，不回滚已入库内容，不自动续采或重跑。恢复写入失败则拒绝启动。
- 先停止旧实例再启动新实例；完成时间是确认中断的时间。核对日志与已入库内容后再手动重试。
- 编辑采集源只更新本次提交的配置字段，再回读最新统计及分类映射；不会用旧实体覆盖采集累计数、
  最近运行时间或级联回写映射。空补丁不写库，审计摘要只描述本次提交。此修复无需迁移。

---

## Phase 3-A：线路健康度检测

### 当前事实与原方案调整（2026-10-17）

本批新增检测服务、接口和后台入口，没有新增健康字段。`MovieSource` 保存线路信息，URL 在 `MovieEpisode`；
公开响应由 `movie.service.ts` 的白名单组装，新增实体列不会自动公开。

原设想“首集 HEAD 连续失败三次就隐藏整条线路”不作为当前实现要求：HEAD 405 的地址仍可能接受 GET，
HEAD 200 可能是 HTML 页面，首集正常也不能代表其他集正常。当前 `HlsPlayer` 根据 URL 后缀选择 HLS / 原生 video，
不根据 `source.player` 切换 iframe；此处也不新增 iframe 或解析器能力。

门户详情、播放页和续播记录依赖 `srcIdx` / `epIdx` 数组下标。直接过滤 `sources` 会改变现有链接和历史记录的目标；
现有手动切源跳到新线路第 1 集，不具备跨源剧集匹配。首批保持公开响应、线路顺序、播放器和续播行为。
另一个存量边界是 HTTP 下载线路也可能进入公开响应，因此检测目标必须显式判断 `kind='play'`，不能按门户是否显示判断。

### 首批：后台单线路手动 HTTP 诊断（本地实现，2026-10-17）

目标是让后台人员定位当前样本地址的请求问题。结果只表示服务端本次探测，不能命名为“已验证可播放”或“整条线路失效”。

- `POST /api/v1/movies/sources/:sourceId/check`，沿用影视管理 `staff` 权限（管理员 / 编辑）。
  服务端从数据库查找现存线路与未软删除的所属影视；不存在返回 404，且不发出站请求。请求不能指定任意 URL、请求头或批量目标。
- 只检查 `play` 线路，按 `episodeNumber ASC, id ASC` 选取一个确定的样本并返回样本 ID / 标题及检测时间。
  下载线路、空线路、非 HTTP(S) 绝对地址报告“不适用 / 无样本”；不猜测相对地址的站点，也不跳过首个样本改测其他集。
- 复用 `safeFetch` 发 HEAD，总超时 8 秒，最多 3 次重定向，每跳沿用地址 / DNS 校验；不携带后台登录凭据。
  首批不做 GET 回退、视频下载、HLS 分片 / 解码检测。HEAD 不受支持时如实报告无法判断。
- 同线路只允许一个在途检查，重复返回 409；进程内最多 4 个在途检查，满额返回 503，不排队、不增加调度依赖。
  所有完成和失败路径释放占用，保留现有请求限流。
- `MovieForm` 线路卡片增加检测按钮与本次结果，显示样本、时间、HTTP 状态或固定错误原因，明确“HTTP 响应不代表播放验证”。
  不回显上游响应体、完整 URL 或底层网络错误细节。刷新 / 离开页面即清除诊断，需要时重新检测。
- 结束前重查所属影视及同序抽样；检测期间若影视被删除，或线路、首样本、URL 改变，旧结果应标为过期或丢弃。
  删除 / 切换影视后不得把迟到结果展示到另一张卡片。
  不使用父线路 `updatedAt` 代替样本 URL 校验，因为编辑剧集不会更新父线路时间。

结果语义按实际观测区分：

| 观测 | 后台说明 | 不推断的内容 |
|---|---|---|
| HEAD 2xx | 本次 HTTP 响应正常，展示状态码 | 媒体格式、解码、全部剧集、浏览器 CORS 均未验证 |
| 401 / 403 / 405 / 501 | 访问受限或 HEAD 不受支持，无法判断播放情况 | 不计为整条线路失效 |
| 404 / 5xx 等非成功响应 | 样本请求返回异常状态，展示状态码 | 不自动隐藏或切换 |
| 超时 / DNS / TLS / 地址策略拦截 | 本次检测未完成，展示固定原因 | 不等于内容永久失效 |

**不新增数据库字段或 migration**：首批没有持久健康状态、连续失败计数和自动处置，
避免把抽样或过期结果保存为全线路结论。后台结果刷新后不保留是本批的明确取舍。

### 验收与交付边界

1. 真实 HTTP 夹具验证 2xx、HTML 200、401 / 403 / 405 / 501、404 / 5xx、超时与重定向；生产地址策略拦截内网且零出站请求。
2. 管理员 / 编辑可用，匿名 / 普通用户拒绝；不存在、软删除影视、下载线路、空线路、不支持地址按约定处理，不误发请求。
3. 同线路重复检查、总并发上限、失败释放占用；检测期间改 URL、改首样本、删剧集 / 影视或采集重建线路后，不展示迟到旧结果。
4. 后台按钮、加载状态、样本和原因可见，刷新清除结果；浏览器使用受控服务验收，不把模拟返回或 HTTP 2xx 当成真实播放验证。
5. 影视 / 采集的现有 CRUD、公开白名单与播放路径不变；新增路由纳入权限矩阵，并完成受影响测试及后端 / 后台构建。

接口返回结构见 [API 文档](api.md#159-单线路-http-诊断)。实现、受控验收和前期反例见[维护记录](maintenance-plan.md)。
本地受控 HTTP / SQLite / 浏览器检查不等于真实媒体播放、生产 MySQL 或部署验收。

### 后续批次

- 持久化结果与定时巡检需另定采样策略、结果过期 / 失效规则、调度互斥与负载上限，再追加 migration；不修改冻结基线。
- 门户若展示诊断，需要明确公开字段并接入已有缓存失效；显示提示不应改变原有下标。
- 自动隐藏 / 切换前先解决稳定定位、旧链接与续播兼容、采集重建后的目标匹配、缺集和重复集号、迟到进度上报。
  不直接实施原方案的过滤数组或跳到第一个“可用源”。

---

## Phase 3-B：搜索词统计

### 当前事实与统计口径（2026-10-17 核查）

基于 `a63f0c3`：没有搜索日志实体、迁移、聚合服务、统计接口或 Dashboard 关键词榜。
门户 Header 和列表没有搜索表单；影视、小说、漫画仅消费地址栏 `q`，文章列表未接入搜索。
影视已有标题 / 原名 / 别名 / 导演 / 主演搜索能力，因此先让门户访客能实际使用它。

原方案“所有 `findAll()` 有 search 就记一次”不作为实现要求：

- 后台四类列表按输入变化查询，还会因翻页、筛选及缓存失效重新取数；这些不是门户用户主动提交。
- 四类列表共用 optional-auth 接口，后台可搜草稿 / 归档 / 未到发布时间内容，公开视图只含已发布、到期、未删除内容。
  相同词在不同身份、类型和过滤条件下的结果总数不可混称“全站搜索结果”。
- 门户列表显式配置 30 秒 fetch revalidate，筛选与分页使用 Next Link；实际缓存命中和预取须在运行时观察，
  不能仅凭 `force-dynamic` 或服务端调用次数推断提交次数。普通列表读取不应增加统计副作用。
- `data.length` 是本页条数，`meta.total` 才是该次查询的匹配总数；第 99 页为空不代表没有匹配内容。
  小说 / 漫画查完总数后还会查询公开章节统计，此处失败也不能记作成功或零结果。
- 后台影视列表不读取 URL 的 `search` 参数，门户使用的是 `q`；原计划的 `/movies?search=...` 点击跳转不成立。
  小说 / 漫画分页目前还会丢掉 `q`，接入它们前需要单独修复。

相关入口：`portal/app/movies/page.tsx`、`portal/lib/api.ts`、`frontend/src/pages/Movie/index.tsx`、
四类后端 service 与 `backend/src/modules/stats/stats.controller.ts`。受控 HTTP 证据见[维护记录](maintenance-plan.md)。

### 下一批：先补影视门户搜索入口（待实现）

这是可独立交付的第一步，不要求同时改数据库或 Dashboard。

1. 在 `/movies` 增加带可访问标签的搜索框和提交按钮，优先使用原生 GET 表单，沿用 `q` 参数和现有公开搜索接口。
   支持搜索片名、别名、导演或主演；不新建统一搜索页，也不改后台管理搜索。
2. 从地址栏回填关键词；提交或清空时回到第 1 页，保留当前有效的类型、地区、年份筛选。
   翻页继续保留关键词及筛选；空白词去掉首尾空白后按未搜索处理，不静默截断超长词。
3. 与现有后端 200 字符上限一致；直接输入超长或重复 `q` 参数时提供明确提示，
   不把非法搜索参数发给后端，不因参数异常让页面崩溃。沿用现有匹配语义，不另加分词或大小写转换。
4. 显示当前搜索条件与匹配总数；真正无匹配和结果加载失败分开呈现。
   越界页即使没有当前页条目，也不能把非零 `meta.total` 标成“没有匹配内容”。

**验收**：真实公开 HTTP 夹具 + 门户浏览器，覆盖片名 / 别名命中、草稿不可见、中文和特殊字符编码、
空白 / 清空 / 超长 / 重复参数、保留筛选且重置页码、翻页 / 返回回填、无匹配 / 越界页 / 接口失败。
验证桌面和窄屏的表单可用性、相关回归及门户构建。使用隔离副本与合成数据；此步不记录搜索行为、不改 schema、不安装依赖。

### 随后：影视搜索提交次数榜（待实现）

- 仅由影视门户的明确提交动作触发单独写入口；后台逐字查询、普通 GET、翻页、筛选、刷新和预取不触发上报。
  只接收受校验的关键词，类型由首批影视范围固定；不接受客户端 `resultCount`、用户 ID、时间或增量次数。
- 首批只展示近 7 日、Top 20 的**有效上报次数**，不宣称独立访客数或严格恰好一次。
  无 JavaScript、网络失败或进程中断可能漏记，公众也可能重复提交；统计失败不影响搜索，客户端不自动重试上报。
  暂不加入平均结果数、零结果标红、多类型搜索或自动补采建议。
- 拟按“日期 + 规范化关键词”聚合，日期采用 `Asia/Shanghai`，保留含当天的 7 个自然日；
  规范化先仅去除首尾空白，数据库唯一键语义须与此一致，不能由默认排序规则偷偷合并其他词。
  并发计数用数据库原子更新，不保存逐次日志、IP、用户 / 游客标识或 UA；词本身仍可能包含个人信息，不称匿名数据。
- `GET /stats/search-keywords` 和榜单首批仅管理员可用；需在现有类级 `staff` 之上显式声明 `admin`，并纳入权限矩阵。
  点击关键词通过既有门户地址解析工具打开 `/movies?q=...` 的公开结果，不能使用后台不消费的 `search` 参数。
- 写入口保留请求限流，捕获写入错误且不打印原词；不用无界内存队列或未处理的异步 Promise。
  实施时补充过期清理触发点、批次上限和失败行为；七日聚合并不是硬行数上限，无流量时也不承诺准时物理删除。
- 新增第三条显式 migration，不修改冻结基线或续播迁移；同步 MySQL / MariaDB 验收中“两条记录 / 28 张表”的现有断言，
  覆盖空库及已有两条迁移的升级、并发计数、日期边界和重复执行。已有数据卷的部署只检查迁移状态，不会自动升级。

本轮只完成核查与范围修订，上述入口、榜单及新迁移均未实现。小说 / 漫画及文章在后续批次独立接入。

---

## 数据库变更汇总

| 表 | 变更类型 | 字段 |
|----|---------|------|
| `movies` | ADD | `posterBroken`, `titleCleaned`, `aliases` |
| `novels` | ADD | `aliases` |
| `comics` | ADD | `aliases` |
| `movie_sources` | 后续批次待设计 | 原设想 `isAlive` / `lastCheckedAt` / `failCount`；当前手动诊断首批不改表 |
| `watch_history` | CREATE | 全新表 |
| 搜索词统计表 | 后续批次待实施 | 原 `search_logs` 逐次明细方案撤回；拟按日聚合，新增迁移，不改冻结基线 |

## 文件变动汇总（原始构想，非已交付清单）

### 新增（10个）
```
backend/src/modules/collect/collect-cleaner.ts
backend/src/modules/collect/poster-checker.service.ts
backend/src/modules/watch-history/entities/watch-history.entity.ts
backend/src/modules/watch-history/watch-history.service.ts
backend/src/modules/watch-history/watch-history.controller.ts
backend/src/modules/watch-history/watch-history.module.ts
backend/src/modules/movie/source-health.service.ts
backend/src/modules/stats/search-log.service.ts
portal/app/movies/[slug]/play/[srcIdx]/[ep]/PlayClient.tsx
portal/components/ResumeButton.tsx
```

### 改动（12个）
```
后端：
  collect-executor.service.ts
  movie.entity.ts
  movie-source.entity.ts
  movie.service.ts / novel.service.ts / comic.service.ts
  collect.controller.ts
  stats.controller.ts
  app.module.ts

前台：
  portal/components/HlsPlayer.tsx
  portal/app/movies/[slug]/page.tsx
  portal/app/movies/[slug]/play/[srcIdx]/[ep]/page.tsx

管理后台：
  frontend/src/pages/Movie/index.tsx
  frontend/src/pages/Movie/MovieForm.tsx
  frontend/src/pages/Collect/CollectLogs.tsx
  frontend/src/pages/Dashboard/index.tsx
```

---

*最后更新：2026-04-29*
