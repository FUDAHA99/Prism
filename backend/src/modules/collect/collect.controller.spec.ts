import 'reflect-metadata';
import { ExecutionContext, Logger, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuthGuard } from '@nestjs/passport';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as request from 'supertest';
import { CollectController } from './collect.controller';
import { CollectSourceService } from './collect-source.service';
import { CollectExecutorService } from './collect-executor.service';
import { CollectSource } from './entities/collect-source.entity';
import { CollectCategoryMapping } from './entities/collect-category-mapping.entity';
import { AuditService } from '../audit/audit.service';
import { RunCollectDto } from './dto/run-collect.dto';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { globalValidationPipeOptions } from '../../common/pipes/global-validation';

/**
 * 采集接口走真实 HTTP：真实 CollectController / CollectSourceService / 全局 ValidationPipe / RolesGuard，
 * 只把 JWT 解析换成「已登录的 admin」，仓库与执行器用 mock。
 * 验证 class DTO 真正接到了路由上，以及「测试连接 / 探查分类」对内网地址的拦截与文案。
 */

const ADMIN_USER = { id: 'admin-id', email: 'admin@cms.com', roles: ['admin'] };
const BLOCKED = '请求采集接口失败：目标地址指向内网、本机或保留地址，已拦截';
const SOURCE_ID = 'a1b2c3d4-0000-4000-8000-000000000001';

const uiCreatePayload = {
  name: '飞速资源',
  apiUrl: 'https://api.example-resource.com/api.php/provide/vod/',
  sourceType: 'maccms_json',
  contentType: 'movie',
  status: 'active',
  sortOrder: 0,
  timeoutSec: 30,
};

describe('CollectController（HTTP）', () => {
  let app: NestExpressApplication;
  let stored: CollectSource;
  const sourceRepo = {
    create: jest.fn((x) => ({ ...x })),
    save: jest.fn(async (x) => ({ id: SOURCE_ID, ...x })),
    findOne: jest.fn(async () => stored),
    remove: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
  const mappingRepo = {
    findOne: jest.fn(async () => null),
    create: jest.fn((x) => ({ ...x })),
    save: jest.fn(async (x) => ({ id: 'm-1', ...x })),
  };
  const executor = {
    startRun: jest.fn(async (_id: string, _dto: RunCollectDto, _userId: string) => ({ logId: 'log-1' })),
    listLogs: jest.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 20 })),
    getLog: jest.fn(),
  };

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      controllers: [CollectController],
      providers: [
        CollectSourceService,
        { provide: CollectExecutorService, useValue: executor },
        { provide: getRepositoryToken(CollectSource), useValue: sourceRepo },
        { provide: getRepositoryToken(CollectCategoryMapping), useValue: mappingRepo },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    })
      .overrideGuard(AuthGuard('jwt'))
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest().user = ADMIN_USER;
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.useGlobalPipes(new ValidationPipe(globalValidationPipeOptions()));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    stored = {
      id: SOURCE_ID,
      name: '库里的旧数据',
      sourceType: 'maccms_json',
      apiUrl: 'http://169.254.169.254/latest/meta-data/',
      contentType: 'movie',
      timeoutSec: 5,
      extraHeaders: null,
      categoryMappings: [],
    } as unknown as CollectSource;
  });

  const http = () => request(app.getHttpServer());

  describe('POST /collect/sources', () => {
    it('后台表单的真实提交 → 201，落库的是校验后的字段', async () => {
      const res = await http()
        .post('/collect/sources')
        .send({ ...uiCreatePayload, extraHeaders: { Referer: 'https://www.example-resource.com/' } });
      expect(res.status).toBe(201);
      expect(sourceRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ apiUrl: uiCreatePayload.apiUrl, extraHeaders: { Referer: 'https://www.example-resource.com/' } }),
      );
    });

    it.each([
      ['http://169.254.169.254/latest/meta-data/', 'apiUrl 不能指向内网、本机或保留地址'],
      ['http://localhost:3000/api/v1/users', 'apiUrl 不能指向内网、本机或保留地址'],
      ['http://[::ffff:127.0.0.1]/', 'apiUrl 不能指向内网、本机或保留地址'],
      ['file:///etc/passwd', 'apiUrl 只允许 http/https 地址'],
    ])('apiUrl=%s → 400「%s」', async (apiUrl, message) => {
      const res = await http().post('/collect/sources').send({ ...uiCreatePayload, apiUrl });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe(message);
      expect(sourceRepo.save).not.toHaveBeenCalled();
    });

    it('extraHeaders 里的 Host / 换行 → 400', async () => {
      for (const extraHeaders of [{ Host: 'internal' }, { 'X-A': 'a\r\nX-B: 1' }]) {
        const res = await http().post('/collect/sources').send({ ...uiCreatePayload, extraHeaders });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/^extraHeaders：/);
      }
    });

    it('多余字段 → 400', async () => {
      const res = await http().post('/collect/sources').send({ ...uiCreatePayload, totalCollected: 1e9 });
      expect(res.status).toBe(400);
    });
  });

  it('PATCH /collect/sources/:id：编辑页带着 null 的可空列回传 → 200', async () => {
    const res = await http()
      .patch(`/collect/sources/${SOURCE_ID}`)
      .send({ ...uiCreatePayload, userAgent: null, defaultPlayFrom: null, remark: null });
    expect(res.status).toBe(200);
  });

  it('PATCH /collect/sources/:id：改成元数据地址 → 400，不落库', async () => {
    const res = await http()
      .patch(`/collect/sources/${SOURCE_ID}`)
      .send({ apiUrl: 'http://100.100.100.200/latest/meta-data/' });
    expect(res.status).toBe(400);
    expect(sourceRepo.save).not.toHaveBeenCalled();
  });

  it('POST /collect/sources/:id/test：库里的元数据地址 → ok:false + 固定文案', async () => {
    const res = await http().post(`/collect/sources/${SOURCE_ID}/test`);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: false, error: BLOCKED });
  });

  it('GET /collect/sources/:id/discover-categories：第一页被拦截 → 400 + 固定文案', async () => {
    const res = await http().get(`/collect/sources/${SOURCE_ID}/discover-categories`);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe(BLOCKED);
  });

  describe('POST /collect/sources/:id/run', () => {
    it('弹窗的提交 → 交给执行器的是校验过的 RunCollectDto', async () => {
      const res = await http().post(`/collect/sources/${SOURCE_ID}/run`).send({ mode: 'hours', hours: 24 });
      expect(res.status).toBe(201);
      const dto = executor.startRun.mock.calls[0][1];
      expect(dto).toBeInstanceOf(RunCollectDto);
      expect(dto).toEqual({ mode: 'hours', hours: 24 });
    });

    it('single 模式缺 vodIds → 400「single 模式必须填写 vodIds」', async () => {
      const res = await http().post(`/collect/sources/${SOURCE_ID}/run`).send({ mode: 'single' });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('single 模式必须填写 vodIds');
      expect(executor.startRun).not.toHaveBeenCalled();
    });

    it('多余字段（会原样进 collect_logs.params）→ 400', async () => {
      const res = await http()
        .post(`/collect/sources/${SOURCE_ID}/run`)
        .send({ mode: 'hours', apiUrl: 'http://169.254.169.254/' });
      expect(res.status).toBe(400);
    });
  });

  describe('分类映射', () => {
    it('POST /mappings/batch：面板保存的内容 → 201', async () => {
      const res = await http()
        .post(`/collect/sources/${SOURCE_ID}/mappings/batch`)
        .send({ items: [{ sourceCategoryId: '6', sourceCategoryName: '动作片', localCategoryId: null }] });
      expect(res.status).toBe(201);
      expect(mappingRepo.save).toHaveBeenCalledTimes(1);
    });

    it('POST /mappings/batch：条目里夹带 sourceId → 400，不落库', async () => {
      const res = await http()
        .post(`/collect/sources/${SOURCE_ID}/mappings/batch`)
        .send({ items: [{ sourceCategoryId: '6', sourceCategoryName: 'x', sourceId: 'other' }] });
      expect(res.status).toBe(400);
      expect(mappingRepo.save).not.toHaveBeenCalled();
    });

    it('POST /mappings：单条', async () => {
      const res = await http()
        .post(`/collect/sources/${SOURCE_ID}/mappings`)
        .send({ sourceCategoryId: '6', sourceCategoryName: '动作片', enabled: true });
      expect(res.status).toBe(201);
    });
  });

  describe('GET /collect/logs', () => {
    it('缺省分页给默认值（此前裸 @Query 会得到 NaN）', async () => {
      const res = await http().get('/collect/logs');
      expect(res.status).toBe(200);
      expect(executor.listLogs).toHaveBeenCalledWith(expect.objectContaining({ page: 1, pageSize: 20 }));
    });

    it('后台日志页的请求', async () => {
      await http().get('/collect/logs').query({ page: 2, pageSize: 50 });
      expect(executor.listLogs).toHaveBeenCalledWith(expect.objectContaining({ page: 2, pageSize: 50 }));
    });

    it('pageSize 超上限 → 400', async () => {
      const res = await http().get('/collect/logs').query({ pageSize: 1000 });
      expect(res.status).toBe(400);
    });

    it.each(['page=abc', 'page=0', 'page=-1', 'page=', 'pageSize=0', 'pageSize=1.5', 'pageSize=abc', 'sourceId[]=x'])(
      '非法分页参数 %s → 400，不会把 NaN / 负数交给查询（此前 500）',
      async (qs) => {
        executor.listLogs.mockClear();
        const res = await http().get(`/collect/logs?${qs}`);
        expect(res.status).toBe(400);
        expect(executor.listLogs).not.toHaveBeenCalled();
      },
    );

    it('只带其中一个分页参数时，另一个取缺省值', async () => {
      await http().get('/collect/logs').query({ page: 3 }).expect(200);
      expect(executor.listLogs).toHaveBeenLastCalledWith(expect.objectContaining({ page: 3, pageSize: 20 }));
      await http().get('/collect/logs').query({ pageSize: 50 }).expect(200);
      expect(executor.listLogs).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, pageSize: 50 }));
    });
  });
});
