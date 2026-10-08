import 'reflect-metadata';
import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { globalValidationPipeOptions, prioritizeConstraints } from './global-validation';
import { CreateContentDto } from '../../modules/content/dto/create-content.dto';
import { RunCollectDto } from '../../modules/collect/dto/run-collect.dto';
import { CollectMode } from '../../modules/collect/entities/collect-log.entity';
import { UserRoleIdsDto } from '../../modules/user/dto/user-role-ids.dto';

/**
 * 全局 ValidationPipe 的报错顺序：漏传必填字段时第一条消息（HttpExceptionFilter 放进 message、前端只显示它）
 * 必须是「必填」而不是 MaxLength / Matches 这类格式消息；校验结果与消息集合本身不变。
 */

class ItemDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(10)
  name: string;
}

class SampleDto {
  // 与仓库里 DTO 的惯常写法相同：必填在上、长度在下（class-validator 自下而上执行，长度消息原本排第一）
  @IsString()
  @IsNotEmpty()
  @MaxLength(5)
  title: string;

  @IsInt()
  @Min(1)
  count: number;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => ItemDto)
  items: ItemDto[];
}

const body = (metatype: ArgumentMetadata['metatype']): ArgumentMetadata => ({ type: 'body', metatype, data: '' });

async function messagesOf(pipe: ValidationPipe, metatype: ArgumentMetadata['metatype'], value: unknown): Promise<string[]> {
  try {
    await pipe.transform(value, body(metatype));
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    const response = (e as BadRequestException).getResponse() as { message: string[] };
    return response.message;
  }
  throw new Error('应当校验失败');
}

describe('全局 ValidationPipe 的报错顺序', () => {
  const pipe = new ValidationPipe(globalValidationPipeOptions());
  // 对照组：Nest 默认的 exceptionFactory，用来证明只改了顺序、没增删消息
  const { exceptionFactory: _ignored, ...withoutFactory } = globalValidationPipeOptions();
  const defaultPipe = new ValidationPipe(withoutFactory);

  it('漏传必填字段：第一条是「必填」消息，而不是长度消息（此前是 MaxLength 排第一）', async () => {
    const valid = { count: 1, items: [{ name: 'a' }] };
    const before = await messagesOf(defaultPipe, SampleDto, valid);
    const after = await messagesOf(pipe, SampleDto, valid);
    expect(before[0]).toBe('title must be shorter than or equal to 5 characters');
    expect(after[0]).toBe('title should not be empty');
    expect([...after].sort()).toEqual([...before].sort());
  });

  it('null 与空串同样先报「必填」', async () => {
    for (const title of [null, '']) {
      const messages = await messagesOf(pipe, SampleDto, { title, count: 1, items: [{ name: 'a' }] });
      expect(messages[0]).toBe('title should not be empty');
    }
  });

  it('类型不对：先报类型，再报长度 / 范围', async () => {
    // 数字会被隐式转换成字符串（enableImplicitConversion），用数组才是真正的类型不对
    const messages = await messagesOf(pipe, SampleDto, { title: ['abcdefgh'], count: 'x', items: [{ name: 'a' }] });
    expect(messages.indexOf('title must be a string')).toBeLessThan(
      messages.indexOf('title must be shorter than or equal to 5 characters'),
    );
    expect(messages.indexOf('count must be an integer number')).toBeLessThan(
      messages.indexOf('count must not be less than 1'),
    );
    expect(messages[0]).toBe('title must be a string');
  });

  it('只是太长：只有长度消息（不会凭空多出必填消息）', async () => {
    const messages = await messagesOf(pipe, SampleDto, { title: 'abcdefgh', count: 1, items: [{ name: 'a' }] });
    expect(messages).toEqual(['title must be shorter than or equal to 5 characters']);
  });

  it('嵌套字段沿用 Nest 的路径前缀，且同样「必填」在前', async () => {
    const messages = await messagesOf(pipe, SampleDto, { title: 'ok', count: 1, items: [{ name: 'a' }, {}] });
    expect(messages[0]).toBe('items.1.name should not be empty');
    expect(messages).toContain('items.1.name must be shorter than or equal to 10 characters');
  });

  it('空数组先报 arrayNotEmpty；缺数组先报 arrayNotEmpty（必填）再报类型', async () => {
    expect((await messagesOf(pipe, SampleDto, { title: 'ok', count: 1, items: [] }))[0]).toBe(
      'items should not be empty',
    );
    const missing = await messagesOf(pipe, SampleDto, { title: 'ok', count: 1 });
    expect(missing[0]).toBe('items should not be empty');
    expect(missing).toContain('items must be an array');
  });

  it('多余字段的 400 不受影响', async () => {
    const messages = await messagesOf(pipe, SampleDto, { title: 'ok', count: 1, items: [{ name: 'a' }], extra: 1 });
    expect(messages).toEqual(['property extra should not exist']);
  });

  it('prioritizeConstraints 不修改入参', () => {
    const errors = [
      { property: 'a', constraints: { maxLength: 'm', isNotEmpty: 'n' }, children: [] },
    ];
    const snapshot = JSON.stringify(errors);
    const out = prioritizeConstraints(errors);
    expect(JSON.stringify(errors)).toBe(snapshot);
    expect(Object.keys(out[0].constraints!)).toEqual(['isNotEmpty', 'maxLength']);
  });

  describe('仓库里真实的 DTO', () => {
    it('内容：漏传标题报「必填」', async () => {
      const messages = await messagesOf(pipe, CreateContentDto, { slug: 'a', body: 'x' });
      expect(messages[0]).toBe('title should not be empty');
    });

    it('采集：single 模式漏传 vodIds 仍是原来的中文提示', async () => {
      const messages = await messagesOf(pipe, RunCollectDto, { mode: CollectMode.SINGLE });
      expect(messages[0]).toBe('single 模式必须填写 vodIds');
    });

    it('角色分配：漏传 roleIds 报「不能为空」，而不是「每一项都必须是角色 ID」', async () => {
      const messages = await messagesOf(pipe, UserRoleIdsDto, {});
      expect(messages[0]).toBe('roleIds 不能为空');
    });
  });
});
