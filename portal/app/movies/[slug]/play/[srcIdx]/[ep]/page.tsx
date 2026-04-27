import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { getMovieBySlug } from '@/lib/api'
import HlsPlayer from '@/components/HlsPlayer'
import { friendlySourceName } from '@/lib/movie-utils'

interface Props {
  params: { slug: string; srcIdx: string; ep: string }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const m = await getMovieBySlug(params.slug)
  if (!m) return { title: '播放页' }
  return { title: `${m.title} - 在线播放` }
}

export default async function PlayPage({ params }: Props) {
  const movie = await getMovieBySlug(params.slug)
  if (!movie) notFound()

  const sources = movie.sources ?? []
  const srcIdx = parseInt(params.srcIdx, 10)
  const epIdx = parseInt(params.ep, 10)
  const source = sources[srcIdx]
  const episode = source?.episodes?.[epIdx]

  if (!source || !episode) notFound()

  return (
    <div className="bg-gray-900 min-h-screen">
      <div className="max-w-6xl mx-auto px-3 py-4">
        {/* 面包屑 */}
        <div className="text-sm text-gray-400 mb-2">
          <Link href="/" className="hover:text-white">首页</Link>
          <span className="mx-1">/</span>
          <Link href="/movies" className="hover:text-white">影视</Link>
          <span className="mx-1">/</span>
          <Link href={`/movies/${movie.slug}`} className="hover:text-white">{movie.title}</Link>
          <span className="mx-1">/</span>
          <span className="text-gray-200">{episode.title}</span>
        </div>

        {/* 播放器 */}
        <HlsPlayer src={episode.url} poster={movie.posterUrl} />

        {/* 标题/状态 */}
        <div className="mt-3 text-white">
          <h1 className="text-lg font-semibold">
            {movie.title}
            <span className="ml-2 text-sm text-gray-400">{episode.title}</span>
          </h1>
          <div className="text-xs text-gray-400 mt-1">
            当前线路：{friendlySourceName(source.name, srcIdx)} · 共 {source.episodes?.length ?? 0} 集
          </div>
        </div>

        {/* 上一集 / 下一集 */}
        <div className="mt-3 flex items-center gap-2 text-sm">
          {epIdx > 0 ? (
            <Link
              href={`/movies/${movie.slug}/play/${srcIdx}/${epIdx - 1}`}
              className="px-3 py-1.5 rounded bg-gray-800 text-gray-200 hover:bg-gray-700"
            >
              ← 上一集
            </Link>
          ) : (
            <span className="px-3 py-1.5 rounded bg-gray-800 text-gray-500">← 上一集</span>
          )}
          {source.episodes && epIdx < source.episodes.length - 1 ? (
            <Link
              href={`/movies/${movie.slug}/play/${srcIdx}/${epIdx + 1}`}
              className="px-3 py-1.5 rounded bg-brand-600 text-white hover:bg-brand-700"
            >
              下一集 →
            </Link>
          ) : (
            <span className="px-3 py-1.5 rounded bg-gray-800 text-gray-500">下一集 →</span>
          )}
          <Link
            href={`/movies/${movie.slug}`}
            className="px-3 py-1.5 rounded bg-gray-800 text-gray-200 hover:bg-gray-700 ml-auto"
          >
            返回详情
          </Link>
        </div>

        {/* 线路切换 */}
        {sources.length > 1 && (
          <div className="mt-5">
            <div className="text-sm text-gray-300 mb-2">切换线路：</div>
            <div className="flex flex-wrap gap-2">
              {sources.map((s, i) => (
                <Link
                  key={s.id}
                  href={`/movies/${movie.slug}/play/${i}/0`}
                  className={`px-3 py-1.5 text-sm rounded ${
                    i === srcIdx
                      ? 'bg-brand-600 text-white'
                      : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                  }`}
                >
                  {friendlySourceName(s.name, i)}
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* 剧集列表 */}
        <div className="mt-5">
          <div className="text-sm text-gray-300 mb-2">
            {friendlySourceName(source.name, srcIdx)} · 共 {source.episodes?.length ?? 0} 集
          </div>
          <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-10 gap-2">
            {(source.episodes ?? []).map((ep, i) => (
              <Link
                key={ep.id}
                href={`/movies/${movie.slug}/play/${srcIdx}/${i}`}
                className={`px-2 py-1.5 text-sm text-center rounded truncate ${
                  i === epIdx
                    ? 'bg-brand-600 text-white'
                    : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                }`}
                title={ep.title}
              >
                {ep.title}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
