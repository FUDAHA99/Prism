import { QueryRunner } from 'typeorm';
import { BASELINE_DEFINITIONS } from './migrations/baseline-schema';

export async function businessTables(runner: QueryRunner): Promise<string[]> {
  const tables: Array<{ name: string }> = await runner.query(
    'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME',
  );
  return tables.map(table => table.name).filter(name => name !== 'migrations');
}

export async function assertEmptySchema(runner: QueryRunner): Promise<void> {
  const tables = await businessTables(runner);
  if (tables.length) {
    throw new Error(`发现未登记基线的已有表：${tables.join(', ')}。请备份、停写并运行 migration:baseline；不得自动建表或补记。`);
  }
}

const normalize = (sql: string) => sql.replace(/\r\n/g, '\n').replace(/ AUTO_INCREMENT=\d+/g, '').trim();

/** Compare with the frozen schema, never with today's mutable entity metadata. */
export async function assertBaselineSchema(runner: QueryRunner): Promise<void> {
  const type = runner.connection.options.type;
  if (type !== 'mysql' && type !== 'mariadb') throw new Error('基线仅支持 MySQL / MariaDB。');
  const expected = BASELINE_DEFINITIONS[type];
  const tables = await businessTables(runner);
  const names = Object.keys(expected).sort();
  if (JSON.stringify(tables.slice().sort()) !== JSON.stringify(names)) {
    throw new Error(`存量库表集与冻结基线不符。缺少：${names.filter(name => !tables.includes(name)).join(', ') || '无'}；额外：${tables.filter(name => !names.includes(name)).join(', ') || '无'}。未写入迁移记录。`);
  }
  const triggers = await runner.query('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()');
  if (triggers.length) throw new Error('存量库包含冻结基线之外的触发器；未写入迁移记录。');
  const mismatched: string[] = [];
  for (const name of names) {
    const rows = await runner.query(`SHOW CREATE TABLE \`${name.replace(/`/g, '``')}\``);
    if (normalize(rows[0]['Create Table'] || '') !== normalize(expected[name])) mismatched.push(name);
  }
  if (mismatched.length) {
    throw new Error(`存量库结构与冻结基线不符：${mismatched.join(', ')}。请核对列、索引、外键、默认值与字符集；未写入迁移记录。`);
  }
}
