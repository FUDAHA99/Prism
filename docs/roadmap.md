# Prism CMS 优化路线图

> 从「maccms 替代品」到「明显更好的选择」
>
> 最后更新：2026-04-29

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

### 目标
搜索时匹配别名，采集时自动填充中英双语别名，解决搜不到的问题。

### 数据库变更

```sql
ALTER TABLE movies  ADD COLUMN aliases VARCHAR(1000) NULL COMMENT '别名，逗号分隔';
ALTER TABLE novels  ADD COLUMN aliases VARCHAR(1000) NULL;
ALTER TABLE comics  ADD COLUMN aliases VARCHAR(1000) NULL;
```

### 采集时自动填充

`collect-executor.service.ts` → `upsertMovie()`
```ts
// vod_sub（原名/外文名）不为空时写入 aliases
if (it.vod_sub && it.vod_sub !== it.vod_name) {
  data.aliases = cleanTitle(it.vod_sub)
}
```

### 搜索逻辑改动

`movie.service.ts` / `novel.service.ts` / `comic.service.ts` → `findAll()` search 条件
```ts
// 新增 m.aliases LIKE :s
'(m.title LIKE :s OR m.originalTitle LIKE :s OR m.aliases LIKE :s OR m.director LIKE :s OR m.actors LIKE :s)'
```

### 管理后台

`frontend/src/pages/Movie/MovieForm.tsx` 新增字段：
```
<Form.Item label="别名" name="aliases">
  <Input placeholder="多个别名用英文逗号分隔，如：Breaking Bad,绝命毒师" />
</Form.Item>
```

---

## Phase 2-B：采集 SSE 实时进度

### 目标
采集运行中时，管理后台实时显示处理条数，不再靠轮询。

### 后端改动

**`collect-executor.service.ts`**
```ts
// 新增：进度事件 Map
private readonly progressSubjects = new Map<string, Subject<RunStats>>()

// 新增：外部获取 Observable
getProgressStream(logId): Observable<RunStats> | null

// 改动：processBatch() 每处理 10 条 emit 一次
// 改动：runInBackground() 结束时 complete() 并删除 subject
```

**`collect.controller.ts` 新增 SSE 接口**
```ts
@Get('logs/:id/stream')
@Sse()
@UseGuards(AuthGuard('jwt'))
streamProgress(@Param('id') id): Observable<MessageEvent>
```

### 前台改动

**`frontend/src/pages/Collect/CollectLogs.tsx`**
- `LogDetailDrawer`：任务运行时建立 SSE 连接（fetch + ReadableStream 手动解析）
- 收到 message → 实时更新本地 stats state
- 连接关闭 → refetch log 详情显示最终数据
- Progress 组件 `status="active"` 显示动画进度条

---

## Phase 3-A：线路健康度检测

### 目标
定时检测播放线路可用性，挂掉的自动标记，前台不显示不可用线路。

### 数据库变更

```sql
ALTER TABLE movie_sources
  ADD COLUMN isAlive       TINYINT(1) NOT NULL DEFAULT 1  COMMENT '1=可用，0=不可用',
  ADD COLUMN lastCheckedAt DATETIME   NULL                COMMENT '最后检测时间',
  ADD COLUMN failCount     INT        NOT NULL DEFAULT 0  COMMENT '连续失败次数';
```

### 新增文件

**`backend/src/modules/movie/source-health.service.ts`**
```
checkAll(): Promise<void>
  - 查所有 kind='play' 的 MovieSource，取第一集 URL
  - 并发 HEAD 请求（concurrency=20，超时 8s）
  - 成功：isAlive=1, failCount=0, lastCheckedAt=now
  - 失败：failCount+1；failCount>=3 时 isAlive=0

@Cron('0 */2 * * *')  每 2 小时自动执行
scheduledCheck(): void
```

### 前台改动

`portal/app/movies/[slug]/page.tsx`
```ts
// 过滤不可用线路
const sources = (movie.sources ?? []).filter(s => s.isAlive !== false)
```

`PlayClient.tsx`
```
当前线路 isAlive=false → 显示提示 Banner + 自动切换到第一个可用线路
```

### 管理后台

`frontend/src/pages/Movie/MovieForm.tsx` 线路列表
- 各线路显示健康状态图标（绿点/红点）
- Tooltip 显示"最后检测：X 分钟前"

新增管理接口：`POST /movies/sources/check-all` 手动触发全量检测

---

## Phase 3-B：搜索词统计

### 目标
记录用户搜索词，Dashboard 展示 Top 20，辅助站长决策补采集源。

### 新增数据库表

```sql
CREATE TABLE search_logs (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  keyword     VARCHAR(200) NOT NULL,
  contentType VARCHAR(20)  NULL,
  resultCount INT          NOT NULL DEFAULT 0,
  createdAt   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_keyword (keyword),
  INDEX idx_created (createdAt)
);
```

### 后端改动

各 service（`movie/novel/comic/content`）`findAll()` 有 search 时异步写入 search_logs

**新增 `SearchLogService`**
```
record(keyword, contentType, resultCount): Promise<void>
getTopKeywords(days=7, limit=20): Promise<{ keyword, count, avgResultCount }[]>
```

**`stats.controller.ts` 新增**
```ts
@Get('search-keywords')
getSearchKeywords(@Query('days') days = 7)
```

### 管理后台 Dashboard

`frontend/src/pages/Dashboard/index.tsx` 底部新增 Card
- 标题："热门搜索词（近7日）"
- 内容：Table（keyword / 搜索次数 / 平均结果数）
- **avgResultCount=0 的词红色标注**（用户搜不到 → 运营价值最高）
- 点击关键词 → 跳转 `/movies?search=xxx`

---

## 数据库变更汇总

| 表 | 变更类型 | 字段 |
|----|---------|------|
| `movies` | ADD | `posterBroken`, `titleCleaned`, `aliases` |
| `novels` | ADD | `aliases` |
| `comics` | ADD | `aliases` |
| `movie_sources` | ADD | `isAlive`, `lastCheckedAt`, `failCount` |
| `watch_history` | CREATE | 全新表 |
| `search_logs` | CREATE | 全新表 |

## 文件变动汇总

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
