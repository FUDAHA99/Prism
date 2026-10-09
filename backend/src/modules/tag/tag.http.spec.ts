import { Repository } from 'typeorm';
import { TagController } from './tag.controller';
import { TagService } from './tag.service';
import { Tag } from './entities/tag.entity';
import { createHttpHarness, HttpHarness, Who } from '../../common/testing/http-harness';

/**
 * 标签写接口走真实 HTTP：请求体按后台标签弹窗（frontend/src/pages/Tag/index.tsx）提交的 { name, slug } 构造；
 * slug 格式与后台表单一致，编辑时名称 / slug 不能改成 null 或空串，service 逐字段写库（usageCount 不经接口）。
 */

jest.setTimeout(60_000);

describe('标签接口 HTTP', () => {
  let h: HttpHarness;
  let repo: Repository<Tag>;
  let service: TagService;

  async function make(slug: string, usageCount = 0): Promise<Tag> {
    const saved = await repo.save(repo.create({ name: `标签-${slug}`, slug, usageCount }));
    return repo.findOneByOrFail({ id: saved.id });
  }

  beforeAll(async () => {
    h = await createHttpHarness({ controllers: [TagController], providers: [TagService], entities: [Tag] });
    repo = h.ds.getRepository(Tag);
    service = h.moduleRef.get(TagService);
  });

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await repo.clear();
  });

  it.each<Who>(['editor', 'admin'])('%s：后台弹窗新建、原样再保存、改名', async (who) => {
    const res = await h.post('/tags', who, { name: 'JavaScript', slug: 'javascript' }).expect(201);
    const id = res.body.data.id;
    await h.patch(`/tags/${id}`, who, { name: 'JavaScript', slug: 'javascript' }).expect(200);
    await h.patch(`/tags/${id}`, who, { name: 'JS', slug: 'js' }).expect(200);
    expect(await repo.findOneByOrFail({ id })).toMatchObject({ name: 'JS', slug: 'js', usageCount: 0 });
  });

  it.each<[string, object, string]>([
    ['缺名称', { slug: 'a' }, '标签名称不能为空'],
    ['名称超长', { name: 'x'.repeat(101), slug: 'a' }, '标签名称不能超过 100 个字符'],
    ['缺 slug', { name: 'a' }, 'slug 不能为空'],
    ['slug 不合格式', { name: 'a', slug: 'C++ 语言' }, 'slug 只能包含小写字母、数字和连字符'],
    ['带 usageCount', { name: 'a', slug: 'a', usageCount: 999 }, 'property usageCount should not exist'],
    ['带 id', { name: 'a', slug: 'a', id: '00000000-0000-4000-8000-000000000001' }, 'property id should not exist'],
  ])('新建：%s → 400', async (_label, body, message) => {
    const res = await h.post('/tags', 'admin', body).expect(400);
    expect(res.body.message).toBe(message);
    expect(await repo.count()).toBe(0);
  });

  it('编辑：null / 空串 / 非法 slug / 计数字段 → 400，一列不变（此前能把名称改成空串）', async () => {
    const tag = await make('keep', 5);
    for (const body of [{ name: null }, { name: '' }, { slug: null }, { slug: '' }, { slug: 'Bad' }, { usageCount: 0 }]) {
      await h.patch(`/tags/${tag.id}`, 'admin', body).expect(400);
    }
    expect(await repo.findOneByOrFail({ id: tag.id })).toEqual(tag);
  });

  it('名称 / slug 与别的标签重复 → 409', async () => {
    await make('taken');
    const other = await make('other');
    await h.post('/tags', 'admin', { name: '标签-taken', slug: 'fresh' }).expect(409);
    await h.patch(`/tags/${other.id}`, 'admin', { slug: 'taken' }).expect(409);
  });

  it('绕过管道直接调 service：usageCount / id 写不进库；空提交不发 UPDATE', async () => {
    const created = await service.create({ name: 'direct', slug: 'direct', usageCount: 99, id: 'x' } as never);
    expect(await repo.findOneByOrFail({ id: created.id })).toMatchObject({ usageCount: 0 });
    await service.update(created.id, { name: 'renamed', usageCount: 42 } as never);
    expect(await repo.findOneByOrFail({ id: created.id })).toMatchObject({ name: 'renamed', usageCount: 0 });

    const spy = jest.spyOn(repo, 'update');
    try {
      await h.patch(`/tags/${created.id}`, 'admin', {}).expect(200);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('搜索参数：只认一个字符串，数组 / 对象 / 超长 / 多余参数 → 400（此前原样拼进 LIKE）', async () => {
    await make('vue');
    await make('react');
    const ok = await h.get('/tags?search=vue', 'anonymous').expect(200);
    expect(ok.body.data.map((t: Tag) => t.slug)).toEqual(['vue']);
    for (const qs of ['search=a&search=b', 'search[x]=1', `search=${'x'.repeat(101)}`, 'page=1']) {
      await h.get(`/tags?${qs}`, 'anonymous').expect(400);
    }
  });

  it('游客 401、无角色用户 403；门户读标签列表照常', async () => {
    await h.post('/tags', 'anonymous', { name: 'a', slug: 'a' }).expect(401);
    await h.post('/tags', 'plain', { name: 'a', slug: 'a' }).expect(403);
    await make('pub', 3);
    const res = await h.get('/tags', 'anonymous').expect(200);
    expect(res.body.data).toEqual([expect.objectContaining({ name: '标签-pub', slug: 'pub', usageCount: 3 })]);
  });
});
