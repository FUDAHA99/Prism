import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

/**
 * 整个 AppModule 的依赖注入图能否解析（批次 1-F-3）。
 *
 * HTTP 用例都是手工拼的测试模块（只挑被测 controller / service），模块之间漏了 imports —— 例如 AuthController
 * 依赖 SiteSettingService、而 AuthModule 没有导入 SiteSettingModule —— 测试照样全绿，要到生产启动时才报
 * 「Nest can't resolve dependencies」。Nest 的 preview 模式只解析依赖、不执行构造函数 / 工厂 / 生命周期钩子，
 * 不连数据库与 Redis，所以可以放进单测。abortOnError: false 让解析失败抛错，而不是直接退出进程。
 */

jest.setTimeout(60_000);

describe('AppModule 依赖注入图（preview 模式）', () => {
  it('所有 controller / provider 的依赖都能在各自模块里解析到', async () => {
    const app = await NestFactory.createApplicationContext(AppModule, {
      preview: true,
      logger: false,
      abortOnError: false,
    });
    await app.close();
  });
});
