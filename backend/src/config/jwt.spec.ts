import * as fs from 'fs';
import * as path from 'path';
import {
  DEV_JWT_REFRESH_SECRET,
  DEV_JWT_SECRET,
  KNOWN_PLACEHOLDER_SECRETS,
  MAX_TOKEN_LIFETIME_SEC,
  jwtSecretProblems,
  parseTokenLifetime,
  resolveJwtConfig,
} from './jwt';
import configuration from './configuration';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const STRONG = 'a'.repeat(31) + 'Z' + '0123456789abcdef'; // 48 字符
const STRONG_REFRESH = 'b'.repeat(31) + 'Y' + 'fedcba9876543210';

const prod = (extra: Record<string, string | undefined>) => ({ NODE_ENV: 'production', ...extra });

/** 从仓库里的 env 模板读出 KEY=VALUE（模板是受 git 跟踪的那两份） */
function readEnvTemplate(relative: string): Record<string, string> {
  const text = fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

describe('JWT 配置：生产环境密钥启动校验', () => {
  it('合格的两把密钥 + 默认有效期：解析成秒', () => {
    const warn = jest.fn();
    const cfg = resolveJwtConfig(prod({ JWT_SECRET: STRONG, JWT_REFRESH_SECRET: STRONG_REFRESH }), warn);
    expect(cfg).toEqual({
      secret: STRONG,
      refreshSecret: STRONG_REFRESH,
      expiresIn: 2 * 3600,
      refreshExpiresIn: 7 * 86400,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['两者都缺失', {}],
    ['JWT_SECRET 缺失', { JWT_REFRESH_SECRET: STRONG_REFRESH }],
    ['JWT_REFRESH_SECRET 缺失', { JWT_SECRET: STRONG }],
    ['空串（compose 旧写法 ${JWT_SECRET} 未设置时的取值）', { JWT_SECRET: '', JWT_REFRESH_SECRET: STRONG_REFRESH }],
    ['只有空白', { JWT_SECRET: '   ', JWT_REFRESH_SECRET: STRONG_REFRESH }],
    ['短于 32 字符', { JWT_SECRET: 'x'.repeat(31), JWT_REFRESH_SECRET: STRONG_REFRESH }],
    ['两把密钥相同', { JWT_SECRET: STRONG, JWT_REFRESH_SECRET: STRONG }],
  ])('%s → 拒绝启动', (_name, env) => {
    expect(() => resolveJwtConfig(prod(env), jest.fn())).toThrow(/拒绝启动/);
  });

  it.each(KNOWN_PLACEHOLDER_SECRETS.map((s) => [s]))('示例/默认值 %j → 拒绝启动', (placeholder) => {
    expect(() =>
      resolveJwtConfig(prod({ JWT_SECRET: placeholder, JWT_REFRESH_SECRET: STRONG_REFRESH }), jest.fn()),
    ).toThrow(/示例\/默认值|短于 32/);
    expect(() =>
      resolveJwtConfig(prod({ JWT_SECRET: STRONG, JWT_REFRESH_SECRET: placeholder }), jest.fn()),
    ).toThrow(/拒绝启动/);
  });

  it('拷模板后只改了几个字符、但够长的占位符也拦住', () => {
    const tweaked = 'my-jwt-secret-key-change-this-in-production-2026';
    expect(tweaked.length).toBeGreaterThanOrEqual(32);
    expect(jwtSecretProblems(tweaked)).toContain('是仓库里的示例/默认值');
  });

  it('长度按字符计：恰好 32 字节的中文占位符不能靠字节数过关', () => {
    const placeholder = '请替换为64位随机字符串';
    expect(Buffer.byteLength(placeholder, 'utf8')).toBe(32);
    expect(jwtSecretProblems(placeholder)).toEqual(expect.arrayContaining(['短于 32 个字符']));
  });

  it('错误信息不回显密钥本身', () => {
    const secret = 'short-but-very-unique-value';
    try {
      resolveJwtConfig(prod({ JWT_SECRET: secret, JWT_REFRESH_SECRET: STRONG_REFRESH }), jest.fn());
      throw new Error('应当抛错');
    } catch (e) {
      expect((e as Error).message).toMatch(/JWT_SECRET/);
      expect((e as Error).message).not.toContain(secret);
    }
  });

  it.each(['backend/.env.example', '.env.prod.example'])(
    '仓库模板 %s 里的密钥原样用于生产会被拒绝',
    (file) => {
      const env = readEnvTemplate(file);
      expect(env.JWT_SECRET).toBeTruthy();
      expect(env.JWT_REFRESH_SECRET).toBeTruthy();
      expect(jwtSecretProblems(env.JWT_SECRET)).not.toEqual([]);
      expect(jwtSecretProblems(env.JWT_REFRESH_SECRET)).not.toEqual([]);
      expect(() => resolveJwtConfig({ ...env, NODE_ENV: 'production' }, jest.fn())).toThrow(/拒绝启动/);
    },
  );

  it('docker-compose.prod.yml 要求两把密钥必须设置（${VAR:?...}），不再以空串启动', () => {
    const compose = fs.readFileSync(path.join(REPO_ROOT, 'docker-compose.prod.yml'), 'utf8');
    expect(compose).toMatch(/JWT_SECRET:\s+\$\{JWT_SECRET:\?[^}]+\}/);
    expect(compose).toMatch(/JWT_REFRESH_SECRET:\s+\$\{JWT_REFRESH_SECRET:\?[^}]+\}/);
  });
});

describe('JWT 配置：非生产环境照常工作但告警', () => {
  it.each([undefined, 'development', 'test'])('NODE_ENV=%s 缺失密钥：用开发默认值并告警', (nodeEnv) => {
    const warn = jest.fn();
    const cfg = resolveJwtConfig({ NODE_ENV: nodeEnv }, warn);
    expect(cfg.secret).toBe(DEV_JWT_SECRET);
    expect(cfg.refreshSecret).toBe(DEV_JWT_REFRESH_SECRET);
    expect(cfg.secret).not.toBe(cfg.refreshSecret);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.join('\n')).toMatch(/JWT_SECRET[\s\S]*JWT_REFRESH_SECRET/);
  });

  it('弱密钥照常使用、相同密钥只告警', () => {
    const warn = jest.fn();
    const cfg = resolveJwtConfig({ NODE_ENV: 'development', JWT_SECRET: 'weak', JWT_REFRESH_SECRET: 'weak' }, warn);
    expect(cfg.secret).toBe('weak');
    expect(cfg.refreshSecret).toBe('weak');
    expect(warn.mock.calls.join('\n')).toMatch(/相同/);
  });

  it('合格密钥不告警', () => {
    const warn = jest.fn();
    resolveJwtConfig({ NODE_ENV: 'development', JWT_SECRET: STRONG, JWT_REFRESH_SECRET: STRONG_REFRESH }, warn);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('JWT 有效期解析', () => {
  it.each([
    ['2h', 7200],
    ['7d', 604800],
    ['15m', 900],
    ['900', 900],
    ['45s', 45],
    [' 2H ', 7200],
    ['30d', MAX_TOKEN_LIFETIME_SEC],
  ])('%j → %d 秒', (raw, expected) => {
    expect(parseTokenLifetime('JWT_EXPIRES_IN', raw, '2h')).toBe(expected);
  });

  it('未设置或空串用默认值', () => {
    expect(parseTokenLifetime('X', undefined, '7d')).toBe(604800);
    expect(parseTokenLifetime('X', '', '2h')).toBe(7200);
  });

  it.each(['abc', '1.5h', '0', '-1h', '2 hours', '31d', '7200000', '2w'])('%j → 抛错', (raw) => {
    expect(() => parseTokenLifetime('JWT_REFRESH_EXPIRES_IN', raw, '7d')).toThrow(/JWT_REFRESH_EXPIRES_IN 非法/);
  });

  it('非生产环境的非法有效期同样拒绝启动（配置错误不静默回退）', () => {
    expect(() => resolveJwtConfig({ NODE_ENV: 'development', JWT_EXPIRES_IN: '2 hours' }, jest.fn())).toThrow(
      /JWT_EXPIRES_IN 非法/,
    );
  });
});

describe('configuration.ts 接入', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('生产环境缺密钥时，配置工厂直接抛错（Nest 启动失败，main.ts 退出进程）', () => {
    process.env = { ...saved, NODE_ENV: 'production' };
    delete process.env.JWT_SECRET;
    delete process.env.JWT_REFRESH_SECRET;
    expect(() => configuration()).toThrow(/拒绝启动/);
  });

  it('生产环境合格密钥：app.jwt 是解析后的配置', () => {
    process.env = {
      ...saved,
      NODE_ENV: 'production',
      JWT_SECRET: STRONG,
      JWT_REFRESH_SECRET: STRONG_REFRESH,
      JWT_EXPIRES_IN: '30m',
      JWT_REFRESH_EXPIRES_IN: '14d',
    };
    expect(configuration().jwt).toEqual({
      secret: STRONG,
      refreshSecret: STRONG_REFRESH,
      expiresIn: 1800,
      refreshExpiresIn: 14 * 86400,
    });
  });
});
