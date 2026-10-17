'use client'

import type { FormEvent, ReactNode } from 'react'
import { normalizeMovieSearchParams } from '@/lib/movie-search'

export default function MovieSearchForm({ children }: { children: ReactNode }) {
  const reportSubmit = (event: FormEvent<HTMLFormElement>) => {
    const values = new FormData(event.currentTarget).getAll('q')
    if (!values.every((value): value is string => typeof value === 'string')) return
    const { search, error } = normalizeMovieSearchParams({ q: values.length === 1 ? values[0] : values })
    if (!search || error) return
    // 独立尽力上报；原生 GET 不等待统计，不重试，也不读取登录或游客身份。
    try {
      void fetch('/api/v1/stats/search-keywords', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword: search }),
        credentials: 'omit',
        keepalive: true,
      }).catch(() => {})
    } catch {
      // 浏览器无法发出统计请求时仍正常提交搜索。
    }
  }

  return (
    <form action="/movies" method="get" onSubmit={reportSubmit} className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-5">
      {children}
    </form>
  )
}
