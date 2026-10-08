import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { instanceToPlain } from 'class-transformer';
import { DataSource, Repository } from 'typeorm';

import { User } from './entities/user.entity';
import { UserService } from './user.service';
import { USER_SUMMARY_COLUMNS } from './user-fields';
import { Role } from '../role/entities/role.entity';
import { Permission } from '../role/entities/permission.entity';
import { RoleService } from '../role/role.service';
import { AuditLog } from '../audit/entities/audit-log.entity';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { MediaFile } from '../media/entities/media-file.entity';
import { MediaService } from '../media/media.service';
import { Content, ContentStatus } from '../content/entities/content.entity';
import { ContentService } from '../content/content.service';
import { Category } from '../category/entities/category.entity';
import { Comment } from '../comment/entities/comment.entity';
import { StatsService } from '../stats/stats.service';
import { AuthUser } from '../auth/interfaces/auth.interface';

/**
 * 密码哈希不出库（批次 1-F-1）。
 *
 * 用真实 TypeORM + 内存 SQLite 跑真实 service，而不是 mock 仓库：要验证的正是 select:false、addSelect、
 * 关联 join 的列选择这些只有真实查询才会体现的行为。出参统一过一遍 JSON 序列化（等价于响应体）和
 * instanceToPlain（等价于 ClassSerializerInterceptor），断言里既查键名也查哈希值本身。
 */

const ADMIN_PASSWORD = 'Admin123!';
/** 内容列表的后台视图：findAll 按 viewer 的角色选择全量 / 公开视图 */
const STAFF_VIEWER = { id: 'staff-viewer', roles: ['admin'] } as AuthUser;
const EDITOR_PASSWORD = 'Editor123!';

/** 模拟 Redis：值按 JSON 存取，和生产缓存一样会丢掉 class 原型（@Exclude 因此失效） */
class JsonCache {
  readonly store = new Map<string, string>();
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

/** 响应体视角：JSON 序列化后的文本，以及经 ClassSerializerInterceptor 同款转换后的文本 */
function serialized(value: unknown): string[] {
  return [JSON.stringify(value), JSON.stringify(instanceToPlain(value))];
}

describe('密码哈希不出库：用户与关联查询只取安全字段', () => {
  let ds: DataSource;
  let userRepo: Repository<User>;
  let cache: JsonCache;
  let roleService: RoleService;
  let auditService: AuditService;
  let userService: UserService;
  let authService: AuthService;
  let mediaService: MediaService;
  let contentService: ContentService;
  let statsService: StatsService;
  let adminId: string;
  let editorId: string;
  let mediaId: string;
  let contentId: string;
  const hashes: string[] = [];

  /** 断言出参里既没有 passwordHash 键，也没有任何一个真实哈希值 */
  function expectNoHash(value: unknown): void {
    for (const text of serialized(value)) {
      expect(text).not.toMatch(/passwordHash|password_hash/i);
      expect(text).not.toMatch(/\$2[aby]\$\d\d\$/);
      for (const h of hashes) expect(text).not.toContain(h);
    }
  }

  function expectNoEmail(value: unknown): void {
    for (const text of serialized(value)) {
      expect(text).not.toMatch(/"email"|@cms\.test/);
    }
  }

  async function refreshHashes(): Promise<void> {
    // 只有显式 addSelect 才能取到哈希：用它来收集"不许出现的值"
    const rows = await userRepo
      .createQueryBuilder('u')
      .addSelect('u.passwordHash')
      .withDeleted()
      .getMany();
    hashes.splice(0, hashes.length, ...rows.map((r) => r.passwordHash));
    expect(hashes.every((h) => /^\$2[aby]\$/.test(h))).toBe(true);
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

    userRepo = ds.getRepository(User);
    cache = new JsonCache();
    roleService = new RoleService(ds.getRepository(Role), ds.getRepository(Permission), cache as any);
    auditService = new AuditService(ds.getRepository(AuditLog), userRepo);
    userService = new UserService(userRepo, roleService, auditService, cache as any);
    authService = new AuthService(
      userService,
      roleService,
      auditService,
      new JwtService({ secret: 'unit-test-secret', signOptions: { expiresIn: '2h' } }),
      new ConfigService({
        app: { jwt: { refreshSecret: 'unit-test-refresh-secret', refreshExpiresIn: 7 * 24 * 3600 } },
      }),
      cache as any,
    );
    mediaService = new MediaService(ds.getRepository(MediaFile), auditService);
    contentService = new ContentService(ds.getRepository(Content), auditService);
    statsService = new StatsService(
      ds.getRepository(Content),
      userRepo,
      ds.getRepository(MediaFile),
      ds.getRepository(Comment),
      null as any, // movie / novel / comic 只用于 getSystemInfo，仪表盘不涉及
      null as any,
      null as any,
    );

    const admin = await userService.create({
      username: 'admin',
      email: 'admin@cms.test',
      password: ADMIN_PASSWORD,
      nickname: '管理员',
      avatarUrl: '/uploads/a.png',
    } as any);
    adminId = admin.id;
    const editor = await userService.create({
      username: 'editor',
      email: 'editor@cms.test',
      password: EDITOR_PASSWORD,
    } as any);
    editorId = editor.id;

    const adminRole = await ds.getRepository(Role).save({ name: 'admin', isSystem: true });
    await ds.query('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', [adminId, adminRole.id]);

    // 同时写 uploaderId 与 uploader 关联：实体里 uploader 关联走的是另一列 uploader_id，
    // 而 saveFileRecord 只写 uploaderId，只写它的话 join 恒为空、断言就成了空转
    const media = await ds.getRepository(MediaFile).save({
      filename: 'f.png',
      originalName: 'f.png',
      mimeType: 'image/png',
      size: 1,
      url: '/uploads/f.png',
      uploaderId: adminId,
      uploader: { id: adminId } as User,
    });
    mediaId = media.id;

    const content = await ds.getRepository(Content).save({
      title: 't',
      slug: 's',
      body: 'b',
      authorId: adminId,
      // 已发布：公开的 slug 详情只返回已发布内容
      status: ContentStatus.PUBLISHED,
      isPublished: true,
    });
    contentId = content.id;

    await refreshHashes();
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  describe('实体与 schema', () => {
    it('passwordHash 列 select:false，列定义（类型 / 长度 / 可空 / 唯一 / 默认值）与改动前一致', () => {
      const column = ds.getMetadata(User).findColumnWithPropertyName('passwordHash')!;
      expect(column.isSelect).toBe(false);
      expect(column.databaseName).toBe('passwordHash');
      expect(column.type).toBe('varchar');
      expect(column.length).toBe('255');
      expect(column.isNullable).toBe(false);
      expect(column.default).toBeUndefined();
      const uniques = ds.getMetadata(User).uniques.flatMap((u) => u.columns.map((c) => c.propertyName));
      expect(uniques).not.toContain('passwordHash');
    });

    it('默认查询（find / findOne / QueryBuilder）都取不到哈希', async () => {
      expectNoHash(await userRepo.find());
      expectNoHash(await userRepo.findOne({ where: { id: adminId } }));
      expectNoHash(await userRepo.createQueryBuilder('u').getMany());
    });
  });

  describe('UserService 出参与缓存', () => {
    const SAFE_KEYS = [
      'avatarUrl', 'createdAt', 'email', 'id', 'isActive', 'lastLoginAt', 'nickname', 'updatedAt',
      'username',
    ];

    it('create 返回值不含哈希（save 后的内存实体本身带着哈希）', async () => {
      const created = await userService.create({
        username: 'tmp',
        email: 'tmp@cms.test',
        password: 'Tmp12345!',
      } as any);
      await refreshHashes();
      expectNoHash(created);
      await userService.remove(created.id);
    });

    it('findAll 每一行只有白名单字段 + roles', async () => {
      const { data } = await userService.findAll({ page: 1, limit: 20 } as any);
      expect(data.map((u) => u.username).sort()).toEqual(['admin', 'editor']);
      expectNoHash(data);
      const admin = data.find((u) => u.id === adminId)!;
      expect(admin.roles).toEqual(['admin']);
      expect(admin.email).toBe('admin@cms.test'); // 管理端用户页需要邮箱
      for (const u of data) {
        expect(Object.keys(u).every((k) => [...SAFE_KEYS, 'roles'].includes(k))).toBe(true);
      }
    });

    it('findOne 只有白名单字段 + roles / permissions，写进缓存的也没有哈希', async () => {
      await cache.del(`user:${adminId}`);
      const user = await userService.findOne(adminId);
      expectNoHash(user);
      expect(user.roles).toEqual(['admin']);
      expect(Object.keys(user).sort()).toEqual([...SAFE_KEYS, 'permissions', 'roles'].sort());
      expect(cache.store.get(`user:${adminId}`)).toBeDefined();
      expectNoHash([...cache.store.values()]);
      // 第二次走缓存
      expectNoHash(await userService.findOne(adminId));
    });

    it('旧版本写入、带着 passwordHash 的缓存条目，读出来也会被过滤', async () => {
      const stale = { ...(await userService.findOne(editorId)), passwordHash: hashes[0], userRoles: [] };
      await cache.set(`user:${editorId}`, stale);
      const user = await userService.findOne(editorId);
      expect(user.username).toBe('editor');
      expectNoHash(user);
      expect(user).not.toHaveProperty('userRoles');
    });

    it('update / toggleStatus 返回值不含哈希', async () => {
      expectNoHash(await userService.update(editorId, { nickname: '编辑' } as any, adminId));
      expectNoHash(await userService.toggleStatus(editorId, true, adminId));
    });
  });

  describe('需要哈希的口令校验路径仍然可用', () => {
    it('validateUser：密码正确返回不含哈希的用户，错误返回 null', async () => {
      const user = await authService.validateUser('admin@cms.test', ADMIN_PASSWORD, { ip: '127.0.0.1' });
      expect(user?.id).toBe(adminId);
      expectNoHash(user);
      expect(await authService.validateUser('admin@cms.test', 'wrong-pass', { ip: '127.0.0.1' })).toBeNull();
      expect(await authService.validateUser('nobody@cms.test', ADMIN_PASSWORD, { ip: '127.0.0.1' })).toBeNull();
    });

    it('login 正常签发 token，响应体不含哈希', async () => {
      const res = await authService.login(
        { email: 'admin@cms.test', password: ADMIN_PASSWORD } as any,
        { ip: '127.0.0.1' },
      );
      expect(res.tokens.accessToken).toEqual(expect.any(String));
      expect(res.user.id).toBe(adminId);
      expectNoHash(res);
      await expect(
        authService.login({ email: 'admin@cms.test', password: 'wrong-pass' } as any, { ip: '127.0.0.2' }),
      ).rejects.toThrow('邮箱或密码错误');
    });

    it('JWT 校验用的 validateUserFromPayload 不含哈希', async () => {
      const user = await authService.validateUserFromPayload({ sub: adminId } as any);
      expect(user?.id).toBe(adminId);
      expectNoHash(user);
    });

    it('changePassword 能取到哈希核对旧密码，改完新密码可登录', async () => {
      await expect(
        authService.changePassword(editorId, 'wrong-pass', 'Editor456!', '127.0.0.1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      await authService.changePassword(editorId, EDITOR_PASSWORD, 'Editor456!', '127.0.0.1');
      await refreshHashes();
      expect(await authService.validateUser('editor@cms.test', EDITOR_PASSWORD, { ip: '127.0.0.1' })).toBeNull();
      const user = await authService.validateUser('editor@cms.test', 'Editor456!', { ip: '127.0.0.1' });
      expect(user?.id).toBe(editorId);
      expectNoHash(user);
    });
  });

  describe('关联到用户的查询只取公开资料列', () => {
    it('媒体列表 / 详情的 uploader 只有 id / username / nickname / avatarUrl', async () => {
      const { data } = await mediaService.findAll({});
      const one = await mediaService.findOne(mediaId);
      for (const file of [data[0], one]) {
        expect(file.id).toBe(mediaId);
        expect(file.uploader).toBeTruthy();
        expect(file.uploader.username).toBe('admin');
        expect(Object.keys(file.uploader).sort()).toEqual([...USER_SUMMARY_COLUMNS].sort());
      }
      expectNoHash(data);
      expectNoHash(one);
      expectNoEmail(data);
      expectNoEmail(one);
    });

    it('内容列表 / 详情 / slug 的 author 不含邮箱与哈希', async () => {
      // 后台视图（含 author.id）与公开视图（游客列表、slug 详情）都查一遍
      const { data } = await contentService.findAll({}, STAFF_VIEWER);
      const { data: publicData } = await contentService.findAll({});
      const byId = await contentService.findOne(contentId);
      const bySlug = await contentService.findPublishedBySlug('s');
      expect(byId.author.username).toBe('admin');
      expect(bySlug.author?.username).toBe('admin');
      expect(publicData).toHaveLength(1);
      for (const v of [data, publicData, byId, bySlug]) {
        expectNoHash(v);
        expectNoEmail(v);
      }
    });

    it('审计日志列表只 join 用户名', async () => {
      const { data } = await auditService.findAll(1, 50);
      expect(data.some((l) => l.username === 'admin')).toBe(true);
      expectNoHash(data);
      // newValues 里记录的邮箱属于审计脱敏（C6）的范围，这里只管 join 进来的用户列
      for (const row of data) {
        expect(Object.keys(row)).not.toContain('email');
        expect(Object.keys(row)).not.toContain('user');
      }
    });

    it('仪表盘只有计数，不含任何用户行（editor 也能看仪表盘）', async () => {
      const stats = await statsService.getDashboardStats();
      expect(Object.keys(stats).sort()).toEqual(['comment', 'content', 'media', 'user']);
      expect(stats.user.total).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(stats)).not.toMatch(/admin|editor/);
      expectNoHash(stats);
      expectNoEmail(stats);
    });
  });
});
