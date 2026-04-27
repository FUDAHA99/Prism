import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { getComicBySlug, getComicChapters } from '@/lib/api'

interface Props { params: { slug: string } }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const c = await getComicBySlug(params.slug)
  if (!c) return { title: '未找到' }
  return { title: c.title, description: c.intro?.slice(0, 160) }
}

export default async function ComicDetailPage({ params }: Props) {
  const comic = await getComicBySlug(params.slug)
  if (!comic) notFound()

  const chapters = await getComicChapters(comic.id)

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden md:flex">
        <div className="md:w-56 md:shrink-0 bg-gray-100">
          {comic.coverUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={comic.coverUrl} alt={comic.title}
              className="w-full md:h-full object-cover aspect-[3/4]" />
          ) : (
            <div className="w-full aspect-[3/4] flex items-center justify-center text-gray-400">无封面</div>
          )}
        </div>
        <div className="p-5 flex-1">
          <h1 className="text-2xl md:text-3xl font-bold text-gray-900">{comic.title}</h1>
          <div className="text-sm text-gray-500 mt-1">作者：{comic.author || '未知'}</div>

          <div className="flex items-center gap-2 mt-3 text-sm">
            {Number(comic.score) > 0 && (
              <span className="text-amber-600 font-bold">★ {Number(comic.score).toFixed(1)}</span>
            )}
            <span className="px-2 py-0.5 bg-gray-100 rounded text-gray-700">
              {comic.serialStatus === 'finished' ? '已完结' : comic.serialStatus === 'paused' ? '暂停' : '连载中'}
            </span>
            <span className="text-gray-500">{comic.chapterCount} 话</span>
          </div>

          {comic.intro && (
            <div className="mt-4">
              <h2 className="text-sm font-semibold text-gray-700 mb-1">简介</h2>
              <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">{comic.intro}</p>
            </div>
          )}

          {chapters[0] && (
            <Link
              href={`/comics/${comic.slug}/chapters/${chapters[0].id}`}
              className="inline-block mt-4 px-5 py-2 bg-brand-600 hover:bg-brand-700 text-white rounded font-semibold"
            >
              开始阅读
            </Link>
          )}
        </div>
      </div>

      {chapters.length > 0 && (
        <div className="mt-6 bg-white rounded-lg shadow-sm border border-gray-200">
          <div className="px-5 py-3 border-b border-gray-100 text-sm font-semibold text-gray-700">
            目录（{chapters.length} 话）
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 p-4">
            {chapters.map((c) => (
              <Link
                key={c.id}
                href={`/comics/${comic.slug}/chapters/${c.id}`}
                className="px-3 py-2 text-sm rounded hover:bg-brand-50 hover:text-brand-700 truncate"
              >
                {c.chapterNumber}. {c.title}
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
