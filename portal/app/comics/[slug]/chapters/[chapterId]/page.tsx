import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { getComicBySlug, getComicChapters, getComicChapter } from '@/lib/api'

interface Props { params: { slug: string; chapterId: string } }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const ch = await getComicChapter(params.chapterId)
  if (!ch) return { title: '未找到' }
  return { title: ch.title }
}

export default async function ComicChapterPage({ params }: Props) {
  const comic = await getComicBySlug(params.slug)
  if (!comic) notFound()

  const [chapter, chapters] = await Promise.all([
    getComicChapter(params.chapterId),
    getComicChapters(comic.id),
  ])
  if (!chapter) notFound()

  const idx = chapters.findIndex((c) => c.id === chapter.id)
  const prev = idx > 0 ? chapters[idx - 1] : null
  const next = idx >= 0 && idx < chapters.length - 1 ? chapters[idx + 1] : null

  const pages = chapter.pageUrls ?? []

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      <div className="text-sm text-gray-500 mb-3">
        <Link href="/comics" className="hover:text-brand-600">漫画</Link>
        <span className="mx-1">/</span>
        <Link href={`/comics/${comic.slug}`} className="hover:text-brand-600">{comic.title}</Link>
        <span className="mx-1">/</span>
        <span className="text-gray-700">{chapter.title}</span>
      </div>

      <h1 className="text-xl font-bold text-gray-900 mb-1">{chapter.title}</h1>
      <div className="text-xs text-gray-400 mb-6">
        第 {chapter.chapterNumber} 话 · {chapter.pageCount} 页
      </div>

      <div className="flex flex-col gap-0 bg-black rounded overflow-hidden">
        {pages.length > 0 ? (
          pages.map((url, i) => (
            <div key={i} className="comic-page-wrap">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={url}
                alt={`${chapter.title} 第${i + 1}页`}
                loading="lazy"
                decoding="async"
                className="w-full h-auto block"
              />
            </div>
          ))
        ) : (
          <div className="py-12 text-center text-gray-400 italic">本话内容暂未上传</div>
        )}
      </div>

      <div className="mt-10 flex items-center justify-between">
        {prev ? (
          <Link href={`/comics/${comic.slug}/chapters/${prev.id}`}
            className="px-4 py-2 rounded bg-gray-100 hover:bg-gray-200 text-sm">← 上一话</Link>
        ) : <span />}
        <Link href={`/comics/${comic.slug}`} className="text-sm text-gray-500 hover:text-brand-600">目录</Link>
        {next ? (
          <Link href={`/comics/${comic.slug}/chapters/${next.id}`}
            className="px-4 py-2 rounded bg-brand-600 text-white hover:bg-brand-700 text-sm">下一话 →</Link>
        ) : <span />}
      </div>
    </div>
  )
}
