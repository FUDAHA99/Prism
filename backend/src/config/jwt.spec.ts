import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import {
  DEV_JWT_REFRESH_SECRET,
  DEV_JWT_SECRET,
  KNOWN_PLACEHOLDER_SECRETS,
  LEAKED_JWT_SECRET_SHA256,
  MAX_TOKEN_LIFETIME_SEC,
  MIN_DISTINCT_BYTE_DELTAS,
  MIN_DISTINCT_CHAR_DELTAS,
  MIN_JWT_SECRET_LENGTH,
  PLACEHOLDER_PATTERN,
  adjacentDeltaShape,
  embeddedHexDeltaShape,
  hasSharedSubstring,
  hasShortPeriod,
  isConstantOffset,
  isHexSecret,
  isLeakedJwtSecret,
  isSimpleTransform,
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

/**
 * 确定性的「随机」字节流：sha256(种子-序号) 首尾相接。统计上等同随机，但每次运行结果相同 ——
 * 测试里不用 crypto.randomBytes 现生成，避免偶发的误判让 CI 时红时绿。
 */
function detBytes(seed: string, n: number): Buffer {
  const chunks: Buffer[] = [];
  for (let i = 0; chunks.length * 32 < n; i += 1) {
    chunks.push(createHash('sha256').update(`${seed}-${i}`).digest());
  }
  return Buffer.concat(chunks).subarray(0, n);
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const PRINTABLE = Array.from({ length: 94 }, (_, i) => String.fromCharCode(0x21 + i)).join('');

/** UUID 形态（8-4-4-4-12 个十六进制字符） */
function uuidLike(seed: string): string {
  const h = detBytes(seed, 16).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 从字母表里均匀地取 n 个字符（拒绝采样，没有取模偏差） */
function detString(seed: string, alphabet: string, n: number): string {
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  for (let block = 0; out.length < n; block += 1) {
    for (const b of detBytes(`${seed}#${block}`, 64)) {
      if (b < limit && out.length < n) out += alphabet[b % alphabet.length];
    }
  }
  return out;
}

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
    const alphabet = 'q8w3e7r1t5yu'; // 12 个不同字符，彼此不相邻
    // 从这些字符里按固定的伪随机序列取 64 个（不是短片段重复，相邻差值也够多）
    const twelve = detString('twelve-chars', alphabet, 64);
    const eleven = detString('eleven-chars', alphabet.slice(0, 11), 64);
    expect(new Set(twelve).size).toBe(12);
    expect(new Set(eleven).size).toBe(11);
    expect(jwtSecretProblems(eleven)).toEqual(['不同字符少于 12 个']);
    expect(jwtSecretProblems(twelve)).toEqual([]);
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

  it.each([
    ['openssl rand -base64 32', (i: number) => detBytes(`b64-${i}`, 32).toString('base64')],
    ['base64url 32 字节', (i: number) => detBytes(`b64url-${i}`, 32).toString('base64url')],
    ['62 个字母数字 × 40', (i: number) => detString(`alnum-${i}`, ALNUM, 40)],
    ['两个 UUID 拼接', (i: number) => `${uuidLike(`u1-${i}`)}-${uuidLike(`u2-${i}`)}`],
  ])('其他常见的随机密钥形态（%s，各 5000 个，固定种子）也都通过', (_name, gen) => {
    const failures: string[] = [];
    for (let i = 0; i < 5000; i += 1) {
      const problems = jwtSecretProblems(gen(i));
      if (problems.length > 0) failures.push(`${i}: ${problems.join('、')}`);
    }
    expect(failures).toEqual([]);
  });

  describe('相邻差值种类过少（1-F-1 二次复审：泄露密钥所属的生成规律整族都要拦住）', () => {
    /**
     * 按公开文档里描述过的规律重建整个家族（不含、也不需要那两把已泄露的原值）：
     * 第 i 个字节的高半字节在 a..f 里循环、低半字节在 0..9 里循环，各自每字节走一步。
     * 同时覆盖所有起点（6 × 10 = 60 个）、反方向、高低半字节互换、大写、多种长度。
     */
    const LETTER_NIBBLES = [0xa, 0xb, 0xc, 0xd, 0xe, 0xf];
    const family = (hiStart: number, loStart: number, bytes: number, step: 1 | -1, digitsHigh: boolean) => {
      const out: number[] = [];
      for (let i = 0; i < bytes; i += 1) {
        const letter = LETTER_NIBBLES[(((hiStart + step * i) % 6) + 6) % 6];
        const digit = (((loStart + step * i) % 10) + 10) % 10;
        out.push(digitsHigh ? (digit << 4) | letter : (letter << 4) | digit);
      }
      return Buffer.from(out).toString('hex');
    };
    const structural = (secret: string) => jwtSecretProblems(secret).filter((p) => !p.includes('已泄露'));
    const DELTA_PROBLEM = /相邻字节的差值只有 \d+ 种/;

    it('家族里每一把（60 个起点 × 2 个方向 × 2 种半字节顺序 × 大小写 × 16/24/32/48/64 字节）都被结构规则拒绝，不靠拒绝清单', () => {
      const missed: string[] = [];
      let checked = 0;
      for (const bytes of [16, 24, 32, 48, 64]) {
        for (const step of [1, -1] as const) {
          for (const digitsHigh of [false, true]) {
            for (let h = 0; h < 6; h += 1) {
              for (let l = 0; l < 10; l += 1) {
                const lower = family(h, l, bytes, step, digitsHigh);
                for (const secret of [lower, lower.toUpperCase()]) {
                  checked += 1;
                  const shape = adjacentDeltaShape(secret);
                  if (shape.unit !== 'byte' || shape.distinct > 4 || !structural(secret).some((p) => DELTA_PROBLEM.test(p))) {
                    missed.push(`bytes=${bytes} step=${step} digitsHigh=${digitsHigh} start=${h}/${l}`);
                  }
                }
              }
            }
          }
        }
      }
      expect(checked).toBe(5 * 2 * 2 * 60 * 2);
      expect(missed).toEqual([]);
    });

    it('家族里任取两把（不同轨道）配成一对，生产环境同样拒绝启动', () => {
      const a = family(0, 0, 32, 1, false);
      const b = family(0, 1, 32, 1, false); // (h - l) 奇偶不同：两条轨道，原先的两两比对也拦不住
      expect(jwtSecretPairProblems(a, b)).toEqual([]);
      expect(() => resolveJwtConfig(prod({ JWT_SECRET: a, JWT_REFRESH_SECRET: b }), jest.fn())).toThrow(
        /相邻字节的差值只有 4 种/,
      );
    });

    it.each([
      ['字节等差 +0x11', Buffer.from(Array.from({ length: 32 }, (_, i) => (0x3c + 0x11 * i) & 255)).toString('hex')],
      ['字节等差 +0x07', Buffer.from(Array.from({ length: 32 }, (_, i) => (0x21 + 7 * i) & 255)).toString('hex')],
      ['字节等差 +0x25', Buffer.from(Array.from({ length: 32 }, (_, i) => (0x90 + 0x25 * i) & 255)).toString('hex')],
      ['8 字节循环 0f1e2d3c4b5a6978 × 4', '0f1e2d3c4b5a6978'.repeat(4)],
      ['字母数字交替递增（非十六进制）', Array.from({ length: 32 }, (_, i) => 'ghijklmnopqrstuvwxyz'[i % 20] + String(i % 10)).join('')],
      ['字母按步长 7 循环（非十六进制）', Array.from({ length: 40 }, (_, i) => String.fromCharCode(97 + ((i * 7) % 26))).join('')],
    ])('其他按规律生成的形态（%s）→ 拒绝', (_name, secret) => {
      const shape = adjacentDeltaShape(secret);
      expect(shape.distinct).toBeLessThan(shape.min);
      expect(jwtSecretProblems(secret).join('、')).toMatch(/相邻(字节|字符)的差值只有/);
    });

    it('按字节还是按字符：偶数长度的十六进制（不分大小写）按字节，其余按字符', () => {
      expect(isHexSecret(STRONG)).toBe(true);
      expect(isHexSecret(STRONG.toUpperCase())).toBe(true);
      expect(isHexSecret(STRONG.slice(1))).toBe(false);
      expect(isHexSecret(`${STRONG.slice(2)}zz`)).toBe(false);
      expect(adjacentDeltaShape(STRONG)).toEqual(expect.objectContaining({ unit: 'byte', min: MIN_DISTINCT_BYTE_DELTAS }));
      expect(adjacentDeltaShape(detBytes('b64', 32).toString('base64'))).toEqual(
        expect.objectContaining({ unit: 'char', min: MIN_DISTINCT_CHAR_DELTAS }),
      );
      // openssl rand -hex 16（16 字节、32 个字符）只有 15 个相邻差：阈值按 ⌊15 / 2⌋ = 7 算，不拿 32 字节的标准误判
      expect(adjacentDeltaShape(detBytes('hex16', 16).toString('hex')).min).toBe(7);
    });

    it.each([
      ['openssl rand -hex 32', 32, 20_000],
      ['openssl rand -hex 24', 24, 20_000],
      ['openssl rand -hex 16', 16, 20_000],
    ])('随机十六进制（%s，%i 字节，固定种子 %i 个）从不因差值种类被拒', (_name, bytes, n) => {
      let min = Infinity;
      for (let i = 0; i < n; i += 1) {
        const shape = adjacentDeltaShape(detBytes(`hex${bytes}-${i}`, bytes).toString('hex'));
        expect(shape.unit).toBe('byte');
        min = Math.min(min, shape.distinct - shape.min);
      }
      // 实测 30 万个样本：32 字节最少 23 种（阈值 12）、24 字节最少 15 种（阈值 11）、16 字节最少 10 种（阈值 7）
      expect(min).toBeGreaterThanOrEqual(3);
    });

    it.each([
      ['base64 32 字节', (i: number) => detBytes(`c64-${i}`, 32).toString('base64')],
      ['62 个字母数字 × 32', (i: number) => detString(`c62-${i}`, ALNUM, 32)],
      ['可打印 ASCII × 32', (i: number) => detString(`c94-${i}`, PRINTABLE, 32)],
      ['纯小写字母 × 32', (i: number) => detString(`c26-${i}`, 'abcdefghijklmnopqrstuvwxyz', 32)],
      ['只有 12 种符号 × 32（最坏情形）', (i: number) => detString(`c12-${i}`, 'abcdefghijkl', 32)],
    ])('随机的非十六进制串（%s，固定种子 20000 个）从不因字符差值种类被拒', (_name, gen) => {
      let min = Infinity;
      for (let i = 0; i < 20_000; i += 1) {
        const shape = adjacentDeltaShape(gen(i));
        expect(shape.unit).toBe('char');
        min = Math.min(min, shape.distinct - shape.min);
      }
      // 实测 30 万个样本的最少种类：base64 26、字母数字 19、可打印 20、纯小写 14、12 种符号 9（阈值 8）
      expect(min).toBeGreaterThanOrEqual(1);
    });

    it('由一小段重复拼成 → 拒绝（随机的 16 / 32 个十六进制字符重复），整串不重复的不算', () => {
      const r16 = detBytes('period-16', 8).toString('hex');
      const r32 = detBytes('period-32', 16).toString('hex');
      expect(hasShortPeriod(r16.repeat(4))).toBe(true);
      expect(hasShortPeriod(r32.repeat(2))).toBe(true);
      expect(jwtSecretProblems(r32.repeat(2))).toContain('由一小段重复拼成');
      expect(hasShortPeriod(`${r32}${r32.slice(0, 31)}x`)).toBe(false);
      expect(hasShortPeriod(STRONG)).toBe(false);
    });

    describe("加了装饰的同族密钥（1-F-1 三次复审：前后缀、分隔符、奇数长度都不能绕过）", () => {
      const fam = (h: number, l: number) => family(h, l, 32, 1, false);
      const EMBEDDED_PROBLEM = /其中的十六进制内容相邻字节差值只有 \d+ 种/;
      const decorations: Array<[string, (hex: string) => string]> = [
        ["奇数长度（去掉末字符）", (x) => x.slice(0, -1)],
        ["奇数长度（去掉首字符）", (x) => x.slice(1)],
        ["prism_ 前缀", (x) => `prism_${x}`],
        ["prism-jwt- 前缀", (x) => `prism-jwt-${x}`],
        ["_prod 后缀", (x) => `${x}_prod`],
        ["感叹号结尾", (x) => `${x}!`],
        ["冒号分隔字节", (x) => x.match(/../g)!.join(":")],
        ["大写 + PRISM_ 前缀", (x) => `PRISM_${x.toUpperCase()}`],
        ["UUID 式分段", (x) => `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`],
      ];

      it.each(decorations)("%s：60 个起点全部拒绝", (_name, decorate) => {
        const missed: string[] = [];
        for (let h = 0; h < 6; h += 1) {
          for (let l = 0; l < 10; l += 1) {
            const secret = decorate(fam(h, l));
            if (!jwtSecretProblems(secret).some((p) => EMBEDDED_PROBLEM.test(p) || DELTA_PROBLEM.test(p))) {
              missed.push(`${h}/${l}`);
            }
          }
        }
        expect(missed).toEqual([]);
      });

      it("24 字节的同族串加 jwt_ 前缀同样拒绝", () => {
        expect(jwtSecretProblems(`jwt_${family(2, 7, 24, 1, false)}`).join("、")).toMatch(EMBEDDED_PROBLEM);
      });

      it.each([
        ["base64 32 字节", (i: number) => detBytes(`e64-${i}`, 32).toString("base64")],
        ["base64 48 字节", (i: number) => detBytes(`e48-${i}`, 48).toString("base64")],
        ["base64url 64 字节", (i: number) => detBytes(`eurl-${i}`, 64).toString("base64url")],
        ["62 字母数字 × 64", (i: number) => detString(`ea62-${i}`, ALNUM, 64)],
        ["可打印 ASCII × 64", (i: number) => detString(`ep94-${i}`, PRINTABLE, 64)],
        ["两个 UUID 拼接", (i: number) => `${uuidLike(`eu1-${i}`)}${uuidLike(`eu2-${i}`)}`],
        ["prism_ + 32 字节随机十六进制", (i: number) => `prism_${detBytes(`epx-${i}`, 32).toString("hex")}`],
        ["奇数长度随机十六进制（63 字符）", (i: number) => detBytes(`eodd-${i}`, 32).toString("hex").slice(1)],
      ])("随机形态（%s，固定种子 20000 个）从不被嵌入式检查误判", (_name, gen) => {
        let falseRejects = 0;
        for (let i = 0; i < 20_000; i += 1) {
          const shape = embeddedHexDeltaShape(gen(i));
          if (shape && shape.distinct < shape.min) falseRejects += 1;
        }
        expect(falseRejects).toBe(0);
      });

      it("纯十六进制偶数长度不走嵌入式检查（已按整串字节检查，不重复报告）；十六进制内容太少也不检查", () => {
        expect(embeddedHexDeltaShape(STRONG)).toBeNull();
        expect(embeddedHexDeltaShape("zz" + "0123456789abcdef".slice(0, 10) + "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")).toBeNull();
        expect(jwtSecretProblems(STRONG)).toEqual([]);
      });
    });
  });

  describe('两把密钥之间的简单变换（1-F-1 二次复审）', () => {
    const swapNibbles = (hex: string) => hex.match(/../g)!.map((p) => p[1] + p[0]).join('');
    it.each([
      ['只差大小写', (a: string) => a.toUpperCase()],
      ['整串反转', (a: string) => [...a].reverse().join('')],
      ['逐位 15 - x（半字节取反）', (a: string) => [...a].map((c) => (15 - parseInt(c, 16)).toString(16)).join('')],
      ['按字节异或同一个值', (a: string) => Buffer.from(Buffer.from(a, 'hex').map((x) => x ^ 0x5a)).toString('hex')],
      ['按字节倒序', (a: string) => Buffer.from(a, 'hex').reverse().toString('hex')],
      ['每个字节内两个半字节互换', swapNibbles],
    ])('JWT_REFRESH_SECRET = %s(JWT_SECRET) → 拒绝', (_name, transform) => {
      const b = transform(STRONG);
      expect(b).not.toBe(STRONG);
      expect(isSimpleTransform(STRONG, b)).toBe(true);
      expect(() => resolveJwtConfig(prod({ JWT_SECRET: STRONG, JWT_REFRESH_SECRET: b }), jest.fn())).toThrow(
        /简单变换/,
      );
    });

    it('非十六进制：字符码异或同一个值、反转同样拒绝；两把无关的随机密钥不算', () => {
      const a = detString('pair-a', ALNUM, 40);
      expect(isSimpleTransform(a, [...a].map((c) => String.fromCharCode(c.charCodeAt(0) ^ 1)).join(''))).toBe(true);
      expect(isSimpleTransform(a, [...a].reverse().join(''))).toBe(true);
      expect(isSimpleTransform(a, detString('pair-b', ALNUM, 40))).toBe(false);
      expect(isSimpleTransform(STRONG, STRONG_REFRESH)).toBe(false);
    });
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

  it('流程顺序：bash 预检 → build → 镜像内校验 → 渲染 nginx → up -d（不再带 --build）', () => {
    const main = script.slice(script.indexOf('main() {'));
    const steps = [
      'check_jwt_secrets',
      '$COMPOSE build ||',
      '\n  check_jwt_in_image\n',
      'render-nginx-conf.sh',
      '$COMPOSE up -d --remove-orphans',
    ].map((step) => ({ step, at: main.indexOf(step) }));
    for (const s of steps) expect(s.at).toBeGreaterThan(0);
    expect(steps.map((s) => s.step)).toEqual([...steps].sort((a, b) => a.at - b.at).map((s) => s.step));
    expect(script).not.toMatch(/up -d --build/);
  });

  describe('镜像内校验（check_jwt_in_image）', () => {
    const js = /^JWT_VALIDATOR_JS='([^']*)'$/m.exec(script)?.[1] as string;

    /**
     * 按 deploy.sh 里的原文执行那段 node -e 脚本：stdin 喂 `compose config --format json` 形状的配置，
     * ./dist/config/jwt 换成本模块（dist 就是它编译出来的）。
     */
    function runValidator(stdin: string) {
      const errors: string[] = [];
      let exitCode: number | undefined;
      const handlers: Record<string, (arg?: string) => void> = {};
      const fakeRequire = (id: string) => {
        expect(id).toBe('./dist/config/jwt');
        return { resolveJwtConfig };
      };
      const fakeProcess = {
        env: {},
        stdin: {
          setEncoding: () => undefined,
          on: (event: string, cb: (arg?: string) => void) => {
            handlers[event] = cb;
          },
        },
        exit: (code: number) => {
          exitCode = code;
          throw new Error('__exit__');
        },
      };
      const fakeConsole = { error: (m: string) => errors.push(m), log: () => undefined, warn: () => undefined };
      new Function('require', 'process', 'console', js)(fakeRequire, fakeProcess, fakeConsole);
      try {
        // 分两块送进去，确认按流拼接
        handlers.data(stdin.slice(0, 7));
        handlers.data(stdin.slice(7));
        handlers.end();
      } catch (e) {
        if ((e as Error).message !== '__exit__') throw e;
      }
      return { exitCode, errors };
    }
    /** compose config 渲染结果的形状；字面量 $ 在渲染结果里是 $$ */
    const rendered = (environment: Record<string, string | null>) =>
      JSON.stringify({ name: 'prism-cms', services: { backend: { environment }, mysql: {} } });

    it('一次性容器的调用方式：compose 渲染的配置经管道交给新 backend 镜像，不联网、不挂卷、用完即删', () => {
      expect(js).toBeTruthy();
      expect(script).toContain(
        '$COMPOSE config --format json | docker run --rm -i --network none --entrypoint node "$image" -e "$JWT_VALIDATOR_JS"',
      );
      // compose run 即使带 --no-deps 也会建项目的命名卷，会让首次部署被误判（见 deploy.sh 注释）
      const code = script
        .split('\n')
        .filter((line) => !line.trim().startsWith('#'))
        .join('\n');
      expect(code).not.toMatch(/\$COMPOSE run\b/);
      // require 的是 backend 镜像里 dist/config/jwt.js，即本文件旁的 jwt.ts 编译产物
      expect(fs.existsSync(path.join(__dirname, 'jwt.ts'))).toBe(true);
      expect(js).toContain('require("./dist/config/jwt")');
      // 镜像名按 compose 规则推出（<项目名>-backend），前提是 backend 服务只有 build、没有 image
      const compose = fs.readFileSync(path.join(REPO_ROOT, 'docker-compose.prod.yml'), 'utf8');
      const backend = compose.slice(compose.indexOf('\n  backend:'), compose.indexOf('\n  portal:'));
      expect(backend).toMatch(/\n    build:/);
      expect(backend).not.toMatch(/\n    image:/);
    });

    it('首次部署的判断在构建与校验之前（它们不能先建出 MySQL 数据卷）', () => {
      const main = script.slice(script.indexOf('main() {'));
      expect(main.indexOf('docker volume inspect prism_mysql_data')).toBeGreaterThan(0);
      expect(main.indexOf('docker volume inspect prism_mysql_data')).toBeLessThan(main.indexOf('$COMPOSE build ||'));
    });

    it('不合格：退出码 1，只输出问题清单，不回显密钥', () => {
      const weak = '0f1e2d3c4b5a6978'.repeat(4);
      const { exitCode, errors } = runValidator(
        rendered({ NODE_ENV: 'production', JWT_SECRET: weak, JWT_REFRESH_SECRET: STRONG_REFRESH }),
      );
      expect(exitCode).toBe(1);
      expect(errors.join('\n')).toMatch(/JWT_SECRET .*相邻字节的差值只有/);
      expect(errors.join('\n')).not.toContain(weak);
      expect(errors.join('\n')).not.toContain(STRONG_REFRESH);
    });

    it('合格：不退出、不输出；NODE_ENV 一律按 production 校验', () => {
      const ok = runValidator(rendered({ NODE_ENV: 'development', JWT_SECRET: STRONG, JWT_REFRESH_SECRET: STRONG_REFRESH }));
      expect(ok).toEqual({ exitCode: undefined, errors: [] });
      const weak = runValidator(rendered({ NODE_ENV: 'development', JWT_SECRET: 'weak', JWT_REFRESH_SECRET: STRONG_REFRESH }));
      expect(weak.exitCode).toBe(1);
    });

    it('渲染结果里的 $$ 还原成容器实际拿到的 $（否则校验的不是同一个值）', () => {
      // 容器拿到的是 STRONG 中间夹一个 $；渲染结果写作 $$
      const withDollar = `${STRONG.slice(0, 30)}$${STRONG.slice(30)}`;
      const escaped = withDollar.split('$').join('$$');
      expect(runValidator(rendered({ JWT_SECRET: escaped, JWT_REFRESH_SECRET: STRONG_REFRESH }))).toEqual({
        exitCode: undefined,
        errors: [],
      });
      // 两把实际相同、只是渲染写法不同（$ 与 $$）时照样判为相同
      const same = runValidator(rendered({ JWT_SECRET: escaped, JWT_REFRESH_SECRET: withDollar.split('$').join('$$') }));
      expect(same.exitCode).toBe(1);
      expect(same.errors.join('\n')).toMatch(/相同/);
    });

    it('stdin 不是合法的配置：退出码 2，不抛异常', () => {
      expect(runValidator('')).toEqual({ exitCode: 2, errors: ['读不到 compose 渲染出的 backend 配置'] });
      expect(runValidator('{"services":{}}').exitCode).toBe(2);
    });

    it('校验失败与构建失败都在 up 之前中止，提示容器均未改动', () => {
      const fn = script.slice(script.indexOf('check_jwt_in_image() {'));
      expect(fn.slice(0, fn.indexOf('\n}'))).toMatch(/die "[^"]*容器均未改动/);
      expect(script).toMatch(/\$COMPOSE build \|\| die "[^"]*容器均未改动/);
    });
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
