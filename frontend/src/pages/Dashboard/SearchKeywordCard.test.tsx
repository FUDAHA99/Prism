import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useQuery } from '@tanstack/react-query'
import { ApiError } from '../../api/errors'
import { getSearchKeywords } from '../../api/stats'
import SearchKeywordCard from './SearchKeywordCard'

vi.mock('@tanstack/react-query', () => ({ useQuery: vi.fn() }))

const loaded = {
  data: { items: [{ keyword: '中文 & <script> + /?#', count: 12 }], from: '2026-10-11', to: '2026-10-17', timeZone: 'Asia/Shanghai' },
  isPending: false as const,
  error: null,
  refetch: vi.fn(),
}
// Only the fields consumed by this card are supplied by the query mock.
const query = vi.mocked(useQuery, { partial: true })

beforeEach(() => {
  query.mockReset()
  query.mockReturnValue(loaded)
})

describe('admin search keyword leaderboard', () => {
  it.each([{ roles: ['editor'] }, { roles: [] }, { roles: ['ADMIN'] }, { roles: undefined }, { roles: 'admin' }])('does not mount or query for $roles', ({ roles }) => {
    expect(renderToStaticMarkup(<SearchKeywordCard roles={roles} />)).toBe('')
    expect(query).not.toHaveBeenCalled()
  })

  it('queries only for an admin and renders escaped keywords, counts and encoded portal links', () => {
    const html = renderToStaticMarkup(<SearchKeywordCard roles={['editor', 'admin']} />)
    expect(query).toHaveBeenCalledOnce()
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['search-keywords'], queryFn: getSearchKeywords }))
    expect(html).toContain('近7日影视搜索提交榜')
    expect(html).toContain('有效上报次数')
    expect(html).toContain('不代表独立访客数')
    expect(html).toContain('2026-10-11')
    expect(html).toContain('2026-10-17')
    expect(html).toContain('>12</td>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
    const href = html.match(/href="([^"]+)"/)?.[1]
    const url = new URL(href!)
    expect(url.pathname).toBe('/movies')
    expect(url.searchParams.get('q')).toBe(loaded.data.items[0].keyword)
    expect([...url.searchParams.keys()]).toEqual(['q'])
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('distinguishes loading, an empty ranking and a read failure', () => {
    query.mockReturnValue({ ...loaded, data: undefined, isPending: true })
    expect(renderToStaticMarkup(<SearchKeywordCard roles={['admin']} />)).toContain('正在加载搜索榜单')
    query.mockReturnValue({ ...loaded, data: { ...loaded.data, items: [] } })
    expect(renderToStaticMarkup(<SearchKeywordCard roles={['admin']} />)).toContain('近7日暂无有效搜索上报')
    query.mockReturnValue({ ...loaded, error: new ApiError('搜索统计暂不可用，请稍后重试', { status: 503 }) })
    const failed = renderToStaticMarkup(<SearchKeywordCard roles={['admin']} />)
    expect(failed).toContain('搜索统计暂不可用，请稍后重试')
    expect(failed).toContain('重新加载')
    expect(failed).not.toContain('近7日暂无有效搜索上报')
  })
})
