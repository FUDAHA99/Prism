import 'reflect-metadata';
import { DataSource, getMetadataArgsStorage, Repository } from 'typeorm';
import { CollectSourceService } from './collect-source.service';
import { CollectSource, CollectContentType } from './entities/collect-source.entity';
import { CollectCategoryMapping } from './entities/collect-category-mapping.entity';
import { AUDIT_REDACTED } from '../audit/audit-sanitizer';

const SOURCE_ID = 'a1b2c3d4-1111-4111-8111-111111111111';
const OLD_RUN = new Date('2026-10-01T00:00:00Z');
const NEW_RUN = new Date('2026-10-17T00:00:00Z');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('采集源编辑只修改本次字段（真实SQLite）', () => {
  let ds: DataSource;
  let sources: Repository<CollectSource>;
  let mappings: Repository<CollectCategoryMapping>;
  let service: CollectSourceService;
  let mappingId: string;
  const audit = { log: jest.fn(async (_entry: Record<string, unknown>) => undefined) };

  beforeAll(async () => {
    // 仅适配测试驱动的enum，初始化完成后立即还原装饰器元数据。
    const columns = getMetadataArgsStorage().columns.filter((column) => column.target === CollectSource && column.options.type === 'enum');
    for (const column of columns) column.options.type = 'simple-enum';
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:',
      entities: [CollectSource, CollectCategoryMapping], synchronize: true });
    try { await ds.initialize(); }
    finally { for (const column of columns) column.options.type = 'enum'; }
    sources = ds.getRepository(CollectSource);
    mappings = ds.getRepository(CollectCategoryMapping);
    service = new CollectSourceService(sources, mappings, audit as any);
  });

  beforeEach(async () => {
    await mappings.clear();
    await sources.clear();
    await sources.save({ id: SOURCE_ID, name: '旧名称', apiUrl: 'https://old.example.com/api?key=OLD_SECRET',
      contentType: CollectContentType.MOVIE, totalCollected: 10, lastRunAt: OLD_RUN,
      userAgent: 'OldAgent', extraHeaders: { 'X-Old': 'OLD_HEADER_SECRET' }, defaultPlayFrom: 'old-line', remark: '旧备注',
      createdAt: OLD_RUN, updatedAt: OLD_RUN });
    mappingId = (await mappings.save({ sourceId: SOURCE_ID, sourceCategoryId: '6', sourceCategoryName: '旧分类', enabled: true })).id;
    audit.log.mockClear();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await ds.query('DROP TRIGGER IF EXISTS reject_source_update');
  });
  afterAll(async () => { await ds?.destroy(); });

  /** 先让编辑拿到旧实体（含关系），暂停返回，供另一次写入抢先提交。 */
  function holdFirstRead() {
    const read = deferred();
    const resume = deferred();
    const findOne = sources.findOne.bind(sources);
    jest.spyOn(sources, 'findOne').mockImplementationOnce(async (options) => {
      const snapshot = await findOne(options);
      read.resolve();
      await resume.promise;
      return snapshot;
    });
    return { read: read.promise, resume: resume.resolve };
  }

  it('编辑持有旧snapshot时采集已累加并更新运行时间，随后编辑不把它们覆盖回去', async () => {
    const barrier = holdFirstRead();
    const editing = service.update(SOURCE_ID, { name: '编辑后的名称' }, 'admin');
    await barrier.read;
    try {
      await sources.update(SOURCE_ID, { totalCollected: () => 'totalCollected + 7', lastRunAt: NEW_RUN });
    } finally { barrier.resume(); }
    const returned = await editing;
    const persisted = await sources.findOneByOrFail({ id: SOURCE_ID });
    expect(persisted).toMatchObject({ name: '编辑后的名称', totalCollected: 17, lastRunAt: NEW_RUN });
    expect(returned).toMatchObject({ id: SOURCE_ID, totalCollected: 17, lastRunAt: NEW_RUN });
    expect(returned.categoryMappings).toHaveLength(1);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ newValues: { changedFields: ['name'] } }));
  });

  it('旧实体带着分类关系时，编辑不会级联覆盖同时更新的映射，返回关系也是最新的', async () => {
    const barrier = holdFirstRead();
    const editing = service.update(SOURCE_ID, { remark: '改备注' }, 'admin');
    await barrier.read;
    try {
      await mappings.update(mappingId, { sourceCategoryName: '并发更新的分类', enabled: false, localCategoryId: 'new-local-category' });
    } finally { barrier.resume(); }
    const returned = await editing;
    const expected = { id: mappingId, sourceCategoryName: '并发更新的分类', enabled: false, localCategoryId: 'new-local-category' };
    expect(await mappings.findOneByOrFail({ id: mappingId })).toMatchObject(expected);
    expect(returned.categoryMappings).toEqual([expect.objectContaining(expected)]);
    expect(returned.remark).toBe('改备注');
  });

  it('正常字段、null、空字符串和空headers可保存；省略字段及内部统计/关系不受伪造参数影响', async () => {
    const returned = await service.update(SOURCE_ID, {
      name: '新名称', timeoutSec: 60, userAgent: null, remark: null, defaultPlayFrom: '', extraHeaders: {},
      apiUrl: undefined, id: 'forged-id', totalCollected: 999, lastRunAt: NEW_RUN, categoryMappings: [],
    } as never, 'admin');
    expect(returned).toMatchObject({ id: SOURCE_ID, name: '新名称', timeoutSec: 60, userAgent: null, remark: null,
      defaultPlayFrom: '', extraHeaders: {}, apiUrl: 'https://old.example.com/api?key=OLD_SECRET', totalCollected: 10, lastRunAt: OLD_RUN });
    expect(returned.categoryMappings).toHaveLength(1);
    expect(await sources.count()).toBe(1);
    const cleared = await service.update(SOURCE_ID, { extraHeaders: null, defaultPlayFrom: null }, 'admin');
    expect(cleared).toMatchObject({ extraHeaders: null, defaultPlayFrom: null });
  });

  it('空白名单patch不执行UPDATE，回读完整源及分类关系', async () => {
    const before = await service.findOne(SOURCE_ID);
    await ds.query("CREATE TRIGGER reject_source_update BEFORE UPDATE ON collect_sources BEGIN SELECT RAISE(ABORT, 'unexpected source update'); END");
    const returned = await service.update(SOURCE_ID, { name: undefined, totalCollected: 999 } as never, 'admin');
    expect(returned).toEqual(before);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ newValues: { changedFields: [] } }));
  });

  it('不存在的源保持404且不写审计', async () => {
    await expect(service.update('missing-source', { name: '不存在' }, 'admin')).rejects.toMatchObject({ status: 404 });
    expect(audit.log).not.toHaveBeenCalled();
    expect((await sources.findOneByOrFail({ id: SOURCE_ID })).name).toBe('旧名称');
  });

  it('回读之前另一编辑已提交，审计只描述本次patch且不泄露URL密钥或header值', async () => {
    const findOne = sources.findOne.bind(sources);
    let reads = 0;
    jest.spyOn(sources, 'findOne').mockImplementation(async (options) => {
      if (++reads === 2) {
        await sources.update(SOURCE_ID, { apiUrl: 'https://other.example.com/api?key=OTHER_SECRET', extraHeaders: { 'X-Other': 'OTHER_HEADER_SECRET' } });
      }
      return findOne(options);
    });
    const returned = await service.update(SOURCE_ID, {
      apiUrl: 'https://editor.example.com:8443/private?key=EDIT_QUERY_SECRET',
      extraHeaders: { Authorization: 'Bearer EDIT_HEADER_SECRET', 'X-Api-Key': 'EDIT_KEY_SECRET' },
    }, 'admin');
    expect(returned.apiUrl).toBe('https://other.example.com/api?key=OTHER_SECRET');
    expect(audit.log).toHaveBeenCalledWith({ userId: 'admin', action: 'UPDATE', resourceType: 'collect_source', resourceId: SOURCE_ID,
      newValues: { changedFields: ['apiUrl', 'extraHeaders'], apiHost: 'editor.example.com:8443',
        extraHeaders: { Authorization: AUDIT_REDACTED, 'X-Api-Key': AUDIT_REDACTED } } });
    expect(JSON.stringify(audit.log.mock.calls)).not.toMatch(/SECRET|other\.example|private|X-Other/);
  });
});
