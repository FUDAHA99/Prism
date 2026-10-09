import { Repository } from 'typeorm';
import { UserController } from './user.controller';
import { User } from './entities/user.entity';
import { Role } from '../role/entities/role.entity';
import { NICKNAME_TAKEN_MESSAGE, USERNAME_TAKEN_AS_NICKNAME_MESSAGE } from './display-name';
import { AuthController } from '../auth/auth.controller';
import { SiteSetting } from '../site-setting/entities/site-setting.entity';
import { SiteSettingService } from '../site-setting/site-setting.service';
import { createHttpHarness, HttpHarness } from '../../common/testing/http-harness';

/**
 * 显示名唯一（批次 1-F-3，见 display-name.ts）：一个名字最多属于一个账号。
 *
 * 1-F-2 只约束了游客昵称；自助注册、后台新建 / 编辑都能把昵称写成管理员的名字，门户上就出现顶着「注册用户」
 * 标识的「站长」。这里走真实 HTTP 验证注册（POST /auth/register）、后台新建（POST /users）、后台编辑
 * （PATCH /users/:id）三处入口：昵称规范化后不能与其他未删除账号的用户名或昵称相同；用户名也不能是别人的昵称
 * （没有昵称时门户显示用户名）。本人的名字、没改的昵称不算冲突。PATCH /auth/me 的同一规则见 profile.http.spec.ts。
 *
 * 内存 SQLite 的 = 区分大小写；生产 MySQL（utf8mb4_unicode_ci）下大小写、重音不同的写法同样冲突，那部分在
 * 一次性 MySQL 8 容器里验证（见提交说明）。这里用规范化本身就能折叠的写法（全角、零宽字符）。
 */

jest.setTimeout(60_000);

const PASSWORD = 'Regist123!';

describe('显示名唯一：注册 / 后台新建 / 后台编辑', () => {
  let h: HttpHarness;
  let users: Repository<User>;

  const row = (id: string) => users.findOneByOrFail({ id });
  const register = (username: string, nickname: string) =>
    h.post('/auth/register', 'anonymous', { username, email: `${username}@cms.test`, password: PASSWORD, nickname });
  const createUser = (username: string, nickname?: string) =>
    h.post('/users', 'admin', { username, email: `${username}@cms.test`, password: PASSWORD, nickname });

  beforeAll(async () => {
    h = await createHttpHarness({
      controllers: [UserController, AuthController],
      providers: [SiteSettingService],
      entities: [SiteSetting],
    });
    users = h.ds.getRepository(User);
    // 注册默认关闭（见 registration.http.spec.ts）；这里验证的是开放注册时的昵称规则
    await h.ds.getRepository(SiteSetting).update({ key: 'enable_register' }, { value: 'true' });
  });

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    // editor 的昵称用 ASCII，才能拿来验证「用户名不能是别人的昵称」（用户名只收 ASCII）
    await users.update(h.ids.editor, { nickname: 'chief' });
    await users.update(h.ids.plain, { nickname: 'plain-昵称', username: 'plain' });
  });

  describe('POST /auth/register', () => {
    it.each<[string, string]>([
      ['其他用户的用户名', 'admin'],
      ['其他用户的昵称', 'plain-昵称'],
      ['全角写法的管理员用户名', 'ａｄｍｉｎ'],
      ['夹带零宽字符的管理员用户名', 'ad​min'],
      ['夹带双向控制符的昵称', '‮plain-昵称‬'],
    ])('昵称与%s相同 → 409，不建账号', async (_label, nickname) => {
      const before = await users.count();
      const res = await register('impostor', nickname).expect(409);
      expect(res.body.message).toBe(NICKNAME_TAKEN_MESSAGE);
      expect(await users.count()).toBe(before);
    });

    it('用户名与其他用户的昵称相同 → 409（不填昵称时门户显示用户名）', async () => {
      const res = await register('chief', '另一个名字').expect(409);
      expect(res.body.message).toBe(USERNAME_TAKEN_AS_NICKNAME_MESSAGE);
      expect(await users.findOneBy({ username: 'chief' })).toBeNull();
    });

    it('不冲突的昵称：201，存规范化之后的值', async () => {
      const res = await register('newbie', '  新人​  ').expect(201);
      expect(res.body.data.user.nickname).toBe('新人');
      expect((await row(res.body.data.user.id)).nickname).toBe('新人');
      // 之后别人不能再用这个昵称，也不能用它的用户名当昵称
      await register('newbie2', '新人').expect(409);
      await register('newbie3', 'newbie').expect(409);
    });

    it('规范化后只剩 1 个字 / 为空 → 400（昵称在注册时必填，与此前一样）', async () => {
      const short = await register('shorty', ' 甲​ ').expect(400);
      expect(short.body.message).toBe('昵称长度不能少于2个字符');
      await register('blank', '​⠀ ').expect(400);
    });
  });

  describe('POST /users（后台新建）', () => {
    it.each<[string, string]>([
      ['其他用户的用户名', 'editor'],
      ['其他用户的昵称', 'chief'],
      ['全角写法的其他用户名', 'ｅｄｉｔｏｒ'],
    ])('昵称与%s相同 → 409，不建账号', async (_label, nickname) => {
      const before = await users.count();
      const res = await createUser('someone', nickname).expect(409);
      expect(res.body.message).toBe(NICKNAME_TAKEN_MESSAGE);
      expect(await users.count()).toBe(before);
    });

    it('用户名与其他用户的昵称相同（含大写写法，入库前转小写）→ 409', async () => {
      for (const username of ['chief', 'Chief']) {
        const res = await createUser(username).expect(409);
        expect(res.body.message).toBe(USERNAME_TAKEN_AS_NICKNAME_MESSAGE);
      }
      expect(await users.findOneBy({ username: 'chief' })).toBeNull();
    });

    it('不填昵称、或昵称不冲突：201，昵称存规范化之后的值', async () => {
      const a = await createUser('staff_a').expect(201);
      expect(a.body.data.nickname ?? null).toBeNull();
      const b = await createUser('staff_b', '  ＳＴＡＦＦ Ｂ ').expect(201);
      expect((await row(b.body.data.id)).nickname).toBe('STAFF B');
    });
  });

  describe('PATCH /users/:id（后台编辑）', () => {
    it.each<[string, string]>([
      ['其他用户的用户名', 'admin'],
      ['其他用户的昵称', 'chief'],
      ['夹带零宽字符的其他用户名', 'adm​in'],
    ])('昵称改成与%s相同 → 409，昵称不变', async (_label, nickname) => {
      const res = await h.patch(`/users/${h.ids.plain}`, 'admin', { nickname }).expect(409);
      expect(res.body.message).toBe(NICKNAME_TAKEN_MESSAGE);
      expect((await row(h.ids.plain)).nickname).toBe('plain-昵称');
    });

    it('改成该用户自己的用户名、原样提交原昵称都可以；null / 空串清空', async () => {
      await h.patch(`/users/${h.ids.plain}`, 'admin', { nickname: 'plain-昵称', isActive: true }).expect(200);
      await h.patch(`/users/${h.ids.plain}`, 'admin', { nickname: 'plain' }).expect(200);
      expect((await row(h.ids.plain)).nickname).toBe('plain');
      await h.patch(`/users/${h.ids.plain}`, 'admin', { nickname: '' }).expect(200);
      expect((await row(h.ids.plain)).nickname).toBeNull();
    });

    it('存量重名不挡住编辑弹窗的真实提交（昵称原样回传 + 改启用状态）', async () => {
      const twin = await users.save({
        username: 'twin',
        email: 'twin@cms.test',
        passwordHash: 'x',
        nickname: 'plain-昵称',
      } as Partial<User>);
      try {
        await h.patch(`/users/${h.ids.plain}`, 'admin', { nickname: 'plain-昵称', isActive: false }).expect(200);
        expect(await row(h.ids.plain)).toMatchObject({ nickname: 'plain-昵称', isActive: false });
      } finally {
        await users.delete(twin.id);
        await users.update(h.ids.plain, { isActive: true });
      }
    });

    it('用户名改成其他用户的昵称 → 409；改成不冲突的名字 → 200', async () => {
      const res = await h.patch(`/users/${h.ids.plain}`, 'admin', { username: 'chief' }).expect(409);
      expect(res.body.message).toBe(USERNAME_TAKEN_AS_NICKNAME_MESSAGE);
      expect((await row(h.ids.plain)).username).toBe('plain');
      await h.patch(`/users/${h.ids.plain}`, 'admin', { username: 'plain2' }).expect(200);
      expect((await row(h.ids.plain)).username).toBe('plain2');
    });

    it('自己的昵称就是新用户名时不算冲突（只排除其他账号）', async () => {
      await users.update(h.ids.plain, { nickname: 'plainx' });
      await h.patch(`/users/${h.ids.plain}`, 'admin', { username: 'plainx' }).expect(200);
      expect((await row(h.ids.plain)).username).toBe('plainx');
    });

    /**
     * 1-F-3 复审 medium：规范化上线之前写入的存量昵称可能是全角仿冒的管理员昵称（当时允许）。编辑弹窗原样回传它时，
     * 此前拿规范化之后的提交值（'SiteAdmin'）与库里未规范化的原值比，被当成「改了」去查重 → 409，
     * 而查重在改启用状态之前：管理员没法通过编辑弹窗停用或降权这个仿冒账号，看到的错误还与操作无关。
     * 现在两边都按规范化后的写法比较，没改就不查重、也不写库（不会被改写成与管理员一模一样的 'SiteAdmin'）。
     */
    describe('存量账号的全角仿冒昵称（规范化后与管理员昵称相同）', () => {
      const IMITATION = 'ＳｉｔｅＡｄｍｉｎ';
      let legacyId: string;
      let editorRoleId: string;

      beforeEach(async () => {
        await users.update(h.ids.admin, { nickname: 'SiteAdmin' });
        const legacy = await users.save({
          username: 'legacy1',
          email: 'legacy1@cms.test',
          passwordHash: 'x',
          nickname: IMITATION,
          isActive: true,
        } as Partial<User>);
        legacyId = legacy.id;
        editorRoleId = (await h.ds.getRepository(Role).findOneByOrFail({ name: 'editor' })).id;
        await h.ds.query('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', [legacyId, editorRoleId]);
      });

      afterEach(async () => {
        await h.ds.query('DELETE FROM user_roles WHERE user_id = ?', [legacyId]);
        await users.delete(legacyId);
        await users.update(h.ids.admin, { nickname: null } as Partial<User>);
      });

      it('编辑弹窗的停用 + 降权（昵称没改就不提交）：PATCH 200、remove-roles 201，昵称原样不动', async () => {
        await h.patch(`/users/${legacyId}`, 'admin', { isActive: false }).expect(200);
        const demoted = await h.post(`/users/${legacyId}/remove-roles`, 'admin', { roleIds: [editorRoleId] }).expect(201);
        expect(demoted.body.data.roles).toEqual([]);
        expect(await row(legacyId)).toMatchObject({ nickname: IMITATION, isActive: false });
      });

      it('旧客户端原样回传存量昵称 + 停用 → 200：不查重、昵称不被改写成管理员的规范写法', async () => {
        await h.patch(`/users/${legacyId}`, 'admin', { nickname: IMITATION, isActive: false }).expect(200);
        expect(await row(legacyId)).toMatchObject({ nickname: IMITATION, isActive: false });
        // 规范写法本身也算「没改」（同一个显示名）
        await h.patch(`/users/${legacyId}`, 'admin', { nickname: 'SiteAdmin' }).expect(200);
        expect((await row(legacyId)).nickname).toBe(IMITATION);
      });

      it('真的改了昵称照样查重：改成他人的名字 409；改成不冲突的名字 200，存规范化后的值', async () => {
        const taken = await h.patch(`/users/${legacyId}`, 'admin', { nickname: 'chief', isActive: false }).expect(409);
        expect(taken.body.message).toBe(NICKNAME_TAKEN_MESSAGE);
        expect(await row(legacyId)).toMatchObject({ nickname: IMITATION, isActive: true });
        await h.patch(`/users/${legacyId}`, 'admin', { nickname: ' 旧账号​ ' }).expect(200);
        expect((await row(legacyId)).nickname).toBe('旧账号');
      });
    });
  });
});
