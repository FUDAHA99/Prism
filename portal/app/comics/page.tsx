export const dynamic = 'force-dynamic'

import type { Metadata } from 'next'
import { getComics } from '@/lib/api'
import PosterCard from '@/components/PosterCard'
import Pagination from '@/components/Pagination'

export const metadata: Metadata = { title: '婕敾' }

export default async function ComicsPage({
  searchParams,
}: { searchParams: { page?: string; q?: string } }) {
  const page = Math.max(1, parseInt(searchParams.page || '1', 10))
  const list = await getComics({ page, limit: 24, search: searchParams.q }).catch(() => null)
  const items = list?.data ?? []
  const meta = list?.meta

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-gray-900 mb-5">婕敾</h1>

      {!list ? (
        <div className="text-gray-500 text-sm py-12 text-center">鍔犺浇澶辫触</div>
      ) : items.length === 0 ? (
        <div className="text-gray-500 text-sm py-12 text-center">鏆傛棤婕敾</div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3 sm:gap-4">
          {items.map((c) => (
            <PosterCard
              key={c.id}
              href={`/comics/${c.slug}`}
              title={c.title}
              posterUrl={c.coverUrl}
              score={c.score}
              badge={c.serialStatus === 'finished' ? '瀹岀粨' : null}
              remark={c.author ? `浣滆€咃細${c.author}` : null}
              subtitle={c.chapterCount ? `${c.chapterCount} 璇漙 : null}
            />
          ))}
        </div>
      )}

      {meta && meta.totalPages > 1 && (
        <div className="mt-8">
          <Pagination
            currentPage={Number(meta.page)}
            totalPages={meta.totalPages}
            basePath="/comics"
          />
        </div>
      )}
    </div>
  )
}

