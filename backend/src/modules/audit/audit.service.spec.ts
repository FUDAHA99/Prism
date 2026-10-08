import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';

import { AuditLog } from './entities/audit-log.entity';
import { AuditService } from './audit.service';
import { AUDIT_MAX_JSON_BYTES, AUDIT_REDACTED } from './audit-sanitizer';
import { User } from '../user/entities/user.entity';
import { UserService } from '../user/user.service';
import { Role } from '../role/entities/role.entity';
import { Permission } from '../role/entities/permission.entity';
import { RoleService } from '../role/role.service';
import { Content } from '../content/entities/content.entity';
import { ContentService } from '../content/content.service';
import { Category } from '../category/entities/category.entity';
import { Comment } from '../comment/entities/comment.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { CollectSourceService } from '../collect/collect-source.service';
import { MovieService } from '../movie/movie.service';
import { NovelService } from '../novel/novel.service';
import { ComicService } from '../comic/comic.service';

/**
 * 审计日志脱敏（批次 1-F-1 / C6）：真实 AuditService + 内存 SQLite。
 * 断言一律读库里的原始文本（simple-json 存的就是这段 JSON），确认秘密根本没落库，而不只是没出接口。
 */

class MemoryCache {
  private readonly store = new Map<string, string>();
  async get<T>(key: string): Promise<T | undefined> {
    const raw = this.store.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }
  async set(key: string, value: unknown): Promise<void> {
    this.store.set(key, JSON.stringify(value));
  }
  async del(key: string): Promise<void> {
    this.store.delete(key);
  }
}

interface RawAuditRow {
  id: string;
  action: string;
  oldValues: string | null;
  newValues: string | null;
  userAgent: string | null;
}

describe('AuditService 脱敏、截断与列表字段', () => {
  let ds: DataSource;
  let auditRepo: Repository<AuditLog>;
  let auditService: AuditService;
  let userService: UserService;
  let contentService: ContentService;
  let adminId: string;

  /** 最新一条指定动作的原始行 */
  async function lastRaw(action: string): Promise<RawAuditRow> {
    const rows: RawAuditRow[] = await ds.query(
      'SELECT id, action, oldValues, newValues, userAgent FROM audit_logs WHERE action = ? ORDER BY createdAt DESC, rowid DESC LIMIT 1',
      [action],
    );
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  beforeAll(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      // 只装载被测查询涉及的实体闭包：小说章节等实体用了 SQLite 不支持的 longtext
      entities: [User, Role, Permission, AuditLog, MediaFile, Content, Category, Comment],
      synchronize: true,
      logging: false,
    });
    await ds.initialize();
    auditRepo = ds.getRepository(AuditLog);
    const userRepo = ds.getRepository(User);
    auditService = new AuditService(auditRepo, userRepo);
    const cache = new MemoryCache();
    const roleService = new RoleService(ds.getRepository(Role), ds.getRepository(Permission), cache as any);
    userService = new UserService(userRepo, roleService, auditService, cache as any);
    contentService = new ContentService(ds.getRepository(Content), auditService);

    const admin = await userService.create({
      username: 'admin',
      email: 'admin@cms.test',
      password: 'Admin123!',
      nickname: '管理员',
    } as any);
    adminId = admin.id;
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  describe('log() 统一脱敏', () => {
    it('敏感键在落库前打码，超长字符串截断', async () => {
      await auditService.log({
        userId: adminId,
        action: 'T_SANITIZE',
        resourceType: 'test',
        oldValues: { password: 'Old-Plain-1' },
        newValues: {
          passwordHash: '$2b$10$abcdefghijklmnopqrstuv',
          refreshToken: 'eyJhbGciOi.secret.sig',
          extraHeaders: { Authorization: 'Bearer sk-live-xyz' },
          body: 'B'.repeat(10_000),
          title: '标题',
        },
      });
      const row = await lastRaw('T_SANITIZE');
      const text = `${row.oldValues}${row.newValues}`;
      for (const secret of ['Old-Plain-1', '$2b$10$', 'eyJhbGciOi', 'sk-live-xyz']) {
        expect(text).not.toContain(secret);
      }
      const nv = JSON.parse(row.newValues!);
      expect(nv.passwordHash).toBe(AUDIT_REDACTED);
      expect(nv.extraHeaders).toEqual({ Authorization: AUDIT_REDACTED });
      expect(nv.title).toBe('标题');
      expect(nv.body.length).toBeLessThanOrEqual(2000);
      expect(JSON.parse(row.oldValues!)).toEqual({ password: AUDIT_REDACTED });
    });

    it('整体超过 16KB 的值换成摘要，userAgent 截断', async () => {
      const huge = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, 'v'.repeat(1990)]));
      await auditService.log({
        action: 'T_OVERSIZE',
        resourceType: 'test',
        userAgent: 'U'.repeat(50_000),
        newValues: huge,
      });
      const row = await lastRaw('T_OVERSIZE');
      expect(Buffer.byteLength(row.newValues!)).toBeLessThanOrEqual(AUDIT_MAX_JSON_BYTES);
      expect(JSON.parse(row.newValues!)).toMatchObject({ _truncated: true, keys: Object.keys(huge) });
      expect(row.userAgent!.length).toBe(1000);
    });

    it('值的 getter 抛错也不影响调用方', async () => {
      const evil = {
        get token(): string {
          throw new Error('getter boom');
        },
      };
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        await expect(
          auditService.log({ action: 'T_GETTER', resourceType: 'test', newValues: evil }),
        ).resolves.toBeUndefined();
        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(String(errorSpy.mock.calls[0][0])).toContain('T_GETTER');
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  describe('log() 永不抛错', () => {
    it('写库失败时吞掉异常并记服务端日志，日志里不含 oldValues / newValues', async () => {
      const failingRepo = {
        create: (x: unknown) => x,
        save: jest.fn().mockRejectedValue(new Error("Data too long for column 'newValues' at row 1")),
      } as unknown as Repository<AuditLog>;
      const svc = new AuditService(failingRepo, {} as Repository<User>);
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        await expect(
          svc.log({
            action: 'CONTENT_UPDATE',
            resourceType: 'content',
            resourceId: 'c-1',
            newValues: { title: 'secret-draft-title', token: 'tok-123' },
          }),
        ).resolves.toBeUndefined();
        expect(failingRepo.save).toHaveBeenCalledTimes(1);
        expect(errorSpy).toHaveBeenCalledTimes(1);
        const logged = JSON.stringify(errorSpy.mock.calls[0]);
        expect(logged).toContain('CONTENT_UPDATE');
        expect(logged).toContain('c-1');
        expect(logged).toContain('Data too long');
        expect(logged).not.toContain('secret-draft-title');
        expect(logged).not.toContain('tok-123');
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  describe('findAll() 列表字段收敛', () => {
    it('不返回 oldValues / newValues / userAgent，只返回后台页面用到的列', async () => {
      await auditService.log({
        userId: adminId,
        action: 'T_LIST',
        resourceType: 'test',
        resourceId: 'r-1',
        ipAddress: '203.0.113.9',
        userAgent: 'Mozilla/5.0',
        oldValues: { a: 1 },
        newValues: { b: 2 },
      });
      const { data, meta } = await auditService.findAll(1, 20, 'T_LIST');
      expect(meta).toEqual({ total: 1, page: 1, limit: 20, totalPages: 1 });
      expect(Object.keys(data[0]).sort()).toEqual(
        ['action', 'createdAt', 'id', 'ipAddress', 'resourceId', 'resourceType', 'userId', 'username'].sort(),
      );
      expect(data[0]).toMatchObject({
        userId: adminId,
        username: 'admin',
        action: 'T_LIST',
        resourceType: 'test',
        resourceId: 'r-1',
        ipAddress: '203.0.113.9',
      });
      expect(JSON.stringify(data)).not.toMatch(/oldValues|newValues|userAgent|Mozilla/);
    });

    it('分页按 page / limit 切片', async () => {
      for (let i = 0; i < 5; i++) {
        await auditService.log({ action: 'T_PAGE', resourceType: 'test', resourceId: `p-${i}` });
      }
      const first = await auditService.findAll(1, 2, 'T_PAGE');
      const third = await auditService.findAll(3, 2, 'T_PAGE');
      expect(first.data).toHaveLength(2);
      expect(third.data).toHaveLength(1);
      expect(first.meta).toEqual({ total: 5, page: 1, limit: 2, totalPages: 3 });
    });
  });

  describe('调用方只记录变更摘要', () => {
    it('USER_UPDATE：只记白名单字段的前后值与 passwordChanged，不含哈希与明文', async () => {
      const target = await userService.create({
        username: 'bob',
        email: 'bob@cms.test',
        password: 'Bob12345!',
        nickname: '旧昵称',
      } as any);
      await userService.update(
        target.id,
        { nickname: '新昵称', email: 'bob@cms.test', password: 'NewPass123!' } as any,
        adminId,
      );
      const row = await lastRaw('USER_UPDATE');
      expect(JSON.parse(row.newValues!)).toEqual({ nickname: '新昵称', passwordChanged: true });
      expect(JSON.parse(row.oldValues!)).toEqual({ nickname: '旧昵称' });
      expect(`${row.oldValues}${row.newValues}`).not.toMatch(/\$2[aby]\$|NewPass123!|passwordHash/);

      await userService.update(target.id, { nickname: '再改' } as any, adminId);
      expect(JSON.parse((await lastRaw('USER_UPDATE')).newValues!)).toEqual({
        nickname: '再改',
        passwordChanged: false,
      });
    });

    it('CONTENT_UPDATE：只记变更字段名，不记正文', async () => {
      const content = await ds.getRepository(Content).save({
        title: 't',
        slug: 'audit-c',
        body: 'old body',
        authorId: adminId,
      });
      const body = '草稿正文'.repeat(5000);
      await contentService.update(content.id, { title: 't', body, excerpt: '摘要' }, adminId, ['admin']);
      const row = await lastRaw('CONTENT_UPDATE');
      expect(JSON.parse(row.newValues!)).toEqual({ changedFields: ['body', 'excerpt'] });
      expect(row.newValues).not.toContain('草稿正文');
    });

    it('采集源 create / update / 分类映射：apiUrl 只记 host，请求头只记名称，不记请求体原文', async () => {
      const sources = new Map<string, any>();
      const sourceRepo = {
        create: (x: any) => ({ ...x }),
        save: async (x: any) => {
          const saved = { id: x.id ?? 'src-1', ...x };
          sources.set(saved.id, { ...saved });
          return saved;
        },
        findOne: async ({ where }: any) => ({ ...sources.get(where.id), categoryMappings: [] }),
      };
      const mappingRepo = {
        findOne: async () => null,
        create: (x: any) => ({ ...x }),
        save: async (x: any) => ({ id: 'map-1', ...x }),
      };
      const svc = new CollectSourceService(sourceRepo as any, mappingRepo as any, auditService);

      await svc.create(
        {
          name: '资源站',
          apiUrl: 'https://res.example.com/api.php/provide/vod?key=QUERY-SECRET',
          extraHeaders: { Authorization: 'Bearer HEADER-SECRET', Cookie: 'sid=COOKIE-SECRET' },
        },
        adminId,
      );
      const created = await lastRaw('CREATE');
      expect(JSON.parse(created.newValues!)).toEqual({
        name: '资源站',
        apiHost: 'res.example.com',
        extraHeaders: { Authorization: AUDIT_REDACTED, Cookie: AUDIT_REDACTED },
      });

      await svc.update(
        'src-1',
        {
          name: '资源站',
          apiUrl: 'https://res2.example.com/api.php?key=QUERY-SECRET-2',
          extraHeaders: { 'X-Api-Key': 'K-SECRET' },
          userAgent: 'UA-CUSTOM',
          bogus: 'arbitrary client field',
        } as any,
        adminId,
      );
      const updated = await lastRaw('UPDATE');
      expect(JSON.parse(updated.newValues!)).toEqual({
        changedFields: ['apiUrl', 'extraHeaders', 'userAgent', 'bogus'],
        apiHost: 'res2.example.com',
        extraHeaders: { 'X-Api-Key': AUDIT_REDACTED },
      });

      await svc.upsertMapping(
        'src-1',
        { sourceCategoryId: '1', sourceCategoryName: '电影', localCategoryId: null, enabled: true, extra: 'x' } as any,
        adminId,
      );
      const mapping = await lastRaw('UPSERT');
      expect(JSON.parse(mapping.newValues!)).toEqual({
        sourceId: 'src-1',
        sourceCategoryId: '1',
        sourceCategoryName: '电影',
        localCategoryId: null,
        enabled: true,
      });

      const all = await ds.query("SELECT newValues FROM audit_logs WHERE resourceType LIKE 'collect%'");
      const text = JSON.stringify(all);
      for (const secret of ['QUERY-SECRET', 'HEADER-SECRET', 'COOKIE-SECRET', 'K-SECRET', 'UA-CUSTOM', 'arbitrary']) {
        expect(text).not.toContain(secret);
      }
    });

    it('影视 / 剧集 / 小说 / 漫画更新：只记变更字段名', async () => {
      const movie = { id: 'm-1', title: 'old', slug: 'm', description: 'd', sources: [] };
      const movieRepo = { findOne: async () => ({ ...movie }), update: jest.fn() };
      const episodeRepo = { findOne: async () => ({ id: 'e-1', title: 'ep', url: 'https://v/1.m3u8' }), update: jest.fn() };
      const movieSvc = new MovieService(movieRepo as any, {} as any, episodeRepo as any, auditService);
      jest.spyOn(movieSvc, 'findOne').mockResolvedValue(movie as any);
      await movieSvc.update(
        'm-1',
        { title: 'new', description: '简介'.repeat(3000), publishedAt: '2026-01-01T00:00:00Z', sources: [{}] } as any,
        adminId,
      );
      expect(JSON.parse((await lastRaw('MOVIE_UPDATE')).newValues!)).toEqual({
        changedFields: ['title', 'description', 'publishedAt'],
      });
      await movieSvc.updateEpisode('e-1', { url: 'https://v/2.m3u8?token=EP-SECRET' } as any, adminId);
      const ep = await lastRaw('MOVIE_EPISODE_UPDATE');
      expect(JSON.parse(ep.newValues!)).toEqual({ changedFields: ['url'] });
      expect(ep.newValues).not.toContain('EP-SECRET');

      const novelRepo = { findOne: async () => ({ id: 'n-1', title: 'n', slug: 'n', description: 'x' }), update: jest.fn() };
      const novelSvc = new NovelService(novelRepo as any, {} as any, auditService);
      await novelSvc.update('n-1', { description: '长简介'.repeat(3000), title: 'n' } as any, adminId);
      expect(JSON.parse((await lastRaw('NOVEL_UPDATE')).newValues!)).toEqual({ changedFields: ['description'] });

      const comicRepo = { findOne: async () => ({ id: 'c-1', title: 'c', slug: 'c' }), update: jest.fn() };
      const comicSvc = new ComicService(comicRepo as any, {} as any, auditService);
      await comicSvc.update('c-1', { title: 'c2', slug: 'c' } as any, adminId);
      expect(JSON.parse((await lastRaw('COMIC_UPDATE')).newValues!)).toEqual({ changedFields: ['title'] });

      const raw = JSON.stringify(
        await ds.query("SELECT newValues FROM audit_logs WHERE action IN ('MOVIE_UPDATE','NOVEL_UPDATE')"),
      );
      expect(raw).not.toContain('简介');
    });
  });
});
