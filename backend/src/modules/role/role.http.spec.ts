import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { Repository } from 'typeorm';
import { RoleController } from './role.controller';
import { RoleService } from './role.service';
import { Role } from './entities/role.entity';
import { Permission } from './entities/permission.entity';
import { CreateRoleDto, ROLE_PERMISSIONS_MAX } from './dto/role.dto';
import { createHttpHarness, HttpHarness } from '../../common/testing/http-harness';
import { globalValidationPipeOptions } from '../../common/pipes/global-validation';

/**
 * 角色接口（仅 admin）的请求体走真实 HTTP：新建与改名的命名规则、保留名、isSystem 不可写、权限分配的 ids 校验。
 * 请求体按后台角色页（frontend/src/pages/Role/index.tsx）提交的 { name, description } / { permissionIds } 构造。
 * 角色改名 / 删除对持有者立即生效、系统角色不可改删见 role-assignment.spec.ts。
 */

const NAME_MESSAGE = '角色名须以小写字母开头，只能包含小写字母、数字、下划线和连字符，长度 2–50';
const RESERVED_MESSAGE = "'user' 是注册用户的默认角色名，不能手工创建或改成这个名字";

jest.setTimeout(60_000);

describe('角色接口请求体 HTTP', () => {
  let h: HttpHarness;
  let roles: Repository<Role>;
  let permissions: Repository<Permission>;

  beforeAll(async () => {
    h = await createHttpHarness({ controllers: [RoleController], providers: [] });
    roles = h.ds.getRepository(Role);
    permissions = h.ds.getRepository(Permission);
  });

  afterAll(async () => {
    await h?.close();
  });

  async function legacyRole(name: string): Promise<Role> {
    const saved = await roles.save(roles.create({ name, description: '规则上线前建的' }));
    return roles.findOneByOrFail({ id: saved.id });
  }

  describe('POST /roles', () => {
    it('后台弹窗：{ name, description } 201，isSystem 为 false', async () => {
      const res = await h.post('/roles', 'admin', { name: 'reviewer', description: '审核员' }).expect(201);
      expect(res.body.data).toMatchObject({ name: 'reviewer', description: '审核员', isSystem: false });
      await h.post('/roles', 'admin', { name: 'mod_2-x' }).expect(201);
    });

    it.each([
      ['Admin'],
      ['ADMIN'],
      ['ａdmin'], // 全角
      ['аdmin'], // 西里尔字母 а
      ['admin '],
      [' admin'],
      ['内容审核'],
      ['1editor'],
      ['a'],
      ['x'.repeat(51)],
      ['has space'],
      ['dot.name'],
    ])('角色名 %p → 400', async (name) => {
      const res = await h.post('/roles', 'admin', { name }).expect(400);
      expect(res.body.message).toBe(NAME_MESSAGE);
    });

    it("保留名 'user' → 400（自助注册会自动分配它）", async () => {
      const res = await h.post('/roles', 'admin', { name: 'user' }).expect(400);
      expect(res.body.message).toBe(RESERVED_MESSAGE);
      expect(await roles.findOneBy({ name: 'user' })).toBeNull();
    });

    it.each<[string, object, string]>([
      ['缺 name（此前匹配到第一条角色、误报重名）', {}, '角色名不能为空'],
      ['name 为空串', { name: '' }, '角色名不能为空'],
      ['name 是数组', { name: ['reviewer'] }, 'name must be a string'],
      ['带 isSystem', { name: 'sneaky', isSystem: true }, 'property isSystem should not exist'],
      ['带 id', { name: 'sneaky', id: '00000000-0000-4000-8000-000000000001' }, 'property id should not exist'],
      ['带 permissions', { name: 'sneaky', permissions: [] }, 'property permissions should not exist'],
    ])('%s → 400', async (_label, body, message) => {
      const res = await h.post('/roles', 'admin', body).expect(400);
      expect(res.body.message).toBe(message);
      expect(await roles.findOneBy({ name: 'sneaky' })).toBeNull();
    });

    it('重名 → 409', async () => {
      await h.post('/roles', 'admin', { name: 'dup-role' }).expect(201);
      await h.post('/roles', 'admin', { name: 'dup-role' }).expect(409);
    });

    it('仅 admin：editor 403', async () => {
      await h.post('/roles', 'editor', { name: 'by-editor' }).expect(403);
    });
  });

  describe('PATCH /roles/:id', () => {
    it('后台编辑弹窗：名字原样回传、只改描述 → 200（规则上线前的旧名字也行）', async () => {
      for (const legacyName of ['内容审核', 'Moderator', 'user']) {
        const role = await legacyRole(legacyName);
        await h.patch(`/roles/${role.id}`, 'admin', { name: legacyName, description: '新描述' }).expect(200);
        expect(await roles.findOneByOrFail({ id: role.id })).toMatchObject({ name: legacyName, description: '新描述' });
      }
    });

    it('改名：新名字须符合规则且不是保留名', async () => {
      const role = await legacyRole('Legacy-Name');
      let res = await h.patch(`/roles/${role.id}`, 'admin', { name: 'Still-Bad' }).expect(400);
      expect(res.body.message).toBe(NAME_MESSAGE);
      res = await h.patch(`/roles/${role.id}`, 'admin', { name: 'user' }).expect(400);
      expect(res.body.message).toBe(RESERVED_MESSAGE);
      await h.patch(`/roles/${role.id}`, 'admin', { name: 'legacy-fixed' }).expect(200);
      expect((await roles.findOneByOrFail({ id: role.id })).name).toBe('legacy-fixed');
    });

    it('带 isSystem / id / createdAt → 400，一列不变', async () => {
      const role = await legacyRole('plain-role');
      for (const body of [{ isSystem: true }, { id: 'x' }, { createdAt: '2020-01-01T00:00:00.000Z' }, { name: null }, { name: 'x'.repeat(51) }]) {
        await h.patch(`/roles/${role.id}`, 'admin', body).expect(400);
      }
      expect(await roles.findOneByOrFail({ id: role.id })).toEqual(role);
    });
  });

  describe('两层各自把关（DTO 与 service）', () => {
    const pipe = new ValidationPipe(globalValidationPipeOptions());
    const asBody = (value: object) => pipe.transform(value, { type: 'body', metatype: CreateRoleDto, data: '' });

    it('DTO 本身拒绝不合规则的名字与保留名', async () => {
      await expect(asBody({ name: 'Admin' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(asBody({ name: 'user' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(asBody({ name: 'reviewer' })).resolves.toBeInstanceOf(CreateRoleDto);
    });

    it('绕过管道直接调 service：同样拒绝；请求体里的 isSystem / id 写不进库', async () => {
      const service = h.moduleRef.get(RoleService);
      await expect(service.create({ name: 'Admin' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.create({ name: 'user' })).rejects.toBeInstanceOf(BadRequestException);
      const victim = await legacyRole('victim-role');
      const created = await service.create({ name: 'direct-role', isSystem: true, id: victim.id } as never);
      expect(created.id).not.toBe(victim.id);
      expect(await roles.findOneByOrFail({ id: created.id })).toMatchObject({ name: 'direct-role', isSystem: false });
      expect(await roles.findOneByOrFail({ id: victim.id })).toEqual(victim);
    });
  });

  describe('POST /roles/:id/permissions', () => {
    let role: Role;
    let perms: Permission[];

    beforeAll(async () => {
      role = await legacyRole('perm-holder');
      perms = await permissions.save([
        permissions.create({ name: '查看内容', code: 'content:read', module: 'content' }),
        permissions.create({ name: '编辑内容', code: 'content:write', module: 'content' }),
      ]);
    });

    it('后台权限弹窗：整组替换；重复 ID 不再误报不存在；空数组清空', async () => {
      await h.post(`/roles/${role.id}/permissions`, 'admin', { permissionIds: perms.map((p) => p.id) }).expect(201);
      let stored = await roles.findOneOrFail({ where: { id: role.id }, relations: ['permissions'] });
      expect(stored.permissions.map((p) => p.code).sort()).toEqual(['content:read', 'content:write']);

      await h.post(`/roles/${role.id}/permissions`, 'admin', { permissionIds: [perms[0].id, perms[0].id] }).expect(201);
      stored = await roles.findOneOrFail({ where: { id: role.id }, relations: ['permissions'] });
      expect(stored.permissions.map((p) => p.code)).toEqual(['content:read']);

      await h.post(`/roles/${role.id}/permissions`, 'admin', { permissionIds: [] }).expect(201);
      stored = await roles.findOneOrFail({ where: { id: role.id }, relations: ['permissions'] });
      expect(stored.permissions).toEqual([]);
    });

    it.each<[string, object, string]>([
      ['缺 permissionIds（此前 In(undefined) 500）', {}, 'permissionIds 必须是数组'],
      ['不是数组', { permissionIds: 'abc' }, 'permissionIds 必须是数组'],
      ['元素不是 UUID', { permissionIds: ['abc'] }, 'permissionIds 的每一项都必须是权限 ID'],
      [
        '超过上限',
        { permissionIds: Array.from({ length: ROLE_PERMISSIONS_MAX + 1 }, () => '00000000-0000-4000-8000-000000000001') },
        `permissionIds 最多 ${ROLE_PERMISSIONS_MAX} 个`,
      ],
      ['多余字段', { permissionIds: [], roleId: 'x' }, 'property roleId should not exist'],
    ])('%s → 400', async (_label, body, message) => {
      const res = await h.post(`/roles/${role.id}/permissions`, 'admin', body).expect(400);
      expect(res.body.message).toBe(message);
    });

    it('不存在的权限 ID → 404', async () => {
      await h
        .post(`/roles/${role.id}/permissions`, 'admin', { permissionIds: ['00000000-0000-4000-8000-0000000000ff'] })
        .expect(404);
    });
  });
});
