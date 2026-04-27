'use client'

import { useEffect, useState, FormEvent } from 'react'
import dayjs from 'dayjs'
import type { Comment } from '@/lib/types'

interface Props {
  contentId: string
  enabled: boolean
  needAudit: boolean
}

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:3001'

/** 显示用昵称：游客名 → 注册用户（暂未带 user 关系，先回退到"用户"） → 匿名 */
function displayName(c: Pick<Comment, 'guestName' | 'userId'>): string {
  if (c.guestName) return c.guestName
  if (c.userId) return '注册用户'
  return '匿名'
}

export default function CommentSection({ contentId, enabled, needAudit }: Props) {
  const [comments, setComments] = useState<Comment[]>([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [hint, setHint] = useState<string>('')
  const [hintKind, setHintKind] = useState<'success' | 'error' | 'info'>('info')
  const [form, setForm] = useState({
    guestName: '',
    guestEmail: '',
    body: '',
  })

  async function fetchComments() {
    setLoading(true)
    try {
      const res = await fetch(
        `${API_BASE}/api/v1/comments/public?contentId=${contentId}`,
        { cache: 'no-store' },
      )
      const json = await res.json()
      setComments(json?.data ?? [])
    } catch {
      setComments([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchComments()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentId])

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
        setHintKind('success')
        setHint(
          needAudit
            ? '✅ 评论已提交，审核通过后将公开显示'
            : '✅ 评论提交成功',
        )
        if (!needAudit) await fetchComments()
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
        💬 评论 ({comments.length})
      </h2>

      {/* 评论列表 */}
      {loading ? (
        <p className="text-sm text-gray-400">加载中…</p>
      ) : comments.length === 0 ? (
        <p className="text-sm text-gray-400 mb-6">暂无评论，欢迎抢沙发 🛋</p>
      ) : (
        <ul className="space-y-4 mb-8">
          {comments.map((c) => (
            <li
              key={c.id}
              className="border-l-2 border-brand-500 bg-gray-50 px-4 py-3 rounded-r"
            >
              <div className="flex items-center justify-between mb-1">
                <span className="font-medium text-gray-800">{displayName(c)}</span>
                <time className="text-xs text-gray-500">
                  {dayjs(c.createdAt).format('YYYY-MM-DD HH:mm')}
                </time>
              </div>
              <p className="text-sm text-gray-700 whitespace-pre-wrap">
                {c.body}
              </p>
              {c.children && c.children.length > 0 && (
                <ul className="mt-3 ml-4 space-y-2 border-l border-gray-200 pl-3">
                  {c.children.map((child) => (
                    <li key={child.id} className="text-sm">
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="font-medium text-gray-700">
                          ↪ {displayName(child)}
                        </span>
                        <time className="text-xs text-gray-400">
                          {dayjs(child.createdAt).format('MM-DD HH:mm')}
                        </time>
                      </div>
                      <p className="text-gray-600 whitespace-pre-wrap">
                        {child.body}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}

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
