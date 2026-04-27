import Link from 'next/link'
import dayjs from 'dayjs'
import type { Content } from '@/lib/types'

export default function ArticleCard({ article }: { article: Content }) {
  return (
    <article className="bg-white rounded-lg shadow-sm hover:shadow-md transition p-5">
      {article.featuredImageUrl && (
        <Link href={`/articles/${article.slug}`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={article.featuredImageUrl}
            alt={article.title}
            className="w-full h-48 object-cover rounded mb-4"
          />
        </Link>
      )}

      <Link href={`/articles/${article.slug}`}>
        <h2 className="text-xl font-semibold text-gray-900 hover:text-brand-600 mb-2 line-clamp-2">
          {article.title}
        </h2>
      </Link>

      <p className="text-gray-600 text-sm line-clamp-3 mb-4">
        {article.excerpt || article.body.replace(/[#*`>\-_!\[\]\(\)]/g, '').slice(0, 120)}
      </p>

      <div className="flex items-center justify-between text-xs text-gray-500">
        <div className="flex items-center gap-3">
          {article.author && (
            <span className="flex items-center gap-1">
              <span className="h-5 w-5 rounded-full bg-brand-500 text-white text-[10px] flex items-center justify-center">
                {(article.author.nickname || article.author.username).charAt(0)}
              </span>
              {article.author.nickname || article.author.username}
            </span>
          )}
          {article.category && (
            <Link
              href={`/category/${article.category.slug}`}
              className="px-2 py-0.5 rounded bg-brand-50 text-brand-600 hover:bg-brand-100"
            >
              {article.category.name}
            </Link>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span>👁 {article.viewCount ?? 0}</span>
          <time>
            {article.publishedAt
              ? dayjs(article.publishedAt).format('YYYY-MM-DD')
              : dayjs(article.createdAt).format('YYYY-MM-DD')}
          </time>
        </div>
      </div>
    </article>
  )
}
