import 'reflect-metadata';
import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { globalValidationPipeOptions } from '../../../common/pipes/global-validation';
import { AUDIT_LOG_MAX_LIMIT, QueryAuditLogDto } from './query-audit-log.dto';

/**
 * 用与 main.ts 完全相同的全局 ValidationPipe 校验 GET /audit-logs 的查询参数（查询串里的值都是字符串）。
 * 修复前直接 parseInt：limit 无上限可整表导出，limit=abc / 负数会 500。
 */

const pipe = new ValidationPipe(globalValidationPipeOptions());
const meta: ArgumentMetadata = { type: 'query', metatype: QueryAuditLogDto, data: undefined };
const validate = (query: Record<string, string>) => pipe.transform(query, meta) as Promise<QueryAuditLogDto>;

async function rejects(query: Record<string, string>): Promise<string[]> {
  try {
    await validate(query);
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    return ((err as BadRequestException).getResponse() as { message: string[] }).message;
  }
  throw new Error(`期望 400，但校验通过了：${JSON.stringify(query)}`);
}

describe('QueryAuditLogDto（全局 ValidationPipe）', () => {
  it('不带参数时取默认值 page=1、limit=20', async () => {
    const dto = await validate({});
    expect(dto).toBeInstanceOf(QueryAuditLogDto);
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(20);
    expect(dto.action).toBeUndefined();
  });

  it('后台「操作日志」页的真实请求可以通过（frontend/src/pages/AuditLog：page、limit=20、可选 action）', async () => {
    expect(await validate({ page: '3', limit: '20' })).toMatchObject({ page: 3, limit: 20 });
    expect(await validate({ page: '1', limit: '20', action: 'USER_LOGIN' })).toMatchObject({
      page: 1,
      limit: 20,
      action: 'USER_LOGIN',
    });
    // 下拉里有后端并不产生的动作（ROLE_ASSIGN）：只是筛不到数据，不能 400
    expect((await validate({ action: 'ROLE_ASSIGN' })).action).toBe('ROLE_ASSIGN');
  });

  it(`limit 上限 ${AUDIT_LOG_MAX_LIMIT}，不能一次导出整表`, async () => {
    expect((await validate({ limit: String(AUDIT_LOG_MAX_LIMIT) })).limit).toBe(AUDIT_LOG_MAX_LIMIT);
    expect((await rejects({ limit: '101' })).join()).toMatch(/limit/);
    expect((await rejects({ limit: '100000' })).join()).toMatch(/limit/);
  });

  it.each([
    ['limit', '0'],
    ['limit', '-1'],
    ['limit', 'abc'],
    ['limit', '1.5'],
    ['page', '0'],
    ['page', '-3'],
    ['page', 'abc'],
    ['page', '1e21'],
  ])('%s=%s 返回 400 而不是 500', async (key, value) => {
    expect((await rejects({ [key]: value })).join()).toMatch(new RegExp(key));
  });

  it('action 限长且只允许字母数字下划线', async () => {
    await rejects({ action: 'A'.repeat(101) });
    await rejects({ action: "USER_LOGIN' OR 1=1 --" });
    await rejects({ action: 'USER LOGIN' });
  });

  it('action 为空串视为不筛选（控制器把空串当 undefined）', async () => {
    expect((await validate({ action: '' })).action).toBe('');
  });

  it('未声明的参数 400（forbidNonWhitelisted）', async () => {
    expect((await rejects({ userId: 'x' })).join()).toMatch(/userId/);
  });
});
