import { notFound } from 'next/navigation'
import ArticleCard from '@/components/ArticleCard'
import Pagination from '@/components/Pagination'
import { getContents, getSiteConfig, getTagBySlug } from '@/lib/api'

export const revalidate = 30

interface Props {
  params: { slug: string }
  searchParams: { page?: string }
}

export async function generateMetadata({ params }: Props) {
  const tag = await getTagBySlug(params.slug)
  return { title: tag ? `标签：${tag.name}` : '标签未找到' }
}

export default async function TagPage({ params, searchParams }: Props) {
  const tag = await getTagBySlug(params.slug)
  if (!tag) notFound()

  const page = Math.max(1, Number(searchParams.page) || 1)
  const config = await getSiteConfig().catch(() => ({ postsPerPage: 10 } as any))
  const limit = config.postsPerPage || 10

  const list = await getContents({ page, limit, tagId: tag.id })
  const articles = list.data
  const totalPages = list.meta.totalPages || 1

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="bg-white rounded-lg p-6 mb-6 shadow-sm">
        <span className="text-xs bg-gray-100 px-2 py-0.5 rounded text-gray-600">🏷 标签</span>
        <h1 className="text-2xl font-bold mt-2 text-gray-900"># {tag.name}</h1>
        <p className="text-gray-500 text-xs mt-2">共 {list.meta.total} 篇文章</p>
      </div>

      {articles.length === 0 ? (
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
