import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  
  const configService = app.get(ConfigService);
  const port = configService.get<number>('APP_PORT', 3000);
  const nodeEnv = configService.get<string>('NODE_ENV', 'development');

  // 信任前置的 nginx 一层代理。
  // ThrottlerBehindProxyGuard 用 req.ips[0] 作限流 key，而 Express 只有在
  // trust proxy 开启后才会解析 X-Forwarded-For 填充 req.ips；否则 req.ips
  // 恒为空数组，回退到 req.ip —— 那是 nginx 容器的内网 IP，全体访客因此
  // 共用同一个限流桶，几个用户刷首页就能让其他人吃 429。
  // 取 1 而非 true：只信任最近一跳，避免客户端自行伪造 X-Forwarded-For。
  app.set('trust proxy', 1);
  
  // 安全中间件
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'", "https://*.aliyuncs.com"],
        },
      },
      crossOriginEmbedderPolicy: false,
    })
  );
  
  // Cookie解析
  app.use(cookieParser());
  
  // CORS配置
  const corsOrigins = configService.get<string>('CORS_ORIGIN', '').split(',');
  app.enableCors({
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  });
  
  // 全局前缀
  app.setGlobalPrefix('api/v1');
  
  // 全局管道 - 数据验证
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    })
  );
  
  // 全局过滤器 - 异常处理
  app.useGlobalFilters(new HttpExceptionFilter());
  
  // 全局拦截器
  app.useGlobalInterceptors(
    new TransformInterceptor(),
    new LoggingInterceptor()
  );
  
  // 静态文件服务
  app.useStaticAssets('uploads', {
    prefix: '/uploads/',
  });
  
  await app.listen(port);
  
  console.log(`\n🚀 CMS Backend 启动成功！`);
  console.log(`📱 环境: ${nodeEnv}`);
  console.log(`🌐 地址: http://localhost:${port}`);
  console.log(`⏰ 启动时间: ${new Date().toISOString()}\n`);
}

bootstrap().catch((error) => {
  console.error('❌ 应用启动失败:', error);
  process.exit(1);
});
