import { Repository } from 'typeorm';
import { UserController } from './user.controller';
import { User } from './entities/user.entity';
import { createHttpHarness, HttpHarness } from '../../common/testing/http-harness';

/**
 * PATCH /users/:id/status（仅 admin）的请求体走真实 HTTP：isActive 必须是 JSON 布尔，缺失 / 字符串 / 多余字段 400
 * （此前缺失时 500，字符串 "false" 原样写进布尔列）。
 */

jest.setTimeout(60_000);

describe('启用 / 禁用用户 HTTP', () => {
  let h: HttpHarness;
  let users: Repository<User>;

  beforeAll(async () => {
    h = await createHttpHarness({ controllers: [UserController], providers: [] });
    users = h.ds.getRepository(User);
  });

  afterAll(async () => {
    await h?.close();
  });

  it('admin 禁用、再启用别的用户', async () => {
    await h.patch(`/users/${h.ids.plain}/status`, 'admin', { isActive: false }).expect(200);
    expect((await users.findOneByOrFail({ id: h.ids.plain })).isActive).toBe(false);
    await h.patch(`/users/${h.ids.plain}/status`, 'admin', { isActive: true }).expect(200);
    expect((await users.findOneByOrFail({ id: h.ids.plain })).isActive).toBe(true);
  });

  it.each<[string, object, string]>([
    ['缺 isActive（此前 500）', {}, 'isActive 不能为空'],
    ['null', { isActive: null }, 'isActive 不能为空'],
    ['字符串 "false"', { isActive: 'false' }, 'isActive 必须是 true 或 false'],
    ['数字 0', { isActive: 0 }, 'isActive 必须是 true 或 false'],
    ['多余字段', { isActive: false, email: 'x@y.com' }, 'property email should not exist'],
  ])('%s → 400，用户状态不变', async (_label, body, message) => {
    const res = await h.patch(`/users/${h.ids.plain}/status`, 'admin', body).expect(400);
    expect(res.body.message).toBe(message);
    expect((await users.findOneByOrFail({ id: h.ids.plain })).isActive).toBe(true);
  });

  it('不能禁用自己；editor 403', async () => {
    await h.patch(`/users/${h.ids.admin}/status`, 'admin', { isActive: false }).expect(400);
    await h.patch(`/users/${h.ids.plain}/status`, 'editor', { isActive: false }).expect(403);
  });
});
