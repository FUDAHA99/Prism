import { BadRequestException } from '@nestjs/common';

/**
 * 请求体里的可选时间字段（公告、广告的生效起止）：
 * undefined = 没提交（不改）；null = 清除；字符串 = 已由 DTO 的 IsISO8601 校验过的时间。
 */
export function toOptionalDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return new Date(value);
}

/** 有效期的结束不能早于开始（两端都有值时才比较）；不合法时 400 */
export function assertDateRange(start: Date | null | undefined, end: Date | null | undefined): void {
  if (start && end && end.getTime() < start.getTime()) {
    throw new BadRequestException('结束时间不能早于开始时间');
  }
}
