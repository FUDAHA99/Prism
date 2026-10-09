import dayjs, { type Dayjs } from 'dayjs'

/**
 * 公告 / 广告的有效期（startDate / endDate）在编辑弹窗里的 RangePicker 值。
 *
 * 两端都可以单独为空：后端允许只设一端（只设开始 = 从某天起长期有效，只设结束 = 到某天为止），
 * 列表的「有效期」列也按单端显示。RangePicker 需配 allowEmpty={[true, true]}。
 */
export type OptionalDateRange = [Dayjs | null, Dayjs | null]

export interface DateRangeFields {
  startDate?: string | null
  endDate?: string | null
}

function toDayjs(value: string | null | undefined): Dayjs | null {
  if (!value) return null
  const d = dayjs(value)
  return d.isValid() ? d : null
}

/** 编辑时回填：记录里有哪一端就回填哪一端（另一端留空）；两端都没有 → undefined（长期有效） */
export function toFormDateRange(
  startDate: string | null | undefined,
  endDate: string | null | undefined,
): OptionalDateRange | undefined {
  const start = toDayjs(startDate)
  const end = toDayjs(endDate)
  return start || end ? [start, end] : undefined
}

function toIso(value: Dayjs | null | undefined): string | null {
  return value && value.isValid() ? value.toISOString() : null
}

/**
 * 提交时的 startDate / endDate：空的一端提交 null（后端据此清除）。
 *
 * 编辑时传入原记录：两端都与原值相同（用户没动有效期）就不提交这两个字段，后端按「不修改」处理 ——
 * 此前只有一端的记录回填不出来、提交成 null，改任何字段都会把已有的那一端清掉。
 */
export function dateRangePayload(
  range: OptionalDateRange | null | undefined,
  original?: DateRangeFields,
): DateRangeFields {
  const next = { startDate: toIso(range?.[0]), endDate: toIso(range?.[1]) }
  if (original) {
    const unchanged =
      next.startDate === toIso(toDayjs(original.startDate)) &&
      next.endDate === toIso(toDayjs(original.endDate))
    if (unchanged) return {}
  }
  return next
}
