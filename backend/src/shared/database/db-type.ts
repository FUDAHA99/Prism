/**
 * 运行时数据库类型白名单：只支持 MySQL / MariaDB。
 *
 * 以前 database.module.ts 在 DB_TYPE 不是 mysql / mariadb 时会静默落进一个 SQLite（better-sqlite3）
 * fallback 分支。这个分支从初始提交起就起不来：NovelChapter.content 是 longtext，TypeORM 的
 * better-sqlite3 驱动不支持该类型（DataTypeNotSupportedError），连接重试耗尽后进程退出。
 * 所以删掉了该分支，改为启动时校验 DB_TYPE：空串、拼错（如 mysq1）或写成 sqlite 都立即报错，
 * 不再落进一个注定失败的分支、在日志里等几十秒才看到不相干的类型错误。
 *
 * better-sqlite3 仍是依赖：测试的内存夹具（spec 里 TypeOrmModule 直接配 type: 'better-sqlite3'，
 * 不经过 DatabaseModule）和 scripts/migrate-sqlite-to-mysql.js 在用。
 */
export const SUPPORTED_DB_TYPES = ['mysql', 'mariadb'] as const;
export type SupportedDbType = (typeof SUPPORTED_DB_TYPES)[number];

/** 未设置时默认 mysql；容忍大小写与首尾空白；其余一律抛错让启动失败 */
export function resolveDbType(raw: string | undefined): SupportedDbType {
  const value = (raw ?? 'mysql').trim().toLowerCase();
  if ((SUPPORTED_DB_TYPES as readonly string[]).includes(value)) {
    return value as SupportedDbType;
  }
  throw new Error(`不支持的 DB_TYPE: ${JSON.stringify(raw)}（可选 mysql | mariadb）`);
}
