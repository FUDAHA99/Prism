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

  /** 褰辫瑙掓爣锛氱數褰扁啋鏃堕暱锛屽墽闆嗏啋闆嗘暟 */
  function movieBadge(m: (typeof movies)[0]) {
    if (m.movieType === 'movie') {
      return m.duration ? `${m.duration}鍒嗛挓` : null
    }
    if (m.isFinished) return `鍏?{m.totalEpisodes ?? '?'}闆哷
    return m.currentEpisode ? `鏇存柊鑷?{m.currentEpisode}闆哷 : null
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-12">

      {/* 鈹€鈹€鈹€ Hero + 鏂囩珷 鈹€鈹€鈹€ */}
      <section>
        {/* Hero */}
        {featured ? (
          <div className="mb-8">
            <Link
              href={`/articles/${featured.slug}`}
              className="block bg-gradient-to-br from-brand-600 to-brand-700 rounded-xl p-8 text-white hover:shadow-lg transition"
            >
              <span className="inline-block px-2 py-1 text-xs bg-white/20 rounded mb-3">
                馃搶 鏈€鏂板彂甯?              </span>
              <h1 className="text-3xl font-bold mb-3">{featured.title}</h1>
              <p className="text-white/80 line-clamp-2">
                {featured.excerpt ||
                  featured.body
                    .replace(/[#*`>\-_!\[\]\(\)]/g, '')
                    .slice(0, 200)}
              </p>
              <div className="mt-4 text-sm text-white/70">
                {featured.author?.nickname || featured.author?.username} 路{' '}
                馃憗 {featured.viewCount}
              </div>
            </Link>
          </div>
        ) : (
          <div className="bg-white rounded-lg p-8 text-center text-gray-500 mb-8">
            鏆傛棤宸插彂甯冪殑鏂囩珷銆?          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* 鏂囩珷缃戞牸 */}
          <div className="lg:col-span-3">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-semibold text-gray-800">鏈€鏂版枃绔?/h2>
              <Link
                href="/articles"
                className="text-sm text-brand-600 hover:underline"
              >
                鏌ョ湅鍏ㄩ儴 鈫?              </Link>
            </div>
            {rest.length === 0 ? (
              <div className="bg-white rounded-lg p-8 text-center text-gray-400">
                娌℃湁鏇村鏂囩珷
              </div>
            ) : (
              <div className="grid sm:grid-cols-2 gap-4">
                {rest.map((a) => (
                  <ArticleCard key={a.id} article={a} />
                ))}
              </div>
            )}
          </div>

          {/* 渚ц竟鏍?*/}
          <aside className="space-y-6">
            {/* 鍒嗙被 */}
            <div className="bg-white rounded-lg p-5 shadow-sm">
              <h3 className="font-semibold mb-3 text-gray-800">馃搨 鍒嗙被</h3>
              {categories.length === 0 ? (
                <p className="text-sm text-gray-400">鏆傛棤鍒嗙被</p>
              ) : (
                <ul className="space-y-1.5">
                  {categories.slice(0, 10).map((c) => (
                    <li key={c.id}>
                      <Link
                        href={`/category/${c.slug}`}
                        className="text-sm text-gray-700 hover:text-brand-600 flex items-center justify-between"
                      >
                        <span>{c.name}</span>
                        <span className="text-gray-400">鈫?/span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* 鏍囩浜?*/}
            <div className="bg-white rounded-lg p-5 shadow-sm">
              <h3 className="font-semibold mb-3 text-gray-800">馃彿 鏍囩</h3>
              {tags.length === 0 ? (
                <p className="text-sm text-gray-400">鏆傛棤鏍囩</p>
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

      {/* 鈹€鈹€鈹€ 褰辫鎺ㄨ崘 鈹€鈹€鈹€ */}
      {movies.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold text-gray-800">馃幀 褰辫鎺ㄨ崘</h2>
            <Link href="/movies" className="text-sm text-brand-600 hover:underline">
              鏌ョ湅鍏ㄩ儴 鈫?            </Link>
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
                subtitle={[m.year, m.region].filter(Boolean).join(' 路 ')}
                size="sm"
              />
            ))}
          </div>
        </section>
      )}

      {/* 鈹€鈹€鈹€ 灏忚鎺ㄨ崘 鈹€鈹€鈹€ */}
      {novels.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold text-gray-800">馃摎 灏忚鎺ㄨ崘</h2>
            <Link href="/novels" className="text-sm text-brand-600 hover:underline">
              鏌ョ湅鍏ㄩ儴 鈫?            </Link>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
            {novels.map((n) => (
              <PosterCard
                key={n.id}
                href={`/novels/${n.slug}`}
                title={n.title}
                posterUrl={n.coverUrl}
                badge={n.serialStatus === 'finished' ? '瀹岀粨' : '杩炶浇涓?}
                score={n.score}
                subtitle={n.author ?? undefined}
                size="sm"
              />
            ))}
          </div>
        </section>
      )}

      {/* 鈹€鈹€鈹€ 婕敾鎺ㄨ崘 鈹€鈹€鈹€ */}
      {comics.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold text-gray-800">馃柤 婕敾鎺ㄨ崘</h2>
            <Link href="/comics" className="text-sm text-brand-600 hover:underline">
              鏌ョ湅鍏ㄩ儴 鈫?            </Link>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
            {comics.map((c) => (
              <PosterCard
                key={c.id}
                href={`/comics/${c.slug}`}
                title={c.title}
                posterUrl={c.coverUrl}
                badge={c.serialStatus === 'finished' ? '瀹岀粨' : `鍏?{c.chapterCount}璇漙}
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

