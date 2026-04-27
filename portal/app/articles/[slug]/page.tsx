import Link from 'next/link'
import { notFound } from 'next/navigation'
import dayjs from 'dayjs'
import MarkdownView from '@/components/MarkdownView'
import CommentSection from '@/components/CommentSection'
import { getContentBySlug, getSiteConfig } from '@/lib/api'

export const revalidate = 30

interface Props {
  params: { slug: string }
}

export async function generateMetadata({ params }: Props) {
  const article = await getContentBySlug(params.slug)
  if (!article) return { title: '文章未找到' }
  return {
    title: article.metaTitle || article.title,
    description:
      article.metaDescription ||
      article.excerpt ||
      article.body.slice(0, 120),
  }
}

export default async function ArticleDetailPage({ params }: Props) {
  const [article, config] = await Promise.all([
    getContentBySlug(params.slug),
    getSiteConfig().catch(() => null),
  ])

  if (!article) notFound()

  const enableComment = config?.enableComment ?? true
  const needAudit = config?.commentAudit ?? true

  return (
    <article className="max-w-3xl mx-auto px-4 py-8">
      {/* 面包屑 */}
      <nav className="text-xs text-gray-500 mb-4 space-x-1">
        <Link href="/" className="hover:text-brand-600">首页</Link>
        <span>/</span>
        <Link href="/articles" className="hover:text-brand-600">文章</Link>
        {article.category && (
          <>
            <span>/</span>
            <Link
              href={`/category/${article.category.slug}`}
              className="hover:text-brand-600"
            >
              {article.category.name}
            </Link>
          </>
        )}
      </nav>

      {/* 标题区 */}
      <header className="mb-6 bg-white rounded-lg p-6 shadow-sm">
        <h1 className="text-3xl font-bold text-gray-900 mb-3">
          {article.title}
        </h1>
        <div className="flex flex-wrap items-center gap-3 text-sm text-gray-500">
          {article.author && (
            <span className="flex items-center gap-1.5">
              <span className="h-6 w-6 rounded-full bg-brand-500 text-white text-xs flex items-center justify-center">
                {(article.author.nickname || article.author.username).charAt(0)}
              </span>
              {article.author.nickname || article.author.username}
            </span>
          )}
          <span>·</span>
          <time>
            {article.publishedAt
              ? dayjs(article.publishedAt).format('YYYY-MM-DD HH:mm')
              : dayjs(article.createdAt).format('YYYY-MM-DD HH:mm')}
          </time>
          <span>·</span>
          <span>👁 {article.viewCount} 阅读</span>
          {article.category && (
            <>
              <span>·</span>
              <Link
                href={`/category/${article.category.slug}`}
                className="px-2 py-0.5 bg-brand-50 text-brand-600 rounded hover:bg-brand-100"
              >
                {article.category.name}
              </Link>
            </>
          )}
        </div>
      </header>

      {/* 封面图 */}
      {article.featuredImageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={article.featuredImageUrl}
          alt={article.title}
          className="w-full max-h-[420px] object-cover rounded-lg mb-6 shadow-sm"
        />
      )}

      {/* 正文 */}
      <div className="bg-white rounded-lg p-6 shadow-sm">
        <MarkdownView source={article.body} />
      </div>

      {/* 标签 */}
      {article.tags && article.tags.length > 0 && (
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <span className="text-sm text-gray-500">标签：</span>
          {article.tags.map((t) => (
            <Link
              key={t.id}
              href={`/tag/${t.slug}`}
              className="text-xs px-2 py-1 bg-gray-100 rounded text-gray-700 hover:bg-brand-50 hover:text-brand-600"
            >
              # {t.name}
            </Link>
          ))}
        </div>
      )}

      {/* 评论 */}
      <CommentSection
        contentId={article.id}
        enabled={enableComment}
        needAudit={needAudit}
      />
    </article>
  )
}
