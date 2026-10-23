import { ConfigService } from '@nestjs/config';
import { JwtStrategy } from './jwt.strategy';
import { JwtPayload } from '../interfaces/auth.interface';
import { accessBlacklistKey } from '../token-blacklist.util';
import { validAfterKey } from '../token-revocation';

/** HTTP 回归覆盖正常鉴权；这里注入依赖故障，确认不能放行，也不把内部错误暴露给客户端。 */
describe('JwtStrategy 依赖故障', () => {
  const payload: JwtPayload = {
    sub: 'user-1',
    email: 'user@cms.test',
    username: 'user',
    roles: ['admin'],
    type: 'access',
    jti: 'access-jti',
    iat: Math.floor(Date.now() / 1000),
  };
  let cache: { get: jest.Mock };
  let auth: { validateUserFromPayload: jest.Mock };
  let strategy: JwtStrategy;

  beforeEach(() => {
    cache = { get: jest.fn().mockResolvedValue(undefined) };
    auth = { validateUserFromPayload: jest.fn() };
    strategy = new JwtStrategy(
      new ConfigService({ app: { jwt: { secret: 'strategy-unit-test-only-secret' } } }),
      auth as never,
      cache as never,
    );
  });

  it.each([
    ['注销黑名单', accessBlacklistKey(payload.jti)],
    ['改密吊销标记', validAfterKey(payload.sub)],
  ])('%s 读取失败 → 401，不继续加载用户', async (_label, failedKey) => {
    cache.get.mockImplementation(async (key: string) => {
      if (key === failedKey) throw new Error('cache connection detail');
      return undefined;
    });

    await expect(strategy.validate(payload)).rejects.toMatchObject({
      status: 401,
      message: 'Token验证失败',
    });
    expect(auth.validateUserFromPayload).not.toHaveBeenCalled();
  });

  it('当前用户查询失败 → 401，不采信 token 内的 admin 角色，也不暴露数据库错误', async () => {
    auth.validateUserFromPayload.mockRejectedValue(new Error('database connection detail'));

    await expect(strategy.validate(payload)).rejects.toMatchObject({
      status: 401,
      message: 'Token验证失败',
    });
  });
});
