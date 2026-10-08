import { ValidationError, ValidationPipe, ValidationPipeOptions } from '@nestjs/common';

/**
 * 同一字段多条约束同时失败时，哪条排在前面（越靠前越优先）。
 *
 * 为什么要排：class-validator 按装饰器「自下而上」执行，失败消息也按这个顺序排；HttpExceptionFilter
 * 只把第一条放进 message（后台表单 / 门户都只显示它）。DTO 惯常写成
 * `@IsString() @IsNotEmpty() @MaxLength(100)`，于是漏传必填字段时报的是
 * 「title must be shorter than or equal to 100 characters」，而不是「title should not be empty」。
 * stopAtFirstError 解决不了：它只保留执行顺序上的第一条，恰好就是最下面的 MaxLength。
 *
 * 这里不改任何校验结果、也不增删消息，只调整每个字段内部的顺序：
 * 先「没填」（isDefined / isNotEmpty / arrayNotEmpty），再「类型不对」（isString / isInt ...），
 * 其余约束（长度、格式、取值范围）保持 class-validator 原来的相对顺序。
 */
export const CONSTRAINT_PRIORITY: readonly string[] = Object.freeze([
  'isDefined',
  'isNotEmpty',
  'arrayNotEmpty',
  'isNotEmptyObject',
  'isString',
  'isBoolean',
  'isInt',
  'isNumber',
  'isArray',
  'isObject',
]);

function rank(key: string): number {
  const i = CONSTRAINT_PRIORITY.indexOf(key);
  return i === -1 ? CONSTRAINT_PRIORITY.length : i;
}

/** 按 CONSTRAINT_PRIORITY 重排每个字段（含嵌套字段）的 constraints；返回新对象，不改入参 */
export function prioritizeConstraints(errors: ValidationError[]): ValidationError[] {
  return errors.map((error) => {
    const next: ValidationError = { ...error };
    if (error.constraints) {
      const keys = Object.keys(error.constraints);
      // Array.prototype.sort 是稳定排序：同一档内保持 class-validator 原来的顺序
      const ordered = keys
        .map((key, index) => ({ key, index }))
        .sort((a, b) => rank(a.key) - rank(b.key) || a.index - b.index);
      next.constraints = {};
      for (const { key } of ordered) next.constraints[key] = error.constraints[key];
    }
    if (error.children?.length) {
      next.children = prioritizeConstraints(error.children);
    }
    return next;
  });
}

/**
 * 只用来借 Nest 默认的 exceptionFactory（展平嵌套字段、拼 "items.0.name ..." 路径、抛 400），
 * 不自己重写展平逻辑，避免与 Nest 的输出格式产生细微差异。
 */
const defaultExceptionFactory = new ValidationPipe().createExceptionFactory();

/**
 * 全局 ValidationPipe 的选项（main.ts 注册）。单独导出，让 DTO 单测用与生产完全相同的管道：
 * - whitelist + forbidNonWhitelisted：未声明校验装饰器的字段一律 400。
 *   因此 DTO 的每个字段都必须有装饰器 —— 漏掉的字段不是被忽略，而是让整个请求 400。
 * - transform + enableImplicitConversion：按 TS 类型元数据做隐式转换
 *   （注意缺省的 number 查询参数会变成 NaN）。
 * - exceptionFactory：消息与默认实现完全相同，只是每个字段内「必填 / 类型」类消息排在最前（见 CONSTRAINT_PRIORITY）。
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
    exceptionFactory: (errors: ValidationError[]) => defaultExceptionFactory(prioritizeConstraints(errors)),
  };
}
