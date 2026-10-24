import 'reflect-metadata';
import { DataSource, Repository } from 'typeorm';
import { TokenRevocation } from './entities/token-revocation.entity';
import { TokenRevocationStore } from './token-revocation.store';
import {
  GLOBAL_VALID_AFTER_KEY,
  isIssuedBeforeRevocation,
  readValidAfter,
  validAfterKey,
} from './token-revocation';

/** 真实内存 SQLite 表验证持久化行为；不代表 MySQL 迁移或多连接并发验收。 */
describe('TokenRevocationStore', () => {
  const now = 1_700_000_000_000;
  // 原生 addon 保留首个 Jest realm 的 SqliteError 构造器；后续 suite 的 toThrow 无法识别它。
  // 仍要求 Promise 拒绝，且精确核对数据库错误类型、错误码和消息，不能把存储异常当成 miss。
  const missingTable = { name: 'SqliteError', code: 'SQLITE_ERROR', message: 'no such table: token_revocations' };
  let database: DataSource;
  let rows: Repository<TokenRevocation>;
  let store: TokenRevocationStore;

  beforeEach(async () => {
    database = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [TokenRevocation],
      synchronize: true,
    }).initialize();
    rows = database.getRepository(TokenRevocation);
    store = new TokenRevocationStore(database.manager);
    jest.spyOn(Date, 'now').mockReturnValue(now);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (database?.isInitialized) await database.destroy();
  });

  it('区分不存在、有效与自然过期的撤销记录', async () => {
    expect(await store.get('missing')).toBeUndefined();
    await store.set('blacklist:token', 1, 1000);
    expect(await store.get('blacklist:token')).toBe(1);
    jest.mocked(Date.now).mockReturnValue(now + 1000);
    expect(await store.get('blacklist:token')).toBeUndefined();
  });

  it('真实读表失败向上传播，不解释为没有撤销记录', async () => {
    await database.query('DROP TABLE token_revocations');
    await expect(store.get('blacklist:token')).rejects.toMatchObject(missingTable);
    await expect(isIssuedBeforeRevocation(store, 'u1', now / 1000)).rejects.toMatchObject(missingTable);
  });

  it('真实写表失败向上传播，不报告撤销成功', async () => {
    await database.query('DROP TABLE token_revocations');
    await expect(store.set('blacklist:token', 1, 1000)).rejects.toMatchObject(missingTable);
  });

  it('同时调用与迟到的旧写入均不能倒退撤销时间或缩短保留期', async () => {
    const key = validAfterKey('u1');
    await Promise.all([
      store.set(key, now + 500, 60_000),
      store.set(key, now + 100, 1000),
    ]);
    jest.mocked(Date.now).mockReturnValue(now + 2000);
    await store.set(key, now + 200, 1000);
    expect(await store.get(key)).toBe(now + 500);
    const row = await rows.findOneByOrFail({ key });
    expect(Number(row.expiresAt)).toBe(now + 60_000);
  });

  it('每次写入清理过期记录，同时保留未过期记录和永久全局基线', async () => {
    await rows.insert([
      { key: GLOBAL_VALID_AFTER_KEY, value: String(now - 1000), expiresAt: null },
      { key: 'expired', value: '1', expiresAt: String(now - 1) },
      { key: 'boundary', value: '1', expiresAt: String(now) },
      { key: 'live', value: '1', expiresAt: String(now + 1000) },
    ]);
    await store.set('new', 1, 5000);
    expect((await rows.find()).map((row) => row.key).sort()).toEqual([
      GLOBAL_VALID_AFTER_KEY, 'live', 'new',
    ]);
    jest.mocked(Date.now).mockReturnValue(now + 1000);
    await store.set('next', 1, 5000);
    expect(await rows.findOneBy({ key: 'live' })).toBeNull();
    expect((await rows.findOneByOrFail({ key: GLOBAL_VALID_AFTER_KEY })).expiresAt).toBeNull();
    expect(await store.get(GLOBAL_VALID_AFTER_KEY)).toBe(now - 1000);
  });

  it('永久基线即使收到有 TTL 的写入也不会变成有限期记录', async () => {
    await rows.insert({ key: GLOBAL_VALID_AFTER_KEY, value: String(now), expiresAt: null });
    await store.set(GLOBAL_VALID_AFTER_KEY, now + 500, 1000);
    jest.mocked(Date.now).mockReturnValue(now + 10_000);
    expect(await store.get(GLOBAL_VALID_AFTER_KEY)).toBe(now + 500);
    expect((await rows.findOneByOrFail({ key: GLOBAL_VALID_AFTER_KEY })).expiresAt).toBeNull();
  });

  it.each([
    ['value', 'not-a-number', null],
    ['expiresAt', String(now), 'not-a-number'],
  ])('拒绝损坏的 %s，不能当作未撤销', async (_column, value, expiresAt) => {
    await rows.insert({ key: validAfterKey('u1'), value: value!, expiresAt });
    await expect(isIssuedBeforeRevocation(store, 'u1', now / 1000)).rejects.toThrow('认证撤销记录无效');
  });

  it('全局与用户基线取较新值，迁移前和用户改密前的旧 token 均被拒绝', async () => {
    expect(await readValidAfter(store, 'u1')).toBeUndefined();
    await rows.insert({ key: GLOBAL_VALID_AFTER_KEY, value: String(now + 500), expiresAt: null });
    await store.set(validAfterKey('u1'), now + 250, 60_000);
    expect(await readValidAfter(store, 'u1')).toBe(now + 500);
    expect(await isIssuedBeforeRevocation(store, 'u1', now / 1000)).toBe(true);
    expect(await isIssuedBeforeRevocation(store, 'u2', now / 1000)).toBe(true);
    expect(await isIssuedBeforeRevocation(store, 'u2', now / 1000 + 1)).toBe(false);
    await store.set(validAfterKey('u1'), now + 1500, 60_000);
    expect(await readValidAfter(store, 'u1')).toBe(now + 1500);
    expect(await isIssuedBeforeRevocation(store, 'u1', now / 1000 + 1)).toBe(true);
    expect(await isIssuedBeforeRevocation(store, 'u1', now / 1000 + 2)).toBe(false);
    expect(await isIssuedBeforeRevocation(store, 'u1', undefined)).toBe(true);
  });
});
