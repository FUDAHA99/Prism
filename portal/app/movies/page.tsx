export const dynamic = 'force-dynamic'

import Link from 'next/link'
import type { Metadata } from 'next'
import { getMovies } from '@/lib/api'
import PosterCard from '@/components/PosterCard'
import Pagination from '@/components/Pagination'
import type { MovieType } from '@/lib/types'

export const metadata: Metadata = { title: '褰辫' }

interface PageProps {
  searchParams: {
    page?: string
    type?: MovieType | 'all'
    region?: string
    year?: string
    q?: string
  }
}

const TYPE_TABS: { key: MovieType | 'all'; label: string }[] = [
  { key: 'all', label: '鍏ㄩ儴' },
  { key: 'movie', label: '鐢靛奖' },
  { key: 'tv', label: '鐢佃鍓? },
  { key: 'anime', label: '鍔ㄦ极' },
  { key: 'variety', label: '缁艰壓' },
  { key: 'short', label: '鐭墽' },
]

export default async function MoviesPage({ searchParams }: PageProps) {
  const page = Math.max(1, parseInt(searchParams.page || '1', 10))
  const movieType = searchParams.type === 'all' ? undefined : (searchParams.type as MovieType | undefined)
  const region = searchParams.region || undefined
  const year = searchParams.year ? parseInt(searchParams.year, 10) : undefined
  const search = searchParams.q || undefined

  const list = await getMovies({
    page, limit: 24, movieType, region, year, search,
  }).catch(() => null)

  const items = list?.data ?? []
  const meta = list?.meta

  // 鏋勯€犱繚鐣欑瓫閫夊弬鏁扮殑閾炬帴
  const buildHref = (overrides: Record<string, string | undefined>) => {
    const next = new URLSearchParams()
    if (searchParams.type && searchParams.type !== 'all') next.set('type', searchParams.type)
    if (searchParams.region) next.set('region', searchParams.region)
    if (searchParams.year) next.set('year', searchParams.year)
    if (searchParams.q) next.set('q', searchParams.q)
    Object.entries(overrides).forEach(([k, v]) => {
      if (v == null || v === '') next.delete(k)
      else next.set(k, v)
    })
    const s = next.toString()
    return s ? `/movies?${s}` : '/movies'
  }

  // 骞翠唤閫夐」锛氬綋鍓嶅勾璧?7 骞?  const thisYear = new Date().getFullYear()
  const years = Array.from({ length: 8 }, (_, i) => thisYear - i)
  const regions = ['澶ч檰', '棣欐腐', '鍙版咕', '缇庡浗', '鏃ユ湰', '闊╁浗', '鑻卞浗', '鍏朵粬']

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-gray-900 mb-4">褰辫</h1>

      {/* 绛涢€夋潯 */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 mb-5 divide-y">
        <FilterRow label="绫诲瀷">
          {TYPE_TABS.map((t) => (
            <FilterPill
              key={t.key}
              active={
                t.key === 'all'
                  ? !searchParams.type || searchParams.type === 'all'
                  : searchParams.type === t.key
              }
              href={buildHref({ type: t.key === 'all' ? undefined : t.key, page: undefined })}
            >
              {t.label}
            </FilterPill>
          ))}
        </FilterRow>

        <FilterRow label="鍦板尯">
          <FilterPill active={!searchParams.region} href={buildHref({ region: undefined, page: undefined })}>
            鍏ㄩ儴
          </FilterPill>
          {regions.map((r) => (
            <FilterPill key={r} active={searchParams.region === r} href={buildHref({ region: r, page: undefined })}>
              {r}
            </FilterPill>
          ))}
        </FilterRow>

        <FilterRow label="骞翠唤">
          <FilterPill active={!searchParams.year} href={buildHref({ year: undefined, page: undefined })}>
            鍏ㄩ儴
          </FilterPill>
          {years.map((y) => (
            <FilterPill
              key={y}
              active={searchParams.year === String(y)}
              href={buildHref({ year: String(y), page: undefined })}
            >
              {y}
            </FilterPill>
          ))}
        </FilterRow>
      </div>

      {/* 缁撴灉 */}
      {!list ? (
        <div className="text-gray-500 text-sm py-12 text-center">鍔犺浇澶辫触</div>
      ) : items.length === 0 ? (
        <div className="text-gray-500 text-sm py-12 text-center">
          鏆傛棤绗﹀悎鏉′欢鐨勫奖瑙嗭紝
          <Link href="/movies" className="text-brand-600 hover:underline">鏌ョ湅鍏ㄩ儴</Link>
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
              subtitle={[m.year, m.region].filter(Boolean).join(' 路 ')}
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
  if (m.isFinished && m.totalEpisodes) return `鍏?{m.totalEpisodes}闆哷
  return null
}

function remarkOf(m: { currentEpisode?: number | null; isFinished: boolean; movieType: string }): string | null {
  if (m.movieType === 'movie') return null
  if (m.isFinished) return '宸插畬缁?
  if (m.currentEpisode) return `鏇存柊鑷崇 ${m.currentEpisode} 闆哷
  return null
}

