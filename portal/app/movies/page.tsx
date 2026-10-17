export const dynamic = 'force-dynamic'

import Link from 'next/link'
import type { Metadata } from 'next'
import { getMovies } from '@/lib/api'
import { normalizeMovieSearchParams, type MovieSearchParams } from '@/lib/movie-search'
import PosterCard from '@/components/PosterCard'
import Pagination from '@/components/Pagination'
import type { MovieType } from '@/lib/types'

export const metadata: Metadata = { title: '影视' }

interface PageProps {
  searchParams: Promise<MovieSearchParams>
}

const TYPE_TABS: { key: MovieType | 'all'; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'movie', label: '电影' },
  { key: 'tv', label: '电视剧' },
  { key: 'anime', label: '动漫' },
  { key: 'variety', label: '综艺' },
  { key: 'short', label: '短剧' },
]

export default async function MoviesPage({ searchParams: searchParamsPromise }: PageProps) {
  const searchParams = await searchParamsPromise
  const { page, movieType, region, year, search, inputValue, error: searchError } = normalizeMovieSearchParams(searchParams)

  const list = searchError ? null : await getMovies({
    page, limit: 24, movieType, region, year, search,
  }).catch(() => null)

  const items = list?.data ?? []
  const meta = list?.meta

  // 构造保留筛选参数的链接
  const buildHref = (overrides: Record<string, string | undefined>) => {
    const next = new URLSearchParams()
    if (movieType) next.set('type', movieType)
    if (region) next.set('region', region)
    if (year !== undefined) next.set('year', String(year))
    if (search) next.set('q', search)
    // 错误参数保持可见，切换筛选不能悄悄把重复 / 超长词变成另一项有效搜索。
    if (searchError) {
      const values = Array.isArray(searchParams.q) ? searchParams.q : [searchParams.q ?? '']
      values.forEach((value) => next.append('q', value))
    }
    Object.entries(overrides).forEach(([k, v]) => {
      if (v == null || v === '') next.delete(k)
      else next.set(k, v)
    })
    const s = next.toString()
    return s ? `/movies?${s}` : '/movies'
  }

  // 年份选项：当前年起 7 年
  const thisYear = new Date().getFullYear()
  const years = Array.from({ length: 8 }, (_, i) => thisYear - i)
  const regions = ['大陆', '香港', '台湾', '美国', '日本', '韩国', '英国', '其他']

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-gray-900 mb-4">影视</h1>

      <form key={JSON.stringify(searchParams)} action="/movies" method="get" className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-5">
        <label htmlFor="movie-search" className="block text-sm font-medium text-gray-700 mb-2">搜索影视</label>
        <div className="flex flex-wrap items-center gap-2">
          {/* 避免历史返回恢复离开前的输入草稿，回填仍以 URL 为准。 */}
          <input
            id="movie-search"
            name="q"
            type="search"
            autoComplete="off"
            defaultValue={inputValue}
            placeholder="片名、别名、导演或演员"
            aria-describedby={searchError ? 'movie-search-help movie-search-error' : 'movie-search-help'}
            aria-invalid={searchError ? true : undefined}
            className="min-w-0 flex-1 basis-48 rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:border-brand-500"
          />
          {movieType && <input type="hidden" name="type" value={movieType} />}
          {region && <input type="hidden" name="region" value={region} />}
          {year !== undefined && <input type="hidden" name="year" value={year} />}
          <button type="submit" className="rounded bg-brand-600 px-4 py-2 text-sm text-white hover:bg-brand-700">搜索</button>
          <a href={buildHref({ q: undefined })} className="px-2 py-2 text-sm text-gray-600 hover:text-brand-600">清空搜索</a>
        </div>
        <p id="movie-search-help" className="mt-2 text-xs text-gray-500">支持片名、别名、导演或演员，最多 200 个字符。</p>
        {searchError && <p id="movie-search-error" role="alert" className="mt-2 text-sm text-red-600">{searchError}</p>}
      </form>

      {/* 筛选条 */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 mb-5 divide-y">
        <FilterRow label="类型">
          {TYPE_TABS.map((t) => (
            <FilterPill
              key={t.key}
              active={
                t.key === 'all' ? !movieType : movieType === t.key
              }
              href={buildHref({ type: t.key === 'all' ? undefined : t.key, page: undefined })}
            >
              {t.label}
            </FilterPill>
          ))}
        </FilterRow>

        <FilterRow label="地区">
          <FilterPill active={!region} href={buildHref({ region: undefined, page: undefined })}>
            全部
          </FilterPill>
          {regions.map((r) => (
            <FilterPill key={r} active={region === r} href={buildHref({ region: r, page: undefined })}>
              {r}
            </FilterPill>
          ))}
        </FilterRow>

        <FilterRow label="年份">
          <FilterPill active={year === undefined} href={buildHref({ year: undefined, page: undefined })}>
            全部
          </FilterPill>
          {years.map((y) => (
            <FilterPill
              key={y}
              active={year === y}
              href={buildHref({ year: String(y), page: undefined })}
            >
              {y}
            </FilterPill>
          ))}
        </FilterRow>
      </div>

      {!searchError && (
        <div className="mb-4 text-sm text-gray-600 break-words">
          <p>{search ? `搜索“${search}”` : '全部影视'}{movieType && ` · 类型：${TYPE_TABS.find((t) => t.key === movieType)?.label}`}{region && ` · 地区：${region}`}{year !== undefined && ` · 年份：${year}`}</p>
          {meta && <p className="mt-1">共 {meta.total} 条匹配结果</p>}
        </div>
      )}

      {/* 结果 */}
      {searchError ? null : !list ? (
        <div role="alert" className="text-gray-500 text-sm py-12 text-center">影视加载失败，请稍后重试。</div>
      ) : meta?.total === 0 ? (
        <div className="text-gray-500 text-sm py-12 text-center">
          没有匹配的影视，请尝试其他关键词或筛选条件。
        </div>
      ) : items.length === 0 ? (
        <div className="text-gray-500 text-sm py-12 text-center">
          <p>当前页没有结果，共 {meta?.total} 条匹配结果。</p>
          <Link href={buildHref({ page: undefined })} className="inline-block mt-2 text-brand-600 hover:underline">返回第 1 页</Link>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3 sm:gap-4">
          {items.map((m) => (
            <PosterCard
              key={m.id}
              href={`/movies/${m.slug}`}
              title={m.title}
              posterUrl={m.posterUrl}
              score={m.score}
              badge={badgeOf(m)}
              remark={remarkOf(m)}
              subtitle={[m.year, m.region].filter(Boolean).join(' · ')}
            />
          ))}
        </div>
      )}

      {meta && meta.totalPages > 1 && (
        <div className="mt-8">
          <Pagination
            currentPage={Number(meta.page)}
            totalPages={meta.totalPages}
            buildHref={(p) => buildHref({ page: String(p) })}
          />
        </div>
      )}
    </div>
  )
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 px-4 py-2.5">
      <span className="text-sm text-gray-500 shrink-0 w-10 pt-1">{label}</span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  )
}

function FilterPill({
  active, href, children,
}: { active: boolean; href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={`px-3 py-1 text-sm rounded transition ${
        active
          ? 'bg-brand-600 text-white font-medium'
          : 'text-gray-600 hover:bg-gray-100'
      }`}
    >
      {children}
    </Link>
  )
}

function badgeOf(m: { isFinished: boolean; totalEpisodes?: number | null; movieType: string }): string | null {
  if (m.movieType === 'movie') return null
  if (m.isFinished && m.totalEpisodes) return `全${m.totalEpisodes}集`
  return null
}

function remarkOf(m: { currentEpisode?: number | null; isFinished: boolean; movieType: string }): string | null {
  if (m.movieType === 'movie') return null
  if (m.isFinished) return '已完结'
  if (m.currentEpisode) return `更新至第 ${m.currentEpisode} 集`
  return null
}
