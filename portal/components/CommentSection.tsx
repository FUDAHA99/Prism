'use client'

import { useEffect, useState, FormEvent } from 'react'
import dayjs from 'dayjs'
import type { Pagination, PublicComment } from '@/lib/types'

interface Props {
  contentId: string
  enabled: boolean
  needAudit: boolean
}

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:3001'

/**
 * 显示用昵称：注册用户的 guestName 由后端取账号昵称 / 用户名，游客的是自己填的（去空白后为空按匿名）。
 * 旧数据里可能是纯空白，这里也按没填处理。
 */
function displayName(c: Pick<PublicComment, 'guestName' | 'isRegistered'>): string {
  const name = c.guestName?.trim()
  if (name) return name
  return c.isRegistered ? '用户' : '匿名'
}

/**
 * 昵称旁的身份标识。游客可以随便填昵称（后端只拦与注册用户重名的），所以昵称本身不能证明身份，
 * 以后端按 userId 推导的 isRegistered 为准。
 */
function IdentityBadge({ isRegistered }: Pick<PublicComment, 'isRegistered'>) {
  return isRegistered ? (
    <span className="ml-1.5 align-middle text-[10px] font-normal px-1.5 py-0.5 rounded bg-brand-50 text-brand-600">
      注册用户
    </span>
  ) : (
    <span className="ml-1.5 align-middle text-[10px] font-normal px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">
      游客
    </span>
  )
}

/** 每层只取一页直系评论；展开下一层时才请求回复。 */
function CommentList({ contentId, parentId }: { contentId: string; parentId?: string }) {
  const [expanded, setExpanded] = useState(!parentId)
  const [page, setPage] = useState(1)
  const [result, setResult] = useState<Pagination<PublicComment> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    if (!expanded) return
    const controller = new AbortController()
    const query = new URLSearchParams({ contentId, page: String(page), limit: '20' })
    if (parentId) query.set('parentId', parentId)
    setLoading(true)
    setError(false)
    fetch(`${API_BASE}/api/v1/comments/public/page?${query}`, {
      cache: 'no-store',
      signal: controller.signal,
    }).then(async (res) => {
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error('评论加载失败')
      if (!controller.signal.aborted) setResult(json.data)
    }).catch(() => {
      if (!controller.signal.aborted) setError(true)
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [contentId, parentId, page, expanded, retry])

  if (!expanded) {
    return (
      <button type="button" aria-expanded={false} onClick={() => setExpanded(true)} className="mt-2 text-sm text-brand-600">
        查看回复
      </button>
    )
  }

  return (
    <div className={parentId ? 'mt-3 ml-4 border-l border-gray-200 pl-3' : 'mb-8'}>
      {parentId && (
        <button type="button" aria-expanded={true} onClick={() => setExpanded(false)} className="mb-2 text-sm text-brand-600">
          收起回复
        </button>
      )}
      {loading ? (
        <p className="text-sm text-gray-400">加载中…</p>
      ) : error ? (
        <p role="alert" className="text-sm text-red-500">
          评论加载失败
          <button type="button" onClick={() => setRetry((value) => value + 1)} className="ml-2 underline">重试</button>
        </p>
      ) : !result?.data.length ? (
        <p className="text-sm text-gray-400 mb-6">{parentId ? '暂无回复' : '暂无评论，欢迎抢沙发 🛋'}</p>
      ) : (
        <ul className="space-y-4">
          {result.data.map((comment) => (
            <li key={comment.id} className="border-l-2 border-brand-500 bg-gray-50 px-4 py-3 rounded-r">
              <div className="flex items-center justify-between mb-1">
                <span className="font-medium text-gray-800">
                  {displayName(comment)}
                  <IdentityBadge isRegistered={comment.isRegistered} />
                </span>
                <time className="text-xs text-gray-500">{dayjs(comment.createdAt).format('YYYY-MM-DD HH:mm')}</time>
              </div>
              <p className="text-sm text-gray-700 whitespace-pre-wrap">{comment.body}</p>
              <CommentList contentId={contentId} parentId={comment.id} />
            </li>
          ))}
        </ul>
      )}
      {!loading && !error && result && result.meta.totalPages > 1 && (
        <nav aria-label={parentId ? '回复分页' : '评论分页'} className="mt-4 flex items-center gap-3 text-sm">
          <button type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)} className="text-brand-600 disabled:text-gray-400">上一页</button>
          <span>第 {page} / {result.meta.totalPages} 页</span>
          <button type="button" disabled={page >= result.meta.totalPages} onClick={() => setPage((value) => value + 1)} className="text-brand-600 disabled:text-gray-400">下一页</button>
        </nav>
      )}
    </div>
  )
}

export default function CommentSection({ contentId, enabled, needAudit }: Props) {
  const [revision, setRevision] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [hint, setHint] = useState<string>('')
  const [hintKind, setHintKind] = useState<'success' | 'error' | 'info'>('info')
  const [form, setForm] = useState({
    guestName: '',
    guestEmail: '',
    body: '',
  })

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!form.guestName.trim() || !form.guestEmail.trim() || !form.body.trim()) {
      setHintKind('error')
      setHint('请填写昵称、邮箱和评论内容')
      return
    }
    // 简单邮箱校验，避免后端 400 才发现
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.guestEmail.trim())) {
      setHintKind('error')
      setHint('邮箱格式不正确')
      return
    }
    setSubmitting(true)
    setHint('')
    try {
      const res = await fetch(`${API_BASE}/api/v1/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contentId,
          guestName: form.guestName.trim(),
          guestEmail: form.guestEmail.trim(),
          body: form.body.trim(),
        }),
      })
      const json = await res.json()
      if (json.success) {
        // 只清空正文，保留昵称/邮箱方便连续发言
        setForm((f) => ({ ...f, body: '' }))
        // 是否需要审核以后端返回的 status 为准（后端按站点配置 comment_audit 决定）；
        // 页面上的 needAudit 来自缓存的站点配置，后台刚改过开关时可能过期
        const pending = (json.data as PublicComment | undefined)?.status !== 'approved'
        setHintKind('success')
        setHint(
          pending
            ? '✅ 评论已提交，审核通过后将公开显示'
            : '✅ 评论提交成功',
        )
        if (!pending) setRevision((value) => value + 1)
      } else {
        setHintKind('error')
        // 后端校验消息可能是数组，也可能是单条字符串；统一兜底
        const msg =
          (Array.isArray(json.errors) && json.errors[0]) ||
          json.message ||
          '提交失败，请稍后重试'
        setHint(msg)
      }
    } catch (err: any) {
      setHintKind('error')
      setHint(err?.message || '网络异常，请稍后重试')
    } finally {
      setSubmitting(false)
    }
  }

  if (!enabled) {
    return (
      <section className="mt-10 bg-white rounded-lg p-6 text-center text-gray-400">
        评论功能已关闭
      </section>
    )
  }

  return (
    <section className="mt-10 bg-white rounded-lg p-6 shadow-sm">
      <h2 className="text-xl font-semibold mb-4 text-gray-800">
        💬 评论
      </h2>

      <CommentList key={`${contentId}:${revision}`} contentId={contentId} />

      {/* 评论表单 */}
      <form onSubmit={handleSubmit} className="space-y-3">
        <h3 className="font-medium text-gray-800">发表评论</h3>
        <div className="grid sm:grid-cols-2 gap-3">
          <input
            type="text"
            placeholder="昵称 *"
            maxLength={50}
            value={form.guestName}
            onChange={(e) => setForm({ ...form, guestName: e.target.value })}
            className="px-3 py-2 border border-gray-200 rounded text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <input
            type="email"
            placeholder="邮箱 *（不会公开）"
            maxLength={100}
            value={form.guestEmail}
            onChange={(e) => setForm({ ...form, guestEmail: e.target.value })}
            className="px-3 py-2 border border-gray-200 rounded text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        <textarea
          placeholder="说点什么吧... *"
          rows={4}
          maxLength={1000}
          value={form.body}
          onChange={(e) => setForm({ ...form, body: e.target.value })}
          className="w-full px-3 py-2 border border-gray-200 rounded text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <div className="flex items-center justify-between">
          {hint ? (
            <span
              className={`text-sm ${
                hintKind === 'success'
                  ? 'text-green-600'
                  : hintKind === 'error'
                    ? 'text-red-500'
                    : 'text-gray-500'
              }`}
            >
              {hint}
            </span>
          ) : (
            <span className="text-xs text-gray-400">
              {needAudit && '评论将在审核通过后展示'}
            </span>
          )}
          <button
            type="submit"
            disabled={submitting}
            className="px-5 py-2 bg-brand-600 text-white text-sm rounded hover:bg-brand-700 disabled:opacity-50"
          >
            {submitting ? '提交中…' : '提交评论'}
          </button>
        </div>
      </form>
    </section>
  )
}
