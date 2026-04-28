export const dynamic = 'force-dynamic'

import Link from 'next/link'
import ArticleCard from '@/components/ArticleCard'
import PosterCard from '@/components/PosterCard'
import { getCategories, getContents, getTags, getMovies, getNovels, getComics } from '@/lib/api'

export const revalidate = 30

export default async function HomePage() {
  const [list, categories, tags, movieList, novelList, comicList] = await Promise.all([
    getContents({ page: 1, limit: 9 }),
    getCategories(),
    getTags(),
    getMovies({ limit: 8, isFeatured: true }).catch(() => getMovies({ limit: 8 })),
    getNovels({ limit: 8 }),
    getComics({ limit: 8 }),
  ])

  const articles = list.data
  const featured = articles[0]
  const rest = articles.slice(1)
  const movies = movieList.data
  const novels = novelList.data
  const comics = comicList.data

  /** 影视角标：电影→时长，剧集→集数 */
  function movieBadge(m: (typeof movies)[0]) {
    if (m.movieType === 'movie') {
      return m.duration ? `${m.duration}分钟` : null
    }
    if (m.isFinished) return `全${m.totalEpisodes ?? '?'}集`
    return m.currentEpisode ? `更新至${m.currentEpisode}集` : null
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-12">

      {/* ─── Hero + 文章 ─── */}
      <section>
        {/* Hero */}
        {featured ? (
          <div className="mb-8">
            <Link
              href={`/articles/${featured.slug}`}
              className="block bg-gradient-to-br from-brand-600 to-brand-700 rounded-xl p-8 text-white hover:shadow-lg transition"
            >
              <span className="inline-block px-2 py-1 text-xs bg-white/20 rounded mb-3">
                📌 最新发布
              </span>
              <h1 className="text-3xl font-bold mb-3">{featured.title}</h1>
              <p className="text-white/80 line-clamp-2">
                {featured.excerpt ||
                  featured.body
                    .replace(/[#*`>\-_!\[\]\(\)]/g, '')
                    .slice(0, 200)}
              </p>
              <div className="mt-4 text-sm text-white/70">
                {featured.author?.nickname || featured.author?.username} ·{' '}
                👁 {featured.viewCount}
              </div>
            </Link>
          </div>
        ) : (
          <div className="bg-white rounded-lg p-8 text-center text-gray-500 mb-8">
            暂无已发布的文章。
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* 文章网格 */}
          <div className="lg:col-span-3">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-semibold text-gray-800">最新文章</h2>
              <Link
                href="/articles"
                className="text-sm text-brand-600 hover:underline"
              >
                查看全部 →
              </Link>
            </div>
            {rest.length === 0 ? (
              <div className="bg-white rounded-lg p-8 text-center text-gray-400">
                没有更多文章
              </div>
            ) : (
              <div className="grid sm:grid-cols-2 gap-4">
                {rest.map((a) => (
                  <ArticleCard key={a.id} article={a} />
                ))}
              </div>
            )}
          </div>

          {/* 侧边栏 */}
          <aside className="space-y-6">
            {/* 分类 */}
            <div className="bg-white rounded-lg p-5 shadow-sm">
              <h3 className="font-semibold mb-3 text-gray-800">📂 分类</h3>
              {categories.length === 0 ? (
                <p className="text-sm text-gray-400">暂无分类</p>
              ) : (
                <ul className="space-y-1.5">
                  {categories.slice(0, 10).map((c) => (
                    <li key={c.id}>
                      <Link
                        href={`/category/${c.slug}`}
                        className="text-sm text-gray-700 hover:text-brand-600 flex items-center justify-between"
                      >
                        <span>{c.name}</span>
                        <span className="text-gray-400">→</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* 标签云 */}
            <div className="bg-white rounded-lg p-5 shadow-sm">
              <h3 className="font-semibold mb-3 text-gray-800">🏷 标签</h3>
              {tags.length === 0 ? (
                <p className="text-sm text-gray-400">暂无标签</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {tags.slice(0, 20).map((t) => (
                    <Link
                      key={t.id}
                      href={`/tag/${t.slug}`}
                      className="text-xs px-2 py-1 bg-gray-100 rounded text-gray-700 hover:bg-brand-50 hover:text-brand-600"
                    >
                      {t.name}
                      {typeof t.usageCount === 'number' && t.usageCount > 0 && (
                        <span className="ml-1 text-gray-400">({t.usageCount})</span>
                      )}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </aside>
        </div>
      </section>

      {/* ─── 影视推荐 ─── */}
      {movies.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold text-gray-800">🎬 影视推荐</h2>
            <Link href="/movies" className="text-sm text-brand-600 hover:underline">
              查看全部 →
            </Link>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
            {movies.map((m) => (
              <PosterCard
                key={m.id}
                href={`/movies/${m.slug}`}
                title={m.title}
                posterUrl={m.posterUrl}
                badge={movieBadge(m)}
                score={m.score}
                subtitle={[m.year, m.region].filter(Boolean).join(' · ')}
                size="sm"
              />
            ))}
          </div>
        </section>
      )}

      {/* ─── 小说推荐 ─── */}
      {novels.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold text-gray-800">📚 小说推荐</h2>
            <Link href="/novels" className="text-sm text-brand-600 hover:underline">
              查看全部 →
            </Link>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
            {novels.map((n) => (
              <PosterCard
                key={n.id}
                href={`/novels/${n.slug}`}
                title={n.title}
                posterUrl={n.coverUrl}
                badge={n.serialStatus === 'finished' ? '完结' : '连载中'}
                score={n.score}
                subtitle={n.author ?? undefined}
                size="sm"
              />
            ))}
          </div>
        </section>
      )}

      {/* ─── 漫画推荐 ─── */}
      {comics.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold text-gray-800">🖼 漫画推荐</h2>
            <Link href="/comics" className="text-sm text-brand-600 hover:underline">
              查看全部 →
            </Link>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
            {comics.map((c) => (
              <PosterCard
                key={c.id}
                href={`/comics/${c.slug}`}
                title={c.title}
                posterUrl={c.coverUrl}
                badge={c.serialStatus === 'finished' ? '完结' : `共${c.chapterCount}话`}
                score={c.score}
                subtitle={c.author ?? undefined}
                size="sm"
              />
            ))}
          </div>
        </section>
      )}

    </div>
  )
}
