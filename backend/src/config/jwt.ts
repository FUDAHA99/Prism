import { createHash } from 'crypto';

/**
 * JWT 密钥与有效期的解析和启动期校验（批次 1-F-1）。
 *
 * 此前 configuration.ts 写的是 `process.env.JWT_SECRET || '<仓库里公开的默认值>'`，启动不报错：
 * 生产忘了配密钥（docker-compose 的 ${JWT_SECRET} 会得到空串）就静默回落到人人可见的默认值，
 * 任何人都能伪造任意用户的 token。现在：
 *
 * - NODE_ENV=production：JWT_SECRET / JWT_REFRESH_SECRET 缺失、等于仓库里出现过的示例/默认值、
 *   看起来是占位符、短于 32 字符、不同字符少于 12 个、含 8 个以上连续递增 / 递减字符、
 *   相邻字节 / 字符的差值种类过少（按规律生成）、由一小段重复拼成、是已泄露的密钥，
 *   或两者相同、有 16 个以上字符的公共片段、一把是另一把的移位或简单变换 —— 一律抛错，应用拒绝启动。
 *   scripts/deploy.sh 在 up 之前先用 bash 拦一遍基本规则，再在新构建的 backend 镜像里经 compose 原样插值
 *   调用这里的 resolveJwtConfig（一次性容器，现有容器均未改动），弱密钥不会等到容器已替换才暴露。
 * - 其他环境：缺失时用开发默认值、弱密钥照常使用，但都打一条 warn，本地开发和测试不受影响。
 *
 * 有效期统一解析成「秒」交给 jsonwebtoken（数字即秒）。env 里的值永远是字符串，而 jsonwebtoken
 * 把不带单位的字符串当毫秒（"7200" 是 7.2 秒），这里明确：纯数字按秒、或带 s/m/h/d 单位。
 * 上限 MAX_TOKEN_LIFETIME_SEC：改密后的吊销标记只保留这么久，任何 token 都不能活得比它长。
 */

export const MIN_JWT_SECRET_LENGTH = 32;

/** 任何 token（access / refresh）的最长有效期；吊销标记的保留时长与之相同 */
export const MAX_TOKEN_LIFETIME_SEC = 30 * 24 * 60 * 60;

export const DEFAULT_ACCESS_EXPIRES_IN = '2h';
export const DEFAULT_REFRESH_EXPIRES_IN = '7d';

/** 非生产环境未配置时使用的开发默认值（生产环境命中即拒绝启动） */
export const DEV_JWT_SECRET = 'your-jwt-secret-key-change-this-in-production';
export const DEV_JWT_REFRESH_SECRET = 'your-jwt-refresh-secret-key-change-this-in-production';

/**
 * 仓库里出现过的示例 / 默认值：configuration.ts 旧默认值、backend/.env.example、
 * .env.prod.example、本地开发 .env 模板、docs/dev-guide.md。
 */
export const KNOWN_PLACEHOLDER_SECRETS: readonly string[] = Object.freeze([
  DEV_JWT_SECRET,
  DEV_JWT_REFRESH_SECRET,
  '请替换为64位随机字符串',
  '请替换为另一个64位随机字符串',
  'cms-dev-jwt-secret-key-change-in-production',
  'cms-dev-jwt-refresh-secret-key-change-in-production',
  'your-super-secret-key-change-in-production',
  'your-secret-key',
]);

/**
 * 示例值的常见写法：拷模板后只改了几个字符的也拦住。
 * scripts/deploy.sh 的部署前预检用同一条正则（jwt.spec.ts 比对两边一致）。
 */
export const PLACEHOLDER_PATTERN = /change[-_ ]?(this|me|in[-_ ]?production)|请替换|^your[-_]/i;

/**
 * 已泄露的密钥，只存 sha256（不在仓库里留原文）。
 * 这两把的前缀与生成规律曾写在公开仓库的文档里，可以完整推出，于 2026-10-08 轮换；
 * 任何环境再配回它们都按弱密钥处理。scripts/deploy.sh 的预检里有同一份清单（jwt.spec.ts 比对）。
 */
export const LEAKED_JWT_SECRET_SHA256: readonly string[] = Object.freeze([
  '745e055d58ff36ae766b8625e324c7bb6d990d9af2cd61a8b48d558ce3c87f64',
  'fdeac694c933ee25a56651bf93f0cb1e49086f78a369c44aaeea9ee1af970a75',
]);

/**
 * 弱密钥的结构特征（批次 1-F-1 复审：泄露的那对密钥长 64、不是占位符，却是按规律生成的，
 * refresh 只是 access 移位一字节，原先的校验全部放行）。阈值对 `openssl rand -hex 32` 的输出
 * 几乎不可能误判：64 个随机十六进制字符里不同字符少于 12 个、或出现 8 个连续递增 / 递减字符，
 * 概率都在 1e-7 量级（jwt.spec.ts 用大量样本验证）；真碰上了，重新生成一次即可。
 */
export const MIN_DISTINCT_SECRET_CHARS = 12;
/** 连续递增 / 递减（字符码 ±1，十六进制里 9→a 也算相邻）达到这个长度即拒绝 */
export const MAX_SEQUENTIAL_RUN = 8;
/** 两把密钥有这么长的公共片段即拒绝（一把是另一把移位、截取、拼接改出来的） */
export const MAX_SHARED_SUBSTRING = 16;

/**
 * 「相邻差值种类」规则（批次 1-F-1 二次复审）。泄露的那把密钥按「每个字节的高半字节在 a..f 循环、
 * 低半字节在 0..9 循环、各自逐字节 +1」生成：字母数字交替，16 种字符，没有 ±1 连续片段，
 * 上面三条全部放过，换个起点（约 6 bit 熵）就是一把「合格」的新密钥。这类按规律生成的串有个共同点：
 * 相邻两个单位之间的差值只有寥寥几种（这个家族 4 种，等差数列 1 种，短周期重复不超过周期长度），
 * 而随机串的相邻差值几乎各不相同。
 *
 * - 十六进制串（偶数长度、只含 0-9a-fA-F）按字节解码，数「相邻字节差（模 256）」有几种；
 * - 其他串按字符码数「相邻字符码差」有几种。
 * 少于 min(阈值, ⌊(单位数 − 1) / 2⌋) 即拒绝；后一项让短输入（如 `openssl rand -hex 16` 的 16 字节）
 * 不被按 32 字节的标准误判。
 *
 * 实测（以 sha256(种子-序号) 计数器作确定性随机源，每种形态 30 万个样本；jwt.spec.ts 用同一方法抽样回归）：
 * - `openssl rand -hex 32`（32 字节）相邻字节差种类最少 23 种（均值 29.3）；16 字节最少 10 种（均值 14.6，
 *   阈值按上式取 7）；
 * - 字符级：base64(32 字节) 最少 26、base64url 25、62 字母数字×32 19、可打印 ASCII×32 20、
 *   小写+数字×32 16、纯小写×32 14、两个 UUID 拼接 26，连只有 12 种符号的随机串×32 也最少 9。
 * 字节级阈值 12、字符级阈值 8 与这些最小值都隔着好几档，误判概率可以忽略；按规律生成的家族只有 1~4 种。
 */
export const MIN_DISTINCT_BYTE_DELTAS = 12;
export const MIN_DISTINCT_CHAR_DELTAS = 8;

const sha256Hex = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/** 密钥的 sha256 是否在拒绝清单里（清单可注入，便于测试） */
export function isLeakedJwtSecret(
  secret: string,
  blocklist: readonly string[] = LEAKED_JWT_SECRET_SHA256,
): boolean {
  return blocklist.includes(sha256Hex(secret));
}

/** a→b 是否「相邻」：+1 递增、-1 递减、0 不相邻。十六进制字母表里 9 与 a/A 相邻 */
function sequenceStep(a: string, b: string): number {
  const diff = (b.codePointAt(0) as number) - (a.codePointAt(0) as number);
  if (diff === 1 || (a === '9' && (b === 'a' || b === 'A'))) return 1;
  if (diff === -1 || ((a === 'a' || a === 'A') && b === '9')) return -1;
  return 0;
}

/** 最长的连续递增 / 递减片段长度（按字符计） */
export function longestSequentialRun(secret: string): number {
  const chars = [...secret];
  let longest = chars.length > 0 ? 1 : 0;
  let run = 1;
  let direction = 0;
  for (let i = 1; i < chars.length; i += 1) {
    const step = sequenceStep(chars[i - 1], chars[i]);
    if (step !== 0 && step === direction) {
      run += 1;
    } else {
      run = step !== 0 ? 2 : 1;
      direction = step;
    }
    longest = Math.max(longest, run);
  }
  return longest;
}

/** 偶数长度、只含十六进制字符（不分大小写）：按字节解码后再看相邻差值 */
export function isHexSecret(secret: string): boolean {
  return secret.length > 0 && secret.length % 2 === 0 && /^[0-9a-f]+$/i.test(secret);
}

/** 相邻两个单位的差值共有几种；mod 为 0 时按普通差值，否则取模（字节用 256） */
function distinctAdjacentDeltas(units: number[], mod: number): number {
  const deltas = new Set<number>();
  for (let i = 1; i < units.length; i += 1) {
    const d = units[i] - units[i - 1];
    deltas.add(mod > 0 ? (d + mod) % mod : d);
  }
  return deltas.size;
}

/**
 * 「相邻差值种类」检查（规则见 MIN_DISTINCT_BYTE_DELTAS 的说明）。
 * @returns 实际的种类数与阈值，以及是按字节还是按字符数的
 */
export function adjacentDeltaShape(secret: string): { unit: 'byte' | 'char'; distinct: number; min: number } {
  const hex = isHexSecret(secret);
  const units = hex ? Array.from(Buffer.from(secret, 'hex')) : [...secret].map((c) => c.codePointAt(0) as number);
  const base = hex ? MIN_DISTINCT_BYTE_DELTAS : MIN_DISTINCT_CHAR_DELTAS;
  return {
    unit: hex ? 'byte' : 'char',
    distinct: distinctAdjacentDeltas(units, hex ? 256 : 0),
    min: Math.min(base, Math.floor((units.length - 1) / 2)),
  };
}

/** 是否由一个不超过一半长度的片段整段重复构成（如 16 个十六进制字符重复 4 次，熵只有 64 bit） */
export function hasShortPeriod(secret: string): boolean {
  const chars = [...secret];
  for (let p = 1; p <= chars.length / 2; p += 1) {
    let periodic = true;
    for (let i = p; i < chars.length; i += 1) {
      if (chars[i] !== chars[i - p]) {
        periodic = false;
        break;
      }
    }
    if (periodic) return true;
  }
  return false;
}

/** 两个字符串是否有长度 ≥ minLength 的公共片段 */
export function hasSharedSubstring(a: string, b: string, minLength: number): boolean {
  if (a.length < minLength || b.length < minLength) return false;
  for (let i = 0; i + minLength <= a.length; i += 1) {
    if (b.includes(a.slice(i, i + minLength))) return true;
  }
  return false;
}

/**
 * b 是否是 a 逐位加同一个偏移得到的（「移位」的另一种形态）：
 * 按字符码；两者都是等长十六进制时，再按 4 位与按字节（模 16 / 模 256）各看一次。
 */
export function isConstantOffset(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0 || a === b) return false;
  const constant = (diffs: number[]) => diffs.every((d) => d === diffs[0]);
  const codes = (s: string) => [...s].map((c) => c.codePointAt(0) as number);
  const ca = codes(a);
  const cb = codes(b);
  if (ca.length === cb.length && constant(ca.map((x, i) => cb[i] - x))) return true;

  const hex = /^[0-9a-f]+$/i;
  if (!hex.test(a) || !hex.test(b)) return false;
  const nibbles = (s: string) => [...s].map((c) => parseInt(c, 16));
  const na = nibbles(a);
  const nb = nibbles(b);
  if (constant(na.map((x, i) => (nb[i] - x + 16) % 16))) return true;
  if (a.length % 2 !== 0) return false;
  const bytes = (s: string) => Array.from(Buffer.from(s, 'hex'));
  const ba = bytes(a);
  const bb = bytes(b);
  return constant(ba.map((x, i) => (bb[i] - x + 256) % 256));
}

/**
 * b 是否是 a 经过简单可逆变换得到的（1-F-1 二次复审）：只差大小写、整串反转、按位异或同一个值
 * （含逐位取反 / 十六进制逐位 15-x）、十六进制按字节反转或每个字节内两个半字节互换。
 * 知道其中一把就能推出另一把，等于两种 token 共用一把密钥。
 */
export function isSimpleTransform(a: string, b: string): boolean {
  if (a === b || a.length === 0 || b.length === 0) return false;
  if (a.toLowerCase() === b.toLowerCase()) return true;
  const ca = [...a].map((c) => c.codePointAt(0) as number);
  const cb = [...b].map((c) => c.codePointAt(0) as number);
  if (ca.length !== cb.length) return false;
  const reversed = [...ca].reverse();
  if (reversed.every((x, i) => x === cb[i])) return true;
  if (ca.every((x, i) => (x ^ cb[i]) === (ca[0] ^ cb[0]))) return true;

  if (!isHexSecret(a) || !isHexSecret(b)) return false;
  const ba = Array.from(Buffer.from(a, 'hex'));
  const bb = Array.from(Buffer.from(b, 'hex'));
  if (ba.every((x, i) => (x ^ bb[i]) === (ba[0] ^ bb[0]))) return true;
  if ([...ba].reverse().every((x, i) => x === bb[i])) return true;
  return ba.every((x, i) => (((x & 0x0f) << 4) | (x >> 4)) === bb[i]);
}

/** 两把密钥之间的问题（为空表示合格）；只描述问题，不回显密钥 */
export function jwtSecretPairProblems(secret: string, refreshSecret: string): string[] {
  if (secret === refreshSecret) {
    return ['JWT_SECRET 与 JWT_REFRESH_SECRET 相同（两种 token 必须用不同密钥）'];
  }
  const problems: string[] = [];
  if (hasSharedSubstring(secret, refreshSecret, MAX_SHARED_SUBSTRING)) {
    problems.push(
      `JWT_SECRET 与 JWT_REFRESH_SECRET 有 ${MAX_SHARED_SUBSTRING} 个以上字符的公共片段（一把由另一把改出来的）`,
    );
  }
  if (isConstantOffset(secret, refreshSecret)) {
    problems.push('JWT_REFRESH_SECRET 是 JWT_SECRET 逐位加同一偏移得到的（移位）');
  }
  if (isSimpleTransform(secret, refreshSecret)) {
    problems.push('JWT_REFRESH_SECRET 是 JWT_SECRET 简单变换得到的（大小写、反转、按位取反 / 异或、半字节互换）');
  }
  return problems;
}

export interface JwtConfig {
  /** access token 签名密钥 */
  secret: string;
  /** refresh token 签名密钥，必须与 secret 不同 */
  refreshSecret: string;
  /** access token 有效期（秒） */
  expiresIn: number;
  /** refresh token 有效期（秒，「记住我」登录用满这个值） */
  refreshExpiresIn: number;
}

type Env = Record<string, string | undefined>;

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 60 * 60, d: 24 * 60 * 60 };

/**
 * 把 '2h' / '7d' / '900' 这类写法解析成秒数。纯数字按秒；未设置或空串用 fallback；
 * 其他写法（'2 hours'、'1.5h'、'0'、超过上限……）直接抛错，不静默回退。
 */
export function parseTokenLifetime(key: string, raw: string | undefined, fallback: string): number {
  const value = raw === undefined || raw.trim() === '' ? fallback : raw.trim();
  const match = /^(\d+)([smhd]?)$/i.exec(value);
  const seconds = match ? Number(match[1]) * UNIT_SECONDS[(match[2] || 's').toLowerCase()] : NaN;
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > MAX_TOKEN_LIFETIME_SEC) {
    throw new Error(
      `${key} 非法: ${JSON.stringify(raw)}（需为正整数秒，或带单位 s/m/h/d，如 2h、7d；` +
        `不超过 ${MAX_TOKEN_LIFETIME_SEC / 86400}d）`,
    );
  }
  return seconds;
}

/** 返回密钥的问题列表（为空表示合格）。只描述问题，不回显密钥本身 */
export function jwtSecretProblems(secret: string | undefined): string[] {
  if (secret === undefined || secret.trim() === '') return ['未设置'];
  const problems: string[] = [];
  if (KNOWN_PLACEHOLDER_SECRETS.includes(secret) || PLACEHOLDER_PATTERN.test(secret)) {
    problems.push('是仓库里的示例/默认值');
  }
  // 按字符计：'请替换为64位随机字符串' 恰好 32 字节，按字节数会被放过
  if ([...secret].length < MIN_JWT_SECRET_LENGTH) {
    problems.push(`短于 ${MIN_JWT_SECRET_LENGTH} 个字符`);
  }
  if (new Set([...secret]).size < MIN_DISTINCT_SECRET_CHARS) {
    problems.push(`不同字符少于 ${MIN_DISTINCT_SECRET_CHARS} 个`);
  }
  if (longestSequentialRun(secret) >= MAX_SEQUENTIAL_RUN) {
    problems.push(`含 ${MAX_SEQUENTIAL_RUN} 个以上连续递增或递减的字符`);
  }
  const shape = adjacentDeltaShape(secret);
  if (shape.distinct < shape.min) {
    problems.push(
      `相邻${shape.unit === 'byte' ? '字节' : '字符'}的差值只有 ${shape.distinct} 种（少于 ${shape.min} 种：` +
        '像是按规律生成的，不是随机值）',
    );
  }
  if (hasShortPeriod(secret)) {
    problems.push('由一小段重复拼成');
  }
  if (isLeakedJwtSecret(secret)) {
    problems.push('是已泄露的密钥（已列入拒绝清单）');
  }
  return problems;
}

/**
 * 解析 JWT 配置。生产环境密钥不合格时抛错（让 Nest 启动失败、进程退出），
 * 非生产环境回落到开发默认值并通过 warn 提示。
 */
export function resolveJwtConfig(env: Env, warn: (message: string) => void): JwtConfig {
  const isProduction = env.NODE_ENV === 'production';
  const errors: string[] = [];

  const pick = (key: string, devDefault: string): string => {
    const value = env[key];
    const problems = jwtSecretProblems(value);
    if (problems.length === 0) return value as string;
    if (isProduction) {
      errors.push(`${key} ${problems.join('、')}`);
      return value ?? '';
    }
    const missing = value === undefined || value.trim() === '';
    warn(
      `${key} ${problems.join('、')}，${missing ? '使用开发默认值' : '照常使用'}` +
        '（仅限非生产环境；NODE_ENV=production 时会拒绝启动）',
    );
    return missing ? devDefault : (value as string);
  };

  const secret = pick('JWT_SECRET', DEV_JWT_SECRET);
  const refreshSecret = pick('JWT_REFRESH_SECRET', DEV_JWT_REFRESH_SECRET);

  // 两把都回落到开发默认值时不比对（默认值本来就是一对占位符，上面已各自告警）
  const bothDevDefaults = secret === DEV_JWT_SECRET && refreshSecret === DEV_JWT_REFRESH_SECRET;
  const pairProblems =
    secret !== '' && !bothDevDefaults ? jwtSecretPairProblems(secret, refreshSecret) : [];
  if (pairProblems.length > 0) {
    if (isProduction) {
      errors.push(...pairProblems);
    } else {
      warn(`${pairProblems.join('、')}（仅限非生产环境）`);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `JWT 密钥配置不安全，拒绝启动：${errors.join('；')}。` +
        `请在 .env.prod 中用 \`openssl rand -hex 32\` 分别生成两个密钥。`,
    );
  }

  return {
    secret,
    refreshSecret,
    expiresIn: parseTokenLifetime('JWT_EXPIRES_IN', env.JWT_EXPIRES_IN, DEFAULT_ACCESS_EXPIRES_IN),
    refreshExpiresIn: parseTokenLifetime(
      'JWT_REFRESH_EXPIRES_IN',
      env.JWT_REFRESH_EXPIRES_IN,
      DEFAULT_REFRESH_EXPIRES_IN,
    ),
  };
}
