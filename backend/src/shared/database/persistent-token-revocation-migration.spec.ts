import { QueryRunner } from 'typeorm';
import { PersistentTokenRevocation1792713600000 } from './migrations/1792713600000-PersistentTokenRevocation';

/** 仅验证迁移决策与 SQL 合约；未连接 MySQL，不作为真实迁移验收。 */
describe('PersistentTokenRevocation migration', () => {
  it('创建独立撤销表及过期索引，使用数据库时间建立永久全局基线', async () => {
    const runner = { hasTable: jest.fn().mockResolvedValue(false), query: jest.fn().mockResolvedValue(undefined) };
    await new PersistentTokenRevocation1792713600000().up(runner as unknown as QueryRunner);
    expect(runner.hasTable).toHaveBeenCalledWith('token_revocations');
    expect(runner.query).toHaveBeenCalledTimes(2);
    expect(runner.query.mock.calls[0][0]).toMatch(/CREATE TABLE `token_revocations`/);
    expect(runner.query.mock.calls[0][0]).toMatch(/PRIMARY KEY \(`key`\)/);
    expect(runner.query.mock.calls[0][0]).toMatch(/INDEX `IDX_token_revocations_expiresAt` \(`expiresAt`\)/);
    expect(runner.query.mock.calls[1][0]).toMatch(/'auth:valid-after:global', FLOOR\(UNIX_TIMESTAMP\(CURRENT_TIMESTAMP\(3\)\) \* 1000\), NULL/);
  });

  it('拒绝未经登记的既有表，不覆盖已有撤销状态', async () => {
    const runner = { hasTable: jest.fn().mockResolvedValue(true), query: jest.fn() };
    await expect(new PersistentTokenRevocation1792713600000().up(runner as unknown as QueryRunner))
      .rejects.toThrow('token_revocations 已存在但迁移未登记');
    expect(runner.query).not.toHaveBeenCalled();
  });

  it('禁止自动回滚，避免删除撤销状态后重新放行旧 token', async () => {
    await expect(new PersistentTokenRevocation1792713600000().down()).rejects.toThrow('撤销状态禁止自动删除或回滚');
  });
});
