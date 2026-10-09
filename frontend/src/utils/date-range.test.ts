import { describe, expect, it } from 'vitest'
import dayjs from 'dayjs'
import { dateRangePayload, toFormDateRange } from './date-range'

const START = '2026-10-01T00:00:00.000Z'
const END = '2026-10-31T16:00:00.000Z'

describe('toFormDateRange（编辑弹窗回填有效期）', () => {
  it('两端都有：两端都回填', () => {
    const r = toFormDateRange(START, END)
    expect(r?.[0]?.toISOString()).toBe(START)
    expect(r?.[1]?.toISOString()).toBe(END)
  })

  it('只有开始：开始回填、结束留空（不再显示成长期有效）', () => {
    const r = toFormDateRange(START, null)
    expect(r?.[0]?.toISOString()).toBe(START)
    expect(r?.[1]).toBeNull()
  })

  it('只有结束：结束回填、开始留空', () => {
    const r = toFormDateRange(undefined, END)
    expect(r?.[0]).toBeNull()
    expect(r?.[1]?.toISOString()).toBe(END)
  })

  it.each([
    [null, null],
    [undefined, undefined],
    ['', ''],
    ['not-a-date', null],
  ])('两端都没有（%s, %s）：undefined，即长期有效', (s, e) => {
    expect(toFormDateRange(s, e)).toBeUndefined()
  })
})

describe('dateRangePayload（提交的 startDate / endDate）', () => {
  it('新建：选了哪端提交哪端，空的一端提交 null', () => {
    expect(dateRangePayload([dayjs(START), dayjs(END)])).toEqual({ startDate: START, endDate: END })
    expect(dateRangePayload([dayjs(START), null])).toEqual({ startDate: START, endDate: null })
    expect(dateRangePayload(undefined)).toEqual({ startDate: null, endDate: null })
    expect(dateRangePayload(null)).toEqual({ startDate: null, endDate: null })
  })

  it.each([
    ['只有开始', START, null],
    ['只有结束', null, END],
    ['两端都有', START, END],
    ['长期有效', null, null],
  ])('编辑时没动有效期（%s）：两个字段都不提交，后端按不修改处理', (_label, start, end) => {
    const original = { startDate: start, endDate: end }
    const range = toFormDateRange(start, end)
    expect(dateRangePayload(range, original)).toEqual({})
  })

  it('原记录的时间写法不同但是同一时刻：仍视为没改', () => {
    const original = { startDate: '2026-10-01T08:00:00+08:00', endDate: null }
    expect(dateRangePayload(toFormDateRange(original.startDate, null), original)).toEqual({})
  })

  it('编辑时只有开始的记录补上结束：两端都提交', () => {
    const original = { startDate: START, endDate: null }
    expect(dateRangePayload([dayjs(START), dayjs(END)], original)).toEqual({ startDate: START, endDate: END })
  })

  it('编辑时清空有效期：两端提交 null，后端清除', () => {
    const original = { startDate: START, endDate: END }
    expect(dateRangePayload(null, original)).toEqual({ startDate: null, endDate: null })
    expect(dateRangePayload(undefined, original)).toEqual({ startDate: null, endDate: null })
  })

  it('编辑时只清掉一端：那一端提交 null，另一端照常提交', () => {
    const original = { startDate: START, endDate: END }
    expect(dateRangePayload([dayjs(START), null], original)).toEqual({ startDate: START, endDate: null })
  })
})
