import { timingSafeEqual } from 'node:crypto'
import { revalidateTag } from 'next/cache'
import { NextResponse } from 'next/server'
import { PORTAL_CACHE_TAGS, type PortalCacheTag } from '@/lib/cache-tags'

const MAX_BODY_BYTES = 1024
const SECRET = /^[a-fA-F0-9]{64}$/
const reply = (status: number, body: object) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })

export function GET() {
  return reply(405, { error: 'Method not allowed' })
}

export async function POST(request: Request) {
  // Read only at runtime. An unset or malformed secret disables this endpoint.
  const secret = process.env.PORTAL_REVALIDATE_SECRET
  if (!secret || !SECRET.test(secret)) return reply(503, { error: 'Revalidation unavailable' })
  const supplied = /^Bearer ([a-fA-F0-9]{64})$/.exec(request.headers.get('authorization') ?? '')?.[1]
  if (!supplied || !timingSafeEqual(Buffer.from(supplied), Buffer.from(secret))) {
    return reply(401, { error: 'Unauthorized' })
  }

  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) {
    return reply(413, { error: 'Request too large' })
  }
  let body: unknown
  try {
    const reader = request.body?.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    if (reader) {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_BODY_BYTES) {
          await reader.cancel()
          return reply(413, { error: 'Request too large' })
        }
        chunks.push(value)
      }
    }
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return reply(400, { error: 'Invalid JSON' })
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).length !== 1 || !Object.hasOwn(body, 'tags')) {
    return reply(400, { error: 'Expected tags only' })
  }
  const { tags } = body as { tags: unknown }
  if (!Array.isArray(tags) || tags.length < 1 || tags.length > PORTAL_CACHE_TAGS.length ||
      !tags.every((tag): tag is PortalCacheTag => typeof tag === 'string' && PORTAL_CACHE_TAGS.includes(tag as PortalCacheTag))) {
    return reply(400, { error: 'Invalid tags' })
  }
  const unique = [...new Set(tags)]
  for (const tag of unique) revalidateTag(tag, { expire: 0 })
  return reply(200, { revalidated: unique })
}
