import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, dirname, join, resolve } from 'path';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Repository } from 'typeorm';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { MediaFile } from './entities/media-file.entity';
import { createHttpHarness, HttpHarness, Who } from '../../common/testing/http-harness';

const fs: typeof import('fs/promises') = require('fs/promises');

// 小限额只用于验证 multipart 拒绝后没有落盘，不代替生产 MediaModule 的限额配置门禁。
const TEST_FILE_LIMIT = 1024;
@Module({
  imports: [MulterModule.registerAsync({
    useFactory: () => ({
      storage: memoryStorage(),
      defParamCharset: 'utf8',
      limits: { fileSize: TEST_FILE_LIMIT, files: 1 },
    }),
  })],
  exports: [MulterModule],
})
class TestUploadsModule {}

jest.setTimeout(60_000);

describe('媒体上传文件持久化 HTTP', () => {
  let h: HttpHarness;
  let temp: string;
  let uploads: string;
  let repo: Repository<MediaFile>;
  let service: MediaService;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

  function checkTemporaryPaths() {
    expect(dirname(resolve(temp))).toBe(resolve(tmpdir()));
    expect(basename(temp)).toMatch(/^prism-media-test-/);
    expect(resolve(uploads)).toBe(join(resolve(temp), 'uploads'));
  }

  beforeAll(async () => {
    temp = await mkdtemp(join(tmpdir(), 'prism-media-test-'));
    uploads = join(temp, 'uploads');
    h = await createHttpHarness({
      controllers: [MediaController],
      providers: [MediaService],
      imports: [TestUploadsModule],
      configureApp: (app) => {
        app.get(ConfigService).set('app.upload.dest', uploads);
        app.useStaticAssets(app.get(MediaService).uploadDirectory, { prefix: '/uploads/' });
      },
    });
    repo = h.ds.getRepository(MediaFile);
    service = h.app.get(MediaService);
  });

  beforeEach(async () => {
    await repo.clear();
    // uploads 是本测试 mkdtemp 目录的固定子目录，不清理仓库或其他上传目录。
    checkTemporaryPaths();
    await rm(uploads, { recursive: true, force: true });
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await h?.close();
    if (temp) {
      checkTemporaryPaths();
      await rm(temp, { recursive: true, force: true });
    }
  });

  const upload = (who: Who = 'editor', bytes = png, filename = '封面.html', contentType = 'image/png') =>
    h.as(h.http().post('/media/upload'), who).attach('file', bytes, { filename, contentType });

  const record = (filename: string) => ({
    filename, originalName: '封面.png', mimeType: 'image/png', size: png.length,
    url: `/uploads/${filename}`, uploaderId: h.ids.editor,
  });

  const storedNames = () => readdir(uploads).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });

  async function expectNoUpload() {
    expect(await repo.count()).toBe(0);
    expect(await storedNames()).toEqual([]);
  }

  it('上传成功即有真实文件，中文原名仅作元数据，公开 GET/HEAD/Range 可读取', async () => {
    const file = (await upload().expect(201)).body.data.data;
    expect(file.filename).toMatch(/^[a-f0-9-]{36}\.png$/);
    expect(file.originalName).toBe('封面.html');
    expect(file.url).toBe(`/uploads/${file.filename}`);
    expect(await repo.findOneByOrFail({ id: file.id })).toMatchObject({
      filename: file.filename, originalName: '封面.html', mimeType: 'image/png', size: png.length,
    });
    expect(await readFile(join(uploads, file.filename))).toEqual(png);
    const download = await h.http().get(file.url).expect(200).expect('Content-Type', /image\/png/);
    expect(download.body).toEqual(png);
    await h.http().head(file.url).expect(200).expect('Content-Length', String(png.length));
    const partial = await h.http().get(file.url).set('Range', 'bytes=0-7').expect(206)
      .expect('Content-Range', `bytes 0-7/${png.length}`);
    expect(partial.body).toEqual(png.subarray(0, 8));
    expect(await readdir(uploads)).toEqual([file.filename]);
  });

  it.each(['editor', 'admin'] as const)('%s 可以删除 editor 上传的文件和记录', async (who) => {
    const file = (await upload().expect(201)).body.data.data;
    await h.del(`/media/${file.id}`, who).expect(204);
    await expectNoUpload();
    await h.http().get(file.url).expect(404);
  });

  it('非上传者 editor 删除被拒绝，原文件和记录都保留', async () => {
    const file = (await upload('admin').expect(201)).body.data.data;
    await h.del(`/media/${file.id}`, 'editor').expect(403);
    expect(await readFile(join(uploads, file.filename))).toEqual(png);
    expect(await repo.findOneBy({ id: file.id })).not.toBeNull();
  });

  it('历史上只有记录没有文件，仍可删除记录', async () => {
    const file = await repo.save(record('legacy.png'));
    await h.del(`/media/${file.id}`, 'editor').expect(204);
    await expectNoUpload();
  });

  it.each(['text/html', 'image/svg+xml'])('拒绝 %s，且不留下文件或记录', async (mime) => {
    await upload('editor', Buffer.from('<svg></svg>'), 'bad.svg', mime).expect(400);
    await expectNoUpload();
  });

  it('没有文件返回 400，不创建文件或记录', async () => {
    await h.post('/media/upload', 'editor').expect(400);
    await expectNoUpload();
  });

  it.each([['anonymous', 401], ['plain', 403]] as const)('%s 不能上传', async (who, status) => {
    await upload(who).expect(status);
    await expectNoUpload();
  });

  it('超过测试用 multipart 上限返回 413，不创建文件或记录', async () => {
    await upload('editor', Buffer.alloc(TEST_FILE_LIMIT + 1)).expect(413);
    await expectNoUpload();
  });

  it('上传目录不可创建时失败，不写入数据库', async () => {
    await writeFile(uploads, png); // 同名普通文件阻止 mkdir，不依赖运行测试的账户权限。
    await upload().expect(500);
    expect(await repo.count()).toBe(0);
    expect(await readFile(uploads)).toEqual(png);
  });

  it('写到一半失败，关闭句柄并删除本次已创建的部分文件', async () => {
    const realOpen = fs.open;
    jest.spyOn(fs, 'open').mockImplementationOnce(async (path, flags, mode) => {
      const handle = await realOpen(path, flags, mode);
      const realWrite = handle.writeFile.bind(handle);
      jest.spyOn(handle, 'writeFile').mockImplementationOnce(async () => {
        await realWrite(png.subarray(0, 4));
        throw Object.assign(new Error('injected write failure'), { code: 'ENOSPC' });
      });
      return handle;
    });
    await upload().expect(500);
    await expectNoUpload();
  });

  it('数据库保存失败，删除本次写入的文件', async () => {
    jest.spyOn(repo, 'save').mockRejectedValueOnce(new Error('injected save failure'));
    await upload().expect(500);
    await expectNoUpload();
  });

  it('同名文件已存在时不得覆盖，也不得当成本次失败残留而删除', async () => {
    await mkdir(uploads);
    const original = Buffer.from('existing file');
    await writeFile(join(uploads, 'collision.png'), original);
    await expect(service.saveFile(record('collision.png'), png)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(join(uploads, 'collision.png'))).toEqual(original);
    expect(await storedNames()).toEqual(['collision.png']);
    expect(await repo.count()).toBe(0);
  });

  it('unlink 非 ENOENT 错误保留文件和记录，重试可完成删除', async () => {
    const file = (await upload().expect(201)).body.data.data;
    jest.spyOn(fs, 'unlink').mockRejectedValueOnce(Object.assign(new Error('injected unlink failure'), { code: 'EACCES' }));
    await h.del(`/media/${file.id}`, 'editor').expect(500);
    expect(await readFile(join(uploads, file.filename))).toEqual(png);
    expect(await repo.findOneBy({ id: file.id })).not.toBeNull();
    await h.del(`/media/${file.id}`, 'editor').expect(204);
    await expectNoUpload();
  });

  it('文件已删但数据库删除失败时保留记录，下次经 ENOENT 分支可完成', async () => {
    const file = (await upload().expect(201)).body.data.data;
    jest.spyOn(repo, 'delete').mockRejectedValueOnce(new Error('injected delete failure'));
    await h.del(`/media/${file.id}`, 'editor').expect(500);
    expect(await storedNames()).toEqual([]);
    expect(await repo.findOneBy({ id: file.id })).not.toBeNull();
    await h.del(`/media/${file.id}`, 'editor').expect(204);
    await expectNoUpload();
  });

  it.each(['../outside.png', '..\\outside.png'])('拒绝旧记录中的越界文件名 %s', async (filename) => {
    const outside = join(temp, 'outside.png');
    await writeFile(outside, png);
    const file = await repo.save(record(filename));
    await h.del(`/media/${file.id}`, 'admin').expect(400);
    expect(await readFile(outside)).toEqual(png);
    expect(await repo.findOneBy({ id: file.id })).not.toBeNull();
  });
});
