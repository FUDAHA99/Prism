import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
  // 应用基础配置
  nodeEnv: process.env.NODE_ENV || 'development',
  appName: process.env.APP_NAME || 'cms-backend',
  appPort: parseInt(process.env.APP_PORT, 10) || 3000,
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  
  // JWT配置
  jwt: {
    secret: process.env.JWT_SECRET || 'your-jwt-secret-key-change-this-in-production',
    expiresIn: process.env.JWT_EXPIRES_IN || '2h',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'your-jwt-refresh-secret-key-change-this-in-production',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  },
  
  // 安全配置
  security: {
    bcryptSaltRounds: parseInt(process.env.BCRYPT_SALT_ROUNDS, 10) || 12,
    rateLimitTtl: parseInt(process.env.RATE_LIMIT_TTL, 10) || 60,
    rateLimitCount: parseInt(process.env.RATE_LIMIT_COUNT, 10) || 100,
  },
  
  // 文件上传配置
  upload: {
    maxSize: parseInt(process.env.UPLOAD_MAX_SIZE, 10) || 10 * 1024 * 1024, // 10MB
    dest: process.env.UPLOAD_DEST || './uploads',
  },
  
  // CORS配置
  cors: {
    origin: (process.env.CORS_ORIGIN || 'http://localhost:5173').split(','),
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
