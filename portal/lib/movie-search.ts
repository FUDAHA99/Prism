import type { MovieType } from './types'
import { parsePageParam } from './page-param'

export interface MovieSearchParams {
  page?: string | string[]
  type?: string | string[]
  region?: string | string[]
  year?: string | string[]
  q?: string | string[]
}

// 与后端 MaxLength 使用的 validator/isLength 一致：代理对和 emoji 展示符不重复计数。
function characterLength(value: string): number {
  return value.length
    - (value.match(/[^\uFE0F\uFE0E][\uFE0F\uFE0E]/g) || []).length
    - (value.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g) || []).length
}

export function normalizeMovieSearchParams(raw: MovieSearchParams) {
  const movieType = typeof raw.type === 'string' && ['movie', 'tv', 'variety', 'anime', 'short'].includes(raw.type)
    ? raw.type as MovieType : undefined
  const region = typeof raw.region === 'string' && characterLength(raw.region) <= 100
    ? raw.region || undefined : undefined
  const year = typeof raw.year === 'string' && /^\d+$/.test(raw.year) && Number(raw.year) <= 9999
    ? Number(raw.year) : undefined
  const original = Array.isArray(raw.q) ? raw.q[0] ?? '' : raw.q ?? ''
  const trimmed = original.trim()
  const error = Array.isArray(raw.q)
    ? '搜索参数 q 不能重复，请修改后重新搜索。'
    : characterLength(trimmed) > 200
      ? '搜索词不能超过 200 个字符，请缩短后重新搜索。'
      : undefined
  return {
    page: parsePageParam(raw.page), movieType, region, year,
    search: error ? undefined : trimmed || undefined,
    inputValue: error ? original : trimmed,
    error,
  }
}
