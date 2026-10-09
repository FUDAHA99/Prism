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

/**
 * 查询串里的可选 UUID：空串按没传处理（此前 `?contentId=` 走「没传」分支），字符串转小写，
 * 数组 / 对象（qs 把 `?a=1&a=2`、`?a[b]=1` 解析成的形状）原样交给 IsUUID 判为 400。
 */
export const toOptionalLowerUuid = ({ value }: { value: unknown }): unknown => {
  if (value === '') return undefined;
  return typeof value === 'string' ? value.toLowerCase() : value;
};
