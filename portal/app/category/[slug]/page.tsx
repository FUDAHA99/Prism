export const dynamic = 'force-dynamic'

import { notFound } from 'next/navigation'
import ArticleCard from '@/components/ArticleCard'
import Pagination from '@/components/Pagination'
import { getCategoryBySlug, getContents, getSiteConfig } from '@/lib/api'

export const revalidate = 30

interface Props {
  params: { slug: string }
  searchParams: { page?: string }
}

export async function generateMetadata({ params }: Props) {
  const cat = await getCategoryBySlug(params.slug)
  return { title: cat ? `分类：${cat.name}` : '分类未找到' }
}

export default async function CategoryPage({ params, searchParams }: Props) {
  const cat = await getCategoryBySlug(params.slug)
  if (!cat) notFound()

  const page = Math.max(1, Number(searchParams.page) || 1)
  const config = await getSiteConfig().catch(() => ({ postsPerPage: 10 } as any))
  const limit = config.postsPerPage || 10

  const list = await getContents({ page, limit, categoryId: cat.id })
  const articles = list.data
  const totalPages = list.meta.totalPages || 1

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="bg-gradient-to-r from-brand-600 to-brand-700 rounded-lg p-6 mb-6 text-white">
        <span className="text-xs bg-white/20 px-2 py-0.5 rounded">📂 分类</span>
        <h1 className="text-2xl font-bold mt-2">{cat.name}</h1>
        {cat.description && (
          <p className="text-white/80 text-sm mt-2">{cat.description}</p>
        )}
        <p className="text-white/70 text-xs mt-2">共 {list.meta.total} 篇文章</p>
      </div>

      {articles.length === 0 ? (
        <div className="bg-white rounded-lg p-12 text-center text-gray-400">
          该分类暂无文章
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
        basePath={`/category/${params.slug}`}
      />
    </div>
  )
}
