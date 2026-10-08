/**
 * JWT 密钥与有效期的解析和启动期校验（批次 1-F-1）。
 *
 * 此前 configuration.ts 写的是 `process.env.JWT_SECRET || '<仓库里公开的默认值>'`，启动不报错：
 * 生产忘了配密钥（docker-compose 的 ${JWT_SECRET} 会得到空串）就静默回落到人人可见的默认值，
 * 任何人都能伪造任意用户的 token。现在：
 *
 * - NODE_ENV=production：JWT_SECRET / JWT_REFRESH_SECRET 缺失、等于仓库里出现过的示例/默认值、
 *   看起来是占位符、短于 32 字符、或两者相同 —— 一律抛错，应用拒绝启动。
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

/** 示例值的常见写法：拷模板后只改了几个字符的也拦住 */
const PLACEHOLDER_PATTERN = /change[-_ ]?(this|me|in[-_ ]?production)|请替换|^your[-_]/i;

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

  if (secret === refreshSecret && secret !== '') {
    if (isProduction) {
      errors.push('JWT_SECRET 与 JWT_REFRESH_SECRET 相同（两种 token 必须用不同密钥）');
    } else {
      warn('JWT_SECRET 与 JWT_REFRESH_SECRET 相同（仅限非生产环境）');
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
