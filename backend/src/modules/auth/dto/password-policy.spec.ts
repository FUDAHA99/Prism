import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { globalValidationPipeOptions } from '../../../common/pipes/global-validation';
import { CreateUserDto } from '../../user/dto/create-user.dto';
import { ChangePasswordDto } from './change-password.dto';
import { passwordPolicyMessages } from './password-policy';

/**
 * 口令策略只有一份（password-policy.ts）：本人改密与后台新建用户经全局 ValidationPipe 得到同样的裁决，
 * 提示只差字段名（「新密码」/「密码」）。改密的提示文案与抽出共用策略之前逐字相同。
 */

const pipe = new ValidationPipe(globalValidationPipeOptions());
const meta = (metatype: ArgumentMetadata['metatype']): ArgumentMetadata => ({ type: 'body', metatype, data: '' });

/** 通过返回 null，否则返回第一条提示（HttpExceptionFilter 只把第一条放进 message） */
async function firstMessage(metatype: ArgumentMetadata['metatype'], payload: object): Promise<string | null> {
  try {
    await pipe.transform(payload, meta(metatype));
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    const { message } = (error as BadRequestException).getResponse() as { message: string[] };
    return message[0];
  }
}

const SAMPLES: unknown[] = [
  'Abc12345',
  'a1'.repeat(36),
  'a1'.repeat(36) + 'x',
  '密码'.repeat(11) + 'a1',
  '密码'.repeat(12) + 'a1',
  '😀😀😀😀😀😀a1',
  '😀😀😀😀😀a1',
  'a1b2❤️❤️❤️❤️',
  'a1❤️❤️❤️',
  'Ab1',
  'abc',
  '!!!!',
  'abcdefgh',
  '12345678',
  '1'.repeat(80),
  'a'.repeat(80),
  'é1234567',
  '        ',
  '',
  undefined,
  null,
  { $gt: '' },
];

describe('口令策略（password-policy.ts）', () => {
  it('改密的提示与抽出共用策略之前逐字相同', () => {
    expect(passwordPolicyMessages('新密码')).toEqual({
      type: '新密码必须是字符串',
      minLength: '新密码长度不能少于 8 位',
      maxBytes: '新密码过长（不能超过 72 字节，约 72 个英文字符或 24 个汉字）',
      letter: '新密码必须包含字母',
      digit: '新密码必须包含数字',
    });
  });

  it.each(SAMPLES.map((value) => [JSON.stringify(value) ?? 'undefined', value]))(
    '%s：新建用户与本人改密裁决相同，提示只差字段名',
    async (_label, value) => {
      const created = await firstMessage(CreateUserDto, { username: 'staff', email: 'staff@cms.test', password: value });
      const changed = await firstMessage(ChangePasswordDto, { currentPassword: 'Start123!', newPassword: value });
      expect(created).toBe(changed === null ? null : changed.replace(/^新密码/, '密码'));
    },
  );
});
