import { ValidationPipeOptions } from '@nestjs/common';

/**
 * 全局 ValidationPipe 的选项（main.ts 注册）。单独导出，让 DTO 单测用与生产完全相同的管道：
 * - whitelist + forbidNonWhitelisted：未声明校验装饰器的字段一律 400。
 *   因此 DTO 的每个字段都必须有装饰器 —— 漏掉的字段不是被忽略，而是让整个请求 400。
 * - transform + enableImplicitConversion：按 TS 类型元数据做隐式转换
 *   （注意缺省的 number 查询参数会变成 NaN）。
 */
export function globalValidationPipeOptions(): ValidationPipeOptions {
  // 每次返回新对象：ValidationPipe 与 class-transformer 都持有这个引用，避免共享可变状态
  return {
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    transformOptions: {
      enableImplicitConversion: true,
    },
  };
}
