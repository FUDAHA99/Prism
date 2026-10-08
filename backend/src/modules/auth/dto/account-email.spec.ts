import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LoginDto } from './login.dto';
import { RegisterDto } from './register.dto';
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

async function emailErrors(cls: typeof LoginDto | typeof RegisterDto, email: unknown) {
  const base =
    cls === LoginDto
      ? { password: 'Admin123!' }
      : { username: 'someone', password: 'Admin123!', nickname: '某人' };
  const dto = plainToInstance(cls, { ...base, email });
  const errors = await validate(dto);
  return { dto, errors: errors.filter((e) => e.property === 'email') };
}

describe.each([
  ['LoginDto', LoginDto],
  ['RegisterDto', RegisterDto],
])('%s.email 只收 ASCII', (_name, cls) => {
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
    expect(errors).toHaveLength(1);
  });

  it('两条都不过时第一条提示是「请输入有效的邮箱地址」', async () => {
    const { errors } = await emailErrors(cls, 'ádmin@cms.com');
    expect(Object.values(errors[0].constraints ?? {})[0]).toBe('请输入有效的邮箱地址');
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
