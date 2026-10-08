import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { LoginDto } from './login.dto';
import { RegisterDto } from './register.dto';
import { CreateUserDto } from '../../user/dto/create-user.dto';
import { UpdateUserDto } from '../../user/dto/update-user.dto';
import { globalValidationPipeOptions } from '../../../common/pipes/global-validation';
import { ASCII_EMAIL_PATTERN } from './account-email.decorator';

/**
 * 登录 / 注册只收 ASCII 邮箱（批次 1-F-1 复审：锁定可被 unicode_ci 等价写法绕过）。
 *
 * users.email 是 utf8mb4_unicode_ci。在一次性 MySQL 8.0 容器里实测：
 * - 可打印 ASCII（0x21-0x7E）两两之间，除大小写外没有任何相等关系；
 * - 0x01-0x08、0x0E-0x1F、0x7F 是可忽略字符：'adm' + X + 'in@cms.com' = 'admin@cms.com'；
 * - 重音 / 组合附加符、全角、零宽空格、非 ASCII 域名都与 ASCII 原文相等；
 * - 尾部空格相等（PAD SPACE）。
 * 下面每一种都必须在 DTO 层被拒（400），客户端字符串转小写后才与库认定的账号一一对应。
 */
const UNICODE_CI_EQUIVALENTS: Array<[string, string]> = [
  ['预组合重音 á', 'ádmin@cms.com'],
  ['组合重音 a + U+0301', 'ádmin@cms.com'],
  ['组合点 i + U+0307', 'admi̇n@cms.com'],
  ['全角 ａ', 'ａdmin@cms.com'],
  ['全角 @', 'admin＠cms.com'],
  ['零宽空格', 'ad​min@cms.com'],
  ['零宽连接符', 'ad‍min@cms.com'],
  ['软连字符', 'ad­min@cms.com'],
  ['可忽略控制字符 0x01', 'adm\u0001in@cms.com'],
  ['可忽略控制字符 0x1F', 'adm\u001fin@cms.com'],
  ['DEL 0x7F', 'adm\u007fin@cms.com'],
  ['非 ASCII 域名 ś', 'admin@cmś.com'],
  ['非 ASCII 顶级域 ö', 'admin@cms.cöm'],
  ['中间夹空格', 'ad min@cms.com'],
];

type EmailDto = typeof LoginDto | typeof RegisterDto | typeof CreateUserDto | typeof UpdateUserDto;

/** 各 DTO 除邮箱外的合法字段 */
const BASE_FIELDS = new Map<EmailDto, Record<string, unknown>>([
  [LoginDto, { password: 'Admin123!' }],
  [RegisterDto, { username: 'someone', password: 'Admin123!', nickname: '某人' }],
  [CreateUserDto, { username: 'someone', password: 'Admin123!' }],
  [UpdateUserDto, { nickname: '某人' }],
]);

async function emailErrors(cls: EmailDto, email: unknown) {
  const base = BASE_FIELDS.get(cls);
  const dto = plainToInstance(cls as new () => { email?: string }, { ...base, email } as Record<string, unknown>);
  const errors = await validate(dto);
  return { dto, errors: errors.filter((e) => e.property === 'email') };
}

describe.each([
  ['LoginDto', LoginDto],
  ['RegisterDto', RegisterDto],
  ['CreateUserDto（后台新建用户）', CreateUserDto],
  ['UpdateUserDto（后台编辑用户）', UpdateUserDto],
])('%s.email 只收 ASCII', (_name, cls: EmailDto) => {
  it.each(UNICODE_CI_EQUIVALENTS)('%s → 拒绝', async (_label, email) => {
    const { errors } = await emailErrors(cls, email);
    expect(errors).toHaveLength(1);
  });

  it('ASCII 写法照常通过，并归一化为去空白的小写', async () => {
    const { dto, errors } = await emailErrors(cls, '  Admin.Ops+cms@Example-Site.COM ');
    expect(errors).toEqual([]);
    expect(dto.email).toBe('admin.ops+cms@example-site.com');
  });

  it.each([[undefined], [null], [42], [['admin@cms.com']], [{ $ne: '' }], ['']])('非字符串 / 空值 %j → 拒绝', async (email) => {
    const { errors } = await emailErrors(cls, email);
    // 编辑用户时邮箱可以不传（只改昵称等），不传就不校验
    const optional = cls === UpdateUserDto && (email === undefined || email === null);
    expect(errors).toHaveLength(optional ? 0 : 1);
  });

  it('两条都不过时第一条提示是「请输入有效的邮箱地址」', async () => {
    const { errors } = await emailErrors(cls, 'ádmin@cms.com');
    expect(Object.values(errors[0].constraints ?? {})[0]).toBe('请输入有效的邮箱地址');
  });
});

describe('后台新建 / 编辑用户经全局 ValidationPipe（whitelist + forbidNonWhitelisted）', () => {
  const pipe = new ValidationPipe(globalValidationPipeOptions());
  const body = (metatype: ArgumentMetadata['metatype']): ArgumentMetadata => ({ type: 'body', metatype, data: '' });

  it.each([
    ['CreateUserDto', CreateUserDto, { username: 'staff', password: 'Staff123!', email: 'staff@例子.中国' }],
    ['UpdateUserDto', UpdateUserDto, { email: 'staff@例子.中国' }],
    ['UpdateUserDto（带重音）', UpdateUserDto, { email: 'josé@example.com' }],
  ])('%s 非 ASCII 邮箱 → 400「邮箱只能包含英文字母、数字和常用符号」或「请输入有效的邮箱地址」', async (_n, cls, payload) => {
    await expect(pipe.transform(payload, body(cls))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ASCII 邮箱照常通过并归一化；编辑时不带邮箱也通过', async () => {
    const created = await pipe.transform(
      { username: 'staff', password: 'Staff123!', email: ' Staff@Example.COM ' },
      body(CreateUserDto),
    );
    expect(created.email).toBe('staff@example.com');
    const updated = await pipe.transform({ email: 'New.Mail@Example.com', isActive: true }, body(UpdateUserDto));
    expect(updated.email).toBe('new.mail@example.com');
    await expect(pipe.transform({ nickname: '某人' }, body(UpdateUserDto))).resolves.toEqual(
      expect.objectContaining({ nickname: '某人' }),
    );
  });
});

describe('ASCII_EMAIL_PATTERN', () => {
  it('恰好覆盖可打印 ASCII 0x21-0x7E（不含空格与控制字符）', () => {
    for (let cp = 0; cp <= 0x7f; cp += 1) {
      const ch = String.fromCharCode(cp);
      expect({ cp, ok: ASCII_EMAIL_PATTERN.test(`a${ch}b`) }).toEqual({ cp, ok: cp >= 0x21 && cp <= 0x7e });
    }
    expect(ASCII_EMAIL_PATTERN.test('admin@cms.com\n')).toBe(false);
  });
});
