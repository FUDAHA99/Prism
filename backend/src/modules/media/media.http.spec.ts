import { Repository } from 'typeorm';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { MediaFile } from './entities/media-file.entity';
import { MEDIA_LIST_MAX_LIMIT } from './dto/query-media.dto';
import { createHttpHarness, HttpHarness } from '../../common/testing/http-harness';

/**
 * GET /media 的查询参数走真实 HTTP：后台媒体库页的查询串（mimeType、page、limit=18）通过，limit 有上限，
 * isUsed 的 true / false 真正生效（此前是字符串，筛选从未生效），非法值 400 而不是 500。
 */

jest.setTimeout(60_000);

describe('媒体库列表查询参数 HTTP', () => {
  let h: HttpHarness;
  let repo: Repository<MediaFile>;

  beforeAll(async () => {
    h = await createHttpHarness({ controllers: [MediaController], providers: [MediaService] });
    repo = h.ds.getRepository(MediaFile);
    const base = { originalName: 'x', size: 10, uploaderId: h.ids.editor };
    await repo.save([
      repo.create({ ...base, filename: 'a.png', mimeType: 'image/png', url: '/uploads/a.png', isUsed: true }),
      repo.create({ ...base, filename: 'b.jpg', mimeType: 'image/jpeg', url: '/uploads/b.jpg', isUsed: false }),
      repo.create({ ...base, filename: 'c.mp4', mimeType: 'video/mp4', url: '/uploads/c.mp4', isUsed: false }),
    ]);
  });

  afterAll(async () => {
    await h?.close();
  });

  const names = (body: { data: { data: MediaFile[] } }) => body.data.data.map((m) => m.filename).sort();

  it('后台媒体库页的查询串：mimeType=image&page=1&limit=18', async () => {
    const res = await h.get('/media?mimeType=image&page=1&limit=18', 'editor').expect(200);
    expect(names(res.body)).toEqual(['a.png', 'b.jpg']);
    expect(res.body.data.meta).toEqual({ total: 2, page: 1, limit: 18, totalPages: 1 });
  });

  it('不带参数：缺省第 1 页、每页 20', async () => {
    const res = await h.get('/media', 'admin').expect(200);
    expect(res.body.data.meta).toMatchObject({ total: 3, page: 1, limit: 20 });
  });

  it('isUsed=false / true 真正筛选（此前字符串过不了 typeof 判断，筛选被忽略）', async () => {
    expect(names((await h.get('/media?isUsed=false', 'admin').expect(200)).body)).toEqual(['b.jpg', 'c.mp4']);
    expect(names((await h.get('/media?isUsed=true', 'admin').expect(200)).body)).toEqual(['a.png']);
  });

  it(`limit=${MEDIA_LIST_MAX_LIMIT} 可以`, async () => {
    await h.get(`/media?limit=${MEDIA_LIST_MAX_LIMIT}`, 'admin').expect(200);
  });

  it.each([
    `limit=${MEDIA_LIST_MAX_LIMIT + 1}`,
    'limit=abc',
    'limit=0',
    'page=0',
    'page=-1',
    'isUsed=yes',
    'uploaderId=abc',
    'mimeType[]=image',
    'foo=1',
  ])('%s → 400', async (qs) => {
    await h.get(`/media?${qs}`, 'admin').expect(400);
  });

  it('游客 401、无角色用户 403', async () => {
    await h.get('/media', 'anonymous').expect(401);
    await h.get('/media', 'plain').expect(403);
  });
});
