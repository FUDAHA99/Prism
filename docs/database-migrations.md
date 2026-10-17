# 数据库迁移、续播一致性与搜索统计

生产数据库通过显式 migration 建表和升级。`DB_SYNC=true` 在生产启动和迁移命令中均被拒绝；
后端启动只读检查迁移记录，不自动执行 migration。MySQL 8.0 / MariaDB 11.4 的迁移在本地隔离实例中验证，
不代表线上数据库已完成升级。SQLite 只用于部分 HTTP 测试，不支持完整业务库迁移。

## 1. 当前迁移内容

- `InitialSchema1791936000000`：冻结提交 `783aeba` 的 27 张业务表，包含 2 张关联表；
  SQL 和两种数据库的结构快照随编译产物进入后端镜像，不随后续 entity 自动改变。
- `WatchHistoryOwner1791936001000`：添加 `ownerKey` 和唯一键 `(ownerKey, contentType, contentId)`。
  用户归属为 `u:` 加小写用户 ID；游客归属为 `g:` 加原始游客 ID 的 UTF-8 SHA-256。
  登录记录清除 `guestId`，避免游客读写用户的历史；不将游客历史自动合并到账号。
- 重复记录按 `updatedAt`、`createdAt`、`id` 从大到小保留一行，原时间戳不变。
  不取最大播放秒数，因为两行可能来自不同集。没有有效归属的历史行会令迁移在改表前失败，需人工核对。
- 保留原有字段和普通索引；不清理无关的双列关系字段，不添加海报复检等其他功能。
- `SearchKeywordDaily1792195200000`：第三条迁移新增 InnoDB 表 `search_keyword_daily`，
  复合主键为 `day DATE` 与 `keywordHash VARCHAR(64)`，原词为 `keyword TEXT`，次数为 `count BIGINT UNSIGNED`。
  不改前两条迁移和冻结基线；全部执行后为 28 张业务表加 1 张迁移记录表、3 条迁移记录。
  日键采用北京时间，hash 由 trim 后原词 UTF-8 计算；TEXT 容纳搜索校验允许的 emoji 展示符，不按原词排序规则去重。

结构接入严格比较表集、列、索引、外键、默认值、字符集和排序规则，并拒绝额外触发器。
仅忽略换行形式和表的自增计数值。版本差异或人工调整导致不匹配时也会停止，需先人工核对；
不要修改冻结快照来让一个未经确认的数据库通过，更不能直接手写迁移记录。

## 2. 命令

先 `npm run build`，再在 `backend` 目录运行：

| 命令 | 行为 |
|---|---|
| `npm run migration:check` | 只读检查迁移记录；缺失、待执行、未知、重复或乱序均非零退出；不创建记录表 |
| `npm run migration:baseline` | 仅用于尚未登记、且结构完整匹配冻结基线的存量库；只登记初始基线，不跳过续播迁移 |
| `npm run migration:run` | 空库执行全部迁移；已登记库执行剩余迁移；重复执行无待执行迁移时成功 |

CLI **不自动加载 `.env`**。本机运行时显式设置 `DB_TYPE`、`DATABASE_HOST`、`DATABASE_PORT`、
`DATABASE_NAME`、`DATABASE_USER`、`DATABASE_PASSWORD`，并保持 `DB_SYNC=false`。
生产 Compose 的一次性 backend 容器会传入与实际服务相同的连接配置。

MariaDB 运行时使用 MySQL 兼容驱动，沿用基线的 `varchar(36)` UUID 表示，避免 ORM 在 MariaDB 上
改用原生 `uuid` 后与既有关系列冲突；迁移 CLI 仍区分两种数据库，以选择各自的冻结结构快照。
开发默认保留自动同步；设置 `DB_SYNC=false` 可关闭同步，并启用同样的迁移记录检查。

## 3. 空库首次部署

按 `docs/deploy.md` 填好 `.env.prod`，保持 `DB_SYNC=false`，运行 `bash scripts/deploy.sh`。
脚本在 JWT 和 nginx 预检通过后确保 MySQL 就绪（不重建已有容器），执行空库迁移、检查记录，
然后启动业务服务。已有数据卷仅检查迁移状态，不自动修改库结构。

首次部署仍按 `prism_mysql_data` 卷是否存在判断。若已有一个空卷，或上次初始化中途失败，
不要删除卷来伪装首次部署；先检查库结构，再显式运行迁移并按部署指南初始化管理员。

## 4. 存量库首次接入

这是有计划的停写升级。以下命令是运行手册，本轮开发没有对线上执行。
先确认备份可恢复；暂停部署自动化和所有写入进程，包括旧 backend、采集任务及其他维护脚本。
只停新版本并不够：旧版本仍可写入没有 `ownerKey` 的记录。

```bash
# 在服务器项目根目录；先确认代码与镜像对应本次升级
docker compose -f docker-compose.prod.yml --env-file .env.prod build backend

# 停止写入；如另有写入进程，也必须一并暂停
docker compose -f docker-compose.prod.yml --env-file .env.prod stop backend

# 使用项目备份流程保存停写后的数据库；核对产物、保留恢复点
bash scripts/backup.sh

# 旧库无迁移记录时：严格核对结构，只登记初始基线
docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm --no-deps backend npm run migration:baseline

# 执行所有待执行迁移，再只读检查
docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm --no-deps backend npm run migration:run
docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm --no-deps backend npm run migration:check

# 三步都成功后部署当前已核对的代码（不在停写窗口再拉取其他版本）
bash scripts/deploy.sh --skip-pull
```

`.env.prod` 必须已设 `DB_SYNC=false`，shell 中也不能遗留 `DB_SYNC=true`。
已有迁移记录的库跳过 `migration:baseline`，只执行待执行迁移。
已完成前两条迁移的库也必须按上述备份、停写、`migration:run`、`migration:check` 流程手动加入搜索统计表；
不要重做基线登记。新镜像发现只登记两条时会拒绝启动，例行部署对已有卷仍只检查，不自动执行第三条迁移。
每条命令都要检查退出码；失败后停止后续步骤，不继续启动新版服务。
例行部署对于已有数据卷只执行 `migration:check`，不会自动接入基线或清理重复记录。

## 5. 失败与恢复

MySQL / MariaDB 的 DDL 会隐式提交，整条迁移链不具备事务回滚保证。
执行时使用 `transaction: none`；命令失败不等于前面已执行的 DDL 被撤销。
例如 `ownerKey` 已建立但迁移未登记时，再执行会拒绝自动跳过，需保留日志并核查现场。

当前三条迁移的 `down()` 都明确拒绝自动回滚：初始基线不能自动删业务表，去重无法恢复已合并的行，
搜索统计也不会自动删表丢弃已收集数据。若统计表已存在但第三条迁移未登记，执行会拒绝自动跳过，需保留现场人工核查。
需要撤销时，保持停写，从经过验证的迁移前备份恢复，再使用与备份结构匹配的旧镜像。
不要仅回退代码、删 `ownerKey`、删除迁移记录或使用通用 `--fake` 来掩盖失败。

存量结构不匹配会在登记前停止。先导出并比较实际 `SHOW CREATE TABLE` 与冻结基线，
确定历史差异的来源，单独审查修复方案；不要启用 `synchronize` 自动“对齐”。

## 6. 续播写入约定与验证

写入使用数据库唯一约束和单条条件 upsert：同线路、集序号、`episodeId` 相同时仅接受更大秒数，
相等或较小秒数不会改时长及更新时间；换线路、换集或换 `episodeId` 时允许覆盖为较小秒数。
游客 ID 的大小写和尾空白属于身份的一部分，哈希归属键避免默认不区分大小写的排序规则合并身份。
用户身份始终取经过认证的账号；请求传入的 `guestId` 不参与该用户的记录归属。

当前 DTO 没有采样序号，跨集请求仍按数据库处理顺序覆盖；旧集请求晚到可能覆盖新集。
本轮没有引入事件排序协议，也没有改变门户的上报频率。

搜索统计按日期与 hash 原子递增，仅记录有效上报次数；读取固定过滤北京时间含当天 7 日。
写入和管理员读取触发过期清理，每进程每 60 秒最多一次、单次最多 500 行，失败只记固定日志；
无流量时不保证及时物理删除，也不承诺七日内的行数有硬上限。接口和隐私边界见 [API 文档](api.md#附影视搜索提交次数-statssearch-keywords)。

可重复验证入口为 `backend/scripts/test-migrations.cjs`。它不加载 `.env`，要求显式测试开关、
完整连接参数和固定测试库名前缀；仅在指定的独立测试实例中新建随机数据库，结束时清理本进程创建的库。
**不要把此入口指向业务数据库实例。** CI 的独立 MySQL / MariaDB 服务使用同一入口。

```bash
# 仅供独立的临时测试实例；账号需要对测试前缀库的 CREATE / DROP 权限
cd backend
npm run build
MIGRATION_TEST_ALLOW_CREATE_DATABASE=1 DB_TYPE=mysql \
  DATABASE_HOST=127.0.0.1 DATABASE_PORT=3306 \
  DATABASE_NAME=prism_qa_migration DATABASE_USER=qa DATABASE_PASSWORD=qa-only \
  node scripts/test-migrations.cjs
```

参考：[TypeORM 迁移](https://typeorm.io/docs/advanced-topics/migrations/)、
[MySQL 隐式提交](https://dev.mysql.com/doc/refman/8.0/en/implicit-commit.html)。
