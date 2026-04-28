export const dynamic = 'force-dynamic'

import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { getNovelBySlug, getNovelChapters, getNovelChapter } from '@/lib/api'

interface Props { params: { slug: string; chapterId: string } }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const ch = await getNovelChapter(params.chapterId)
  if (!ch) return { title: '未找到' }
  return { title: ch.title }
}

export default async function NovelChapterPage({ params }: Props) {
  const novel = await getNovelBySlug(params.slug)
  if (!novel) notFound()

  const [chapter, chapters] = await Promise.all([
    getNovelChapter(params.chapterId),
    getNovelChapters(novel.id),
  ])
  if (!chapter) notFound()

  const idx = chapters.findIndex((c) => c.id === chapter.id)
  const prev = idx > 0 ? chapters[idx - 1] : null
  const next = idx >= 0 && idx < chapters.length - 1 ? chapters[idx + 1] : null

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      <div className="text-sm text-gray-500 mb-3">
        <Link href="/novels" className="hover:text-brand-600">小说</Link>
        <span className="mx-1">/</span>
        <Link href={`/novels/${novel.slug}`} className="hover:text-brand-600">{novel.title}</Link>
        <span className="mx-1">/</span>
        <span className="text-gray-700">{chapter.title}</span>
      </div>

      <h1 className="text-2xl font-bold text-gray-900 mb-1">{chapter.title}</h1>
      <div className="text-xs text-gray-400 mb-6">
        第 {chapter.chapterNumber} 章 · {chapter.wordCount.toLocaleString()} 字
      </div>

      <article className="novel-reader bg-white rounded-lg px-6 py-8 shadow-sm">
        {chapter.content
          ? (chapter.content).split(/\n+/).map((p, i) =>
              p.trim() ? <p key={i}>{p.trim()}</p> : null,
            )
          : <p className="text-gray-400 italic" style={{ textIndent: 0 }}>本章内容暂未上传</p>
        }
      </article>

      <div className="mt-10 flex items-center justify-between">
        {prev ? (
          <Link href={`/novels/${novel.slug}/chapters/${prev.id}`}
            className="px-4 py-2 rounded bg-gray-100 hover:bg-gray-200 text-sm">← 上一章</Link>
        ) : <span />}
        <Link href={`/novels/${novel.slug}`} className="text-sm text-gray-500 hover:text-brand-600">目录</Link>
        {next ? (
          <Link href={`/novels/${novel.slug}/chapters/${next.id}`}
            className="px-4 py-2 rounded bg-brand-600 text-white hover:bg-brand-700 text-sm">下一章 →</Link>
        ) : <span />}
      </div>
    </div>
  )
}
