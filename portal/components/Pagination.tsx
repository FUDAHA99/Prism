import Link from 'next/link'

interface Props {
  currentPage: number
  totalPages: number
  /** 任选其一 */
  basePath?: string                       // 形如 "/articles"
  buildHref?: (page: number) => string    // 自定义构造（保留其他筛选参数）
}

export default function Pagination({ currentPage, totalPages, basePath, buildHref: customBuildHref }: Props) {
  if (totalPages <= 1) return null

  const pages: number[] = []
  const start = Math.max(1, currentPage - 2)
  const end = Math.min(totalPages, currentPage + 2)
  for (let i = start; i <= end; i++) pages.push(i)

  const buildHref = customBuildHref ?? ((p: number) => `${basePath ?? ''}?page=${p}`)

  return (
    <nav className="flex items-center justify-center gap-2 mt-10">
      {currentPage > 1 && (
        <Link
          href={buildHref(currentPage - 1)}
          className="px-3 py-1.5 text-sm rounded border border-gray-200 bg-white hover:bg-gray-50"
        >
          上一页
        </Link>
      )}

      {start > 1 && (
        <>
          <Link
            href={buildHref(1)}
            className="px-3 py-1.5 text-sm rounded border border-gray-200 bg-white hover:bg-gray-50"
          >
            1
          </Link>
          {start > 2 && <span className="px-1 text-gray-400">…</span>}
        </>
      )}

      {pages.map((p) => (
        <Link
          key={p}
          href={buildHref(p)}
          className={`px-3 py-1.5 text-sm rounded border ${
            p === currentPage
              ? 'bg-brand-600 text-white border-brand-600'
              : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
          }`}
        >
          {p}
        </Link>
      ))}

      {end < totalPages && (
        <>
          {end < totalPages - 1 && <span className="px-1 text-gray-400">…</span>}
          <Link
            href={buildHref(totalPages)}
            className="px-3 py-1.5 text-sm rounded border border-gray-200 bg-white hover:bg-gray-50"
          >
            {totalPages}
          </Link>
        </>
      )}

      {currentPage < totalPages && (
        <Link
          href={buildHref(currentPage + 1)}
          className="px-3 py-1.5 text-sm rounded border border-gray-200 bg-white hover:bg-gray-50"
        >
          下一页
        </Link>
      )}
    </nav>
  )
}
