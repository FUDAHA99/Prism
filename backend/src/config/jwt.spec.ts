import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import {
  DEV_JWT_REFRESH_SECRET,
  DEV_JWT_SECRET,
  KNOWN_PLACEHOLDER_SECRETS,
  LEAKED_JWT_SECRET_SHA256,
  MAX_TOKEN_LIFETIME_SEC,
  MIN_JWT_SECRET_LENGTH,
  PLACEHOLDER_PATTERN,
  hasSharedSubstring,
  isConstantOffset,
  isLeakedJwtSecret,
  jwtSecretPairProblems,
  jwtSecretProblems,
  longestSequentialRun,
  parseTokenLifetime,
  resolveJwtConfig,
} from './jwt';
import configuration from './configuration';

const REPO_ROOT = path.resolve(__dirname, '../../..');
// 两个 `openssl rand -hex 32` 形态的固定值（测试专用，从未用于任何环境）
const STRONG = 'f0b8d3aae70ccc37490b844ae982ccc32530d8b95fb33dd4255add09479a6f8d';
const STRONG_REFRESH = '024289c9abf62e60a497f05b00f502fcb483792d13ece065550a3dc82e75a892';

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

describe('JWT 配置：弱密钥的结构特征（1-F-1 复审：泄露的那对密钥长 64、不是占位符，原规则全部放行）', () => {
  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
  /** 按 sha256 计数器生成的 `openssl rand -hex 32` 形态样本：统计上等同随机，固定种子保证结果可复现 */
  const hexSample = (seed: string, i: number) => sha256(`${seed}-${i}`);

  it('不同字符少于 12 个 → 拒绝；恰好 12 个且无其他问题 → 通过', () => {
    const eleven = 'q8w3e7r1t5y'; // 11 个不同字符，彼此不相邻
    const twelve = `${eleven}u`;
    expect(new Set(eleven).size).toBe(11);
    expect(jwtSecretProblems(eleven.repeat(6))).toContain('不同字符少于 12 个');
    expect(jwtSecretProblems(twelve.repeat(6))).toEqual([]);
  });

  it.each([
    ['递增数字', '01234567'],
    ['递减数字', '76543210'],
    ['十六进制跨 9→a', '6789abcd'],
    ['十六进制递减跨 a→9', 'fedcba98'],
    ['大写字母', 'KLMNOPQR'],
  ])('含 8 个连续字符（%s）→ 拒绝', (_name, run) => {
    const secret = `${STRONG.slice(0, 20)}${run}${STRONG.slice(28)}`;
    expect(longestSequentialRun(run)).toBeGreaterThanOrEqual(8);
    expect(jwtSecretProblems(secret)).toContain('含 8 个以上连续递增或递减的字符');
  });

  it('7 个连续字符、或方向来回变化的不算', () => {
    expect(longestSequentialRun('x0123456x')).toBe(7);
    expect(longestSequentialRun('0123210123')).toBe(4);
    expect(jwtSecretProblems(`${STRONG.slice(0, 20)}x0123456x${STRONG.slice(29)}`)).toEqual([]);
  });

  it('拒绝清单恰好是那两把已泄露密钥的 sha256（2026-10-08 轮换）', () => {
    expect([...LEAKED_JWT_SECRET_SHA256].sort()).toEqual(
      [
        '745e055d58ff36ae766b8625e324c7bb6d990d9af2cd61a8b48d558ce3c87f64',
        'fdeac694c933ee25a56651bf93f0cb1e49086f78a369c44aaeea9ee1af970a75',
      ].sort(),
    );
    expect(Object.isFrozen(LEAKED_JWT_SECRET_SHA256)).toBe(true);
  });

  it('sha256 命中拒绝清单即拒绝（用测试值的哈希验证比对机制），错误信息不回显密钥', () => {
    const secret = hexSample('leaked-probe', 1);
    expect(isLeakedJwtSecret(secret, [sha256(secret)])).toBe(true);
    expect(isLeakedJwtSecret(secret, [sha256(`${secret} `)])).toBe(false);
    expect(isLeakedJwtSecret(STRONG)).toBe(false);
  });

  describe('两把密钥之间', () => {
    it('有 16 个以上字符的公共片段 → 拒绝（含一把是另一把移位一字节）', () => {
      const shifted = STRONG.slice(2) + STRONG.slice(0, 2);
      expect(jwtSecretPairProblems(STRONG, shifted)).toEqual([expect.stringContaining('公共片段')]);
      const spliced = STRONG_REFRESH.slice(0, 40) + STRONG.slice(10, 26) + STRONG_REFRESH.slice(56);
      expect(hasSharedSubstring(STRONG, spliced, 16)).toBe(true);
      expect(() => resolveJwtConfig(prod({ JWT_SECRET: STRONG, JWT_REFRESH_SECRET: spliced }), jest.fn())).toThrow(
        /公共片段/,
      );
    });

    it('15 个字符的公共片段不算', () => {
      const b = STRONG_REFRESH.slice(0, 40) + STRONG.slice(10, 25) + STRONG_REFRESH.slice(55);
      expect(hasSharedSubstring(STRONG, b, 16)).toBe(false);
      expect(jwtSecretPairProblems(STRONG, b)).toEqual([]);
    });

    it.each([
      ['逐字符码 +1', (a: string) => [...a].map((c) => String.fromCharCode(c.charCodeAt(0) + 1)).join('')],
      ['逐 4 位 +3（模 16）', (a: string) => [...a].map((c) => ((parseInt(c, 16) + 3) % 16).toString(16)).join('')],
      [
        '逐字节 +1（模 256）',
        (a: string) => Buffer.from(Buffer.from(a, 'hex').map((x) => (x + 1) % 256)).toString('hex'),
      ],
    ])('一把是另一把逐位加同一偏移（%s）→ 拒绝', (_name, shift) => {
      const b = shift(STRONG);
      expect(b).not.toBe(STRONG);
      expect(isConstantOffset(STRONG, b)).toBe(true);
      expect(jwtSecretPairProblems(STRONG, b)).toContain('JWT_REFRESH_SECRET 是 JWT_SECRET 逐位加同一偏移得到的（移位）');
      expect(() => resolveJwtConfig(prod({ JWT_SECRET: STRONG, JWT_REFRESH_SECRET: b }), jest.fn())).toThrow(/移位/);
    });

    it('相同 → 拒绝（原有规则）', () => {
      expect(jwtSecretPairProblems(STRONG, STRONG)).toEqual([expect.stringContaining('相同')]);
    });
  });

  it('openssl rand -hex 32 形态的随机密钥对总能通过（50000 对，固定种子）', () => {
    // 实测误判率约 3e-7 / 把（300 万个 crypto.randomBytes 样本里「不同字符少于 12 个」出现 1 次，连续字符 0 次）；
    // 生产上真碰到时报错信息会让运维重新生成一次
    const failures: number[] = [];
    for (let i = 0; i < 50_000; i += 1) {
      const env = prod({ JWT_SECRET: hexSample('access', i), JWT_REFRESH_SECRET: hexSample('refresh', i) });
      try {
        resolveJwtConfig(env, jest.fn());
      } catch {
        failures.push(i);
      }
    }
    expect(failures).toEqual([]);
  });

  it('crypto.randomBytes(32) 现生成的 200 对也都通过', () => {
    for (let i = 0; i < 200; i += 1) {
      const a = randomBytes(32).toString('hex');
      const b = randomBytes(32).toString('hex');
      expect(jwtSecretProblems(a)).toEqual([]);
      expect(jwtSecretPairProblems(a, b)).toEqual([]);
    }
  });

  it('两把都回落到开发默认值时不做两两比对（非生产只按各自问题告警）', () => {
    const warn = jest.fn();
    resolveJwtConfig({ NODE_ENV: 'development' }, warn);
    expect(warn.mock.calls.join('\n')).not.toMatch(/公共片段|移位/);
  });

  it('非生产环境：结构问题照常使用但告警', () => {
    const warn = jest.fn();
    const weak = '0123456789abcdef0123456789abcdef';
    const cfg = resolveJwtConfig({ NODE_ENV: 'development', JWT_SECRET: weak, JWT_REFRESH_SECRET: STRONG }, warn);
    expect(cfg.secret).toBe(weak);
    expect(warn.mock.calls.join('\n')).toMatch(/连续递增或递减/);
  });
});

describe('scripts/deploy.sh 的部署前预检与 jwt.ts 规则一致', () => {
  const script = fs.readFileSync(path.join(REPO_ROOT, 'scripts/deploy.sh'), 'utf8');

  it('已泄露密钥清单相同', () => {
    const block = /^LEAKED_JWT_SECRET_SHA256=\(([^)]*)\)/m.exec(script);
    expect(block).not.toBeNull();
    const hashes = (block as RegExpExecArray)[1].split(/\s+/).filter(Boolean);
    expect(hashes.sort()).toEqual([...LEAKED_JWT_SECRET_SHA256].sort());
  });

  it('占位符正则与最短长度相同，仓库里出现过的示例值全部命中', () => {
    const pattern = /^JWT_PLACEHOLDER_PATTERN='([^']*)'$/m.exec(script);
    expect(pattern).not.toBeNull();
    expect((pattern as RegExpExecArray)[1]).toBe(PLACEHOLDER_PATTERN.source);
    // shell 侧先转小写再匹配，等价于 JS 的 i 标志
    const shellRegex = new RegExp((pattern as RegExpExecArray)[1]);
    for (const placeholder of KNOWN_PLACEHOLDER_SECRETS) {
      expect({ placeholder, hit: shellRegex.test(placeholder.toLowerCase()) }).toEqual({ placeholder, hit: true });
    }
    expect(/^JWT_MIN_LENGTH=(\d+)$/m.exec(script)?.[1]).toBe(String(MIN_JWT_SECRET_LENGTH));
  });

  it('预检在 up -d --build 之前执行', () => {
    const main = script.slice(script.indexOf('main() {'));
    const check = main.indexOf('check_jwt_secrets');
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(main.indexOf('up -d --build'));
    expect(check).toBeLessThan(main.indexOf('render-nginx-conf.sh'));
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
