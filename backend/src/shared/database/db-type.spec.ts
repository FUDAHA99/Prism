import { resolveDbType } from './db-type';

describe('resolveDbType', () => {
  it.each([
    [undefined, 'mysql'],
    ['mysql', 'mysql'],
    ['MySQL', 'mysql'],
    [' mariadb ', 'mariadb'],
  ])('DB_TYPE=%p 解析为 %p', (raw, want) => {
    expect(resolveDbType(raw)).toBe(want);
  });

  // sqlite / better-sqlite3 也拒绝：运行时的 SQLite 分支起不来（longtext 不受支持），已删除
  it.each(['', 'mysq1', 'postgres', 'sqlite', 'better-sqlite3'])(
    'DB_TYPE=%p 启动即失败，不静默回退',
    (raw) => {
      expect(() => resolveDbType(raw)).toThrow(`不支持的 DB_TYPE: ${JSON.stringify(raw)}`);
    },
  );
});
