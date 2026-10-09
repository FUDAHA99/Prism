export const dynamic = 'force-dynamic'

import { notFound } from 'next/navigation'
import ArticleCard from '@/components/ArticleCard'
import Pagination from '@/components/Pagination'
import { getContents, getSiteConfig, getTagBySlug } from '@/lib/api'
import { clampListLimit, parsePageParam } from '@/lib/page-param'

export const revalidate = 30

interface Props {
  params: { slug: string }
  searchParams: { page?: string }
}

export async function generateMetadata({ params }: Props) {
  // 拉取失败（undefined）不等于不存在（null）：失败时只给通用标题
  const tag = await getTagBySlug(params.slug).catch(() => undefined)
  if (tag === undefined) return { title: '标签' }
  return { title: tag ? `标签：${tag.name}` : '标签未找到' }
}

export default async function TagPage({ params, searchParams }: Props) {
  // 标签列表拉取失败（undefined）与标签不存在（null）分开：前者整页降级为「加载失败」，后者 404
  const tag = await getTagBySlug(params.slug).catch(() => undefined)
  if (tag === null) notFound()
  if (!tag) {
    return (
      <div className="max-w-6xl mx-auto px-4 py-8">
        <div className="bg-white rounded-lg p-12 text-center text-gray-400">
          加载失败，请稍后刷新重试
        </div>
      </div>
    )
  }

  // 地址栏里的 page 先收成后端认的值（1–100000 的整数）：后端对非法 page 返回 400；文章列表出错时降级为「加载失败」
  const page = parsePageParam(searchParams.page)
  const config = await getSiteConfig().catch(() => null)
  const limit = clampListLimit(config?.postsPerPage)

  const list = await getContents({ page, limit, tagId: tag.id }).catch(() => null)
  const articles = list?.data ?? []
  const totalPages = list?.meta.totalPages || 1

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="bg-white rounded-lg p-6 mb-6 shadow-sm">
        <span className="text-xs bg-gray-100 px-2 py-0.5 rounded text-gray-600">🏷 标签</span>
        <h1 className="text-2xl font-bold mt-2 text-gray-900"># {tag.name}</h1>
        {list && <p className="text-gray-500 text-xs mt-2">共 {list.meta.total} 篇文章</p>}
      </div>

      {!list ? (
        <div className="bg-white rounded-lg p-12 text-center text-gray-400">
          加载失败，请稍后刷新重试
        </div>
      ) : articles.length === 0 ? (
        <div className="bg-white rounded-lg p-12 text-center text-gray-400">
          该标签暂无文章
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {articles.map((a) => (
            <ArticleCard key={a.id} article={a} />
          ))}
        </div>
      )}

      <Pagination
        currentPage={page}
        totalPages={totalPages}
        basePath={`/tag/${params.slug}`}
      />
    </div>
  )
}
