export const dynamic = 'force-dynamic'

import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { getNovelBySlug, getNovelChapters } from '@/lib/api'
import { safeMediaSrc } from '@/lib/safe-url'
import { parsePageParam } from '@/lib/page-param'
import Pagination from '@/components/Pagination'

interface Props {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ page?: string | string[] }>
}

export async function generateMetadata({ params: paramsPromise }: Props): Promise<Metadata> {
  const params = await paramsPromise
  const n = await getNovelBySlug(params.slug)
  if (!n) return { title: '未找到' }
  return { title: n.title, description: n.intro?.slice(0, 160) }
}

export default async function NovelDetailPage({ params: paramsPromise, searchParams: searchParamsPromise }: Props) {
  const params = await paramsPromise
  const novel = await getNovelBySlug(params.slug)
  if (!novel) notFound()

  const page = parsePageParam((await searchParamsPromise).page)
  const [list, firstPage] = await Promise.all([
    getNovelChapters(novel.id, { page }).catch(() => null),
    page > 1 ? getNovelChapters(novel.id, { page: 1, limit: 1 }).catch(() => null) : null,
  ])
  const chapters = list?.data ?? []
  const firstChapter = page === 1 ? chapters[0] : firstPage?.data[0]
  const coverSrc = safeMediaSrc(novel.coverUrl)

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden md:flex">
        <div className="md:w-56 md:shrink-0 bg-gray-100">
          {coverSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={coverSrc} alt={novel.title}
              className="w-full md:h-full object-cover aspect-[3/4]" />
          ) : (
            <div className="w-full aspect-[3/4] flex items-center justify-center text-gray-400">无封面</div>
          )}
        </div>
        <div className="p-5 flex-1">
          <h1 className="text-2xl md:text-3xl font-bold text-gray-900">{novel.title}</h1>
          <div className="text-sm text-gray-500 mt-1">作者：{novel.author || '未知'}</div>

          <div className="flex items-center gap-2 mt-3 text-sm">
            {Number(novel.score) > 0 && (
              <span className="text-amber-600 font-bold">★ {Number(novel.score).toFixed(1)}</span>
            )}
            <span className="px-2 py-0.5 bg-gray-100 rounded text-gray-700">
              {novel.serialStatus === 'finished' ? '已完结' : novel.serialStatus === 'paused' ? '暂停' : '连载中'}
            </span>
            <span className="text-gray-500">{novel.chapterCount} 章</span>
            {novel.wordCount > 0 && <span className="text-gray-500">{novel.wordCount.toLocaleString()} 字</span>}
          </div>

          {novel.intro && (
            <div className="mt-4">
              <h2 className="text-sm font-semibold text-gray-700 mb-1">简介</h2>
              <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">{novel.intro}</p>
            </div>
          )}

          {firstChapter && (
            <Link
              href={`/novels/${novel.slug}/chapters/${firstChapter.id}`}
              className="inline-block mt-4 px-5 py-2 bg-brand-600 hover:bg-brand-700 text-white rounded font-semibold"
            >
              开始阅读
            </Link>
          )}
        </div>
      </div>

      {list ? (
        <div className="mt-6 bg-white rounded-lg shadow-sm border border-gray-200">
          <div className="px-5 py-3 border-b border-gray-100 text-sm font-semibold text-gray-700">
            目录（{list.meta.total} 章）
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 p-4">
            {chapters.map((c) => (
              <Link
                key={c.id}
                href={`/novels/${novel.slug}/chapters/${c.id}`}
                className="px-3 py-2 text-sm rounded hover:bg-brand-50 hover:text-brand-700 truncate"
              >
                {c.chapterNumber}. {c.title}
              </Link>
            ))}
          </div>
          <Pagination currentPage={Number(list.meta.page)} totalPages={list.meta.totalPages} basePath={`/novels/${novel.slug}`} />
        </div>
      ) : <p className="mt-6 text-sm text-gray-500">目录加载失败，请稍后重试</p>}
    </div>
  )
}
