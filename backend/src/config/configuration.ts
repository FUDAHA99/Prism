import { Logger } from '@nestjs/common';
import { registerAs } from '@nestjs/config';
import { resolveJwtConfig } from './jwt';

export default registerAs('app', () => ({
  // 应用基础配置
  nodeEnv: process.env.NODE_ENV || 'development',
  appName: process.env.APP_NAME || 'cms-backend',
  appPort: parseInt(process.env.APP_PORT, 10) || 3000,
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  
  // JWT配置：生产环境密钥缺失 / 是示例值 / 过短时直接抛错拒绝启动，有效期统一解析成秒（见 config/jwt.ts）
  jwt: resolveJwtConfig(process.env, (message) => new Logger('JwtConfig').warn(message)),
  
  // 安全配置
  security: {
    bcryptSaltRounds: parseInt(process.env.BCRYPT_SALT_ROUNDS, 10) || 12,
    // 全局限流 RATE_LIMIT_TTL（毫秒）/ RATE_LIMIT_COUNT 只在 config/rate-limit.ts 解析与校验。
    // 这里原有的 rateLimitTtl/rateLimitCount 没有任何地方读取，且默认 60 还是「秒」时代的值，已删除
  },
  
  // 文件上传配置
  upload: {
    maxSize: parseInt(process.env.UPLOAD_MAX_SIZE, 10) || 10 * 1024 * 1024, // 10MB
    dest: process.env.UPLOAD_DEST || './uploads',
  },
  
  // 日志配置
  log: {
    level: process.env.LOG_LEVEL || 'info',
    maxSize: process.env.LOG_MAX_SIZE || '10m',
    maxFiles: process.env.LOG_MAX_FILES || '14d',
  },
  
  // 邮件配置
  mail: {
    host: process.env.MAIL_HOST,
    port: parseInt(process.env.MAIL_PORT, 10) || 587,
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
    from: process.env.MAIL_FROM || 'noreply@your-domain.com',
  },
  
  // 阿里云OSS配置
  oss: {
    region: process.env.OSS_REGION || 'oss-cn-hangzhou',
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    bucket: process.env.OSS_BUCKET || 'cms-bucket',
    endpoint: process.env.OSS_ENDPOINT || 'oss-cn-hangzhou.aliyuncs.com',
  },
  
  // Redis配置
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    password: process.env.REDIS_PASSWORD,
    db: parseInt(process.env.REDIS_DB, 10) || 0,
  },
  
  // 监控配置
  monitoring: {
    prometheusEnabled: process.env.PROMETHEUS_ENABLED === 'true',
  },
}));
