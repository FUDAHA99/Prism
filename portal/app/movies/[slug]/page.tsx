export const dynamic = 'force-dynamic'

import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { getMovieBySlug, getMovies } from '@/lib/api'
import PosterCard from '@/components/PosterCard'
import { friendlySourceName, movieTypeLabel } from '@/lib/movie-utils'

interface Props {
  params: { slug: string }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const m = await getMovieBySlug(params.slug)
  if (!m) return { title: '未找到' }
  return {
    title: m.title,
    description: m.intro?.slice(0, 160) || `${m.title} 在线观看`,
  }
}

export default async function MovieDetailPage({ params }: Props) {
  const movie = await getMovieBySlug(params.slug)
  if (!movie) notFound()

  // 同类推荐：取相同 movieType 6 条（不含自己）
  const related = await getMovies({ movieType: movie.movieType, limit: 12 })
    .then((r) => r.data.filter((x) => x.id !== movie.id).slice(0, 6))
    .catch(() => [])

  const sources = movie.sources ?? []
  const firstSource = sources[0]
  const firstEpisode = firstSource?.episodes?.[0]

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      {/* 头部信息 */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <div className="md:flex">
          <div className="md:w-64 md:shrink-0 bg-gray-100">
            {movie.posterUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={movie.posterUrl}
                alt={movie.title}
                className="w-full h-full object-cover aspect-[3/4]"
              />
            ) : (
              <div className="w-full aspect-[3/4] flex items-center justify-center text-gray-400">
                无封面
              </div>
            )}
          </div>

          <div className="p-5 flex-1 min-w-0">
            <h1 className="text-2xl md:text-3xl font-bold text-gray-900 break-words">
              {movie.title}
            </h1>
            {movie.originalTitle && (
              <div className="text-sm text-gray-500 mt-1">{movie.originalTitle}</div>
            )}

            <div className="flex items-center gap-3 mt-3 text-sm">
              {Number(movie.score) > 0 && (
                <span className="flex items-center gap-1 text-amber-600 font-bold">
                  ★ {Number(movie.score).toFixed(1)}
                </span>
              )}
              <span className="px-2 py-0.5 bg-gray-100 rounded text-gray-700">
                {movieTypeLabel(movie.movieType)}
              </span>
              {movie.totalEpisodes && movie.totalEpisodes > 1 && (
                <span className="px-2 py-0.5 bg-gray-100 rounded text-gray-700">
                  {movie.isFinished ? `全${movie.totalEpisodes}集` : `更新至第 ${movie.currentEpisode ?? '?'} 集`}
                </span>
              )}
            </div>

            <dl className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
              <Field label="年代">{movie.year || '-'}</Field>
              <Field label="地区">{movie.region || '-'}</Field>
              <Field label="语言">{movie.language || '-'}</Field>
              <Field label="导演">{movie.director || '-'}</Field>
              <Field label="主演" wide>{movie.actors || '-'}</Field>
            </dl>

            {firstEpisode && firstSource && (
              <div className="mt-5">
                <Link
                  href={`/movies/${movie.slug}/play/0/0`}
                  className="inline-block px-6 py-2.5 bg-brand-600 hover:bg-brand-700 text-white rounded-md font-semibold shadow"
                >
                  ▶ 立即观看
                </Link>
              </div>
            )}
          </div>
        </div>

        {movie.intro && (
          <div className="border-t border-gray-100 px-5 py-4">
            <h2 className="text-sm font-semibold text-gray-700 mb-1.5">剧情简介</h2>
            <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">
              {movie.intro}
            </p>
          </div>
        )}
      </div>

      {/* 线路 + 剧集 */}
      {sources.length > 0 && (
        <div className="mt-6 bg-white rounded-lg shadow-sm border border-gray-200">
          <div className="border-b border-gray-100 px-5 pt-4 pb-2 flex items-center gap-3 flex-wrap">
            <span className="text-sm font-semibold text-gray-700">播放线路：</span>
            {sources.map((s, i) => (
              <span
                key={s.id}
                className={`px-3 py-1 text-sm rounded ${
                  i === 0 ? 'bg-brand-600 text-white' : 'bg-gray-100 text-gray-700'
                }`}
              >
                {friendlySourceName(s.name, i)}
                <span className="ml-1 opacity-75 text-xs">({s.episodes?.length ?? 0})</span>
              </span>
            ))}
            <span className="text-xs text-gray-400 ml-2">点击下方剧集切换播放</span>
          </div>

          {sources.map((src, srcIdx) => (
            <div key={src.id} className="px-5 py-4 border-t border-gray-100 first:border-t-0">
              <div className="text-sm font-medium text-gray-700 mb-2">
                {friendlySourceName(src.name, srcIdx)}
                <span className="text-xs text-gray-400 ml-2">{src.episodes?.length ?? 0} 集</span>
              </div>
              <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-8 gap-2">
                {(src.episodes ?? []).map((ep, epIdx) => (
                  <Link
                    key={ep.id}
                    href={`/movies/${movie.slug}/play/${srcIdx}/${epIdx}`}
                    className="px-2 py-1.5 text-sm text-center rounded border border-gray-200 hover:border-brand-500 hover:bg-brand-50 hover:text-brand-700 truncate"
                    title={ep.title}
                  >
                    {ep.title}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 同类推荐 */}
      {related.length > 0 && (
        <div className="mt-6">
          <h2 className="text-lg font-bold text-gray-900 mb-3">相关推荐</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
            {related.map((m) => (
              <PosterCard
                key={m.id}
                href={`/movies/${m.slug}`}
                title={m.title}
                posterUrl={m.posterUrl}
                score={m.score}
                size="sm"
                subtitle={[m.year, m.region].filter(Boolean).join(' · ')}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function Field({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? 'sm:col-span-2' : ''}>
      <dt className="inline text-gray-500">{label}：</dt>
      <dd className="inline text-gray-700">{children}</dd>
    </div>
  )
}


