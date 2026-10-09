import { BadRequestException } from '@nestjs/common';

/** 普通对象：不是 null、不是数组（DTO 实例也算；数组的 typeof 也是 'object'，要单独排除） */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 服务端逐项处理嵌套数组之前的兜底：每一项都必须是对象。
 *
 * 只靠 `@ValidateNested({ each: true })` 挡不住 `[[...]]`：class-validator 会继续递归进内层数组，内层是空数组或
 * 合法对象时整体通过，service 拿到的元素却是数组，读 `.name` / `.key` 全是 undefined —— 写库 NOT NULL 报 500，
 * 或者 `findOne({ where: { key: undefined } })` 被 TypeORM 忽略条件、命中表里第一行并改掉它。DTO 上已加
 * `@IsObject({ each: true })`；这里再兜一层，覆盖绕过 ValidationPipe 的调用方。缺省（undefined / null）按空数组处理。
 */
export function assertPlainObjects<T>(items: readonly T[] | null | undefined, label: string): T[] {
  if (items === undefined || items === null) return [];
  if (!Array.isArray(items)) {
    throw new BadRequestException(`${label} 必须是数组`);
  }
  items.forEach((item, index) => {
    if (!isPlainObject(item)) {
      throw new BadRequestException(`${label} 的第 ${index + 1} 项必须是对象`);
    }
  });
  return [...items];
}
