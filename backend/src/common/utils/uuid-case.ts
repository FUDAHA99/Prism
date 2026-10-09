/**
 * UUID 统一成小写（库里 TypeORM 生成的都是小写）。生产库的排序规则不区分大小写，JS 里的 === 却区分：
 * 比较或写库之前先归一，否则「大写的自己」会被当成另一个节点（见父级成环检查）。
 */
export function lowerUuid(value: string): string;
export function lowerUuid(value: string | null | undefined): string | null | undefined;
export function lowerUuid(value: string | null | undefined): string | null | undefined {
  return typeof value === 'string' ? value.toLowerCase() : value;
}

/** class-transformer 用：请求体里的 UUID 字段转小写，非字符串原样交给校验（于是 400） */
export const toLowerUuid = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.toLowerCase() : value;
