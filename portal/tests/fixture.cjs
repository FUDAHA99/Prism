const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const date = '2026-01-01T00:00:00.000Z'
const category = { id: uuid(1), name: '回归分类', slug: 'regression-category' }
const tag = { id: uuid(2), name: '回归标签', slug: 'regression-tag' }
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64')
const movie = {
  id: uuid(10), slug: 'regression-movie', title: '回归影视', movieType: 'tv',
  score: 8, isFinished: true, totalEpisodes: 3, currentEpisode: 3,
  isFeatured: true, isVip: false, viewCount: 12, year: 2026, region: '大陆',
  createdAt: date, updatedAt: date, posterUrl: '/uploads/poster.png', intro: '本地影视测试数据',
  sources: [0, 1].map((source) => ({
    id: uuid(20 + source), movieId: uuid(10), name: `线路${source + 1}`, kind: 'play', sortOrder: source,
    episodes: [0, 1, 2].map((episode) => ({
      id: uuid(30 + source * 3 + episode), sourceId: uuid(20 + source), title: `第${episode + 1}集`,
      episodeNumber: episode + 1, sortOrder: episode, url: `/uploads/source-${source}-episode-${episode}.webm`,
    })),
  })),
}
const article = {
  id: uuid(40), title: '回归文章', slug: 'regression-article', contentType: 'article',
  body: '# 门户正文\n\n**正常粗体**\n\n| 列名 |\n| --- |\n| 表格正文 |\n\n<script>window.__portalXss=true</script>',
  createdAt: date, updatedAt: date, publishedAt: date, viewCount: 5,
  category, tags: [tag], author: { username: 'fixture', nickname: '回归作者' },
}
const novel = {
  id: uuid(50), title: '回归小说', slug: 'regression-novel', author: '回归作者',
  wordCount: 20, chapterCount: 2, serialStatus: 'finished', score: 8, viewCount: 1,
  favoriteCount: 0, isFeatured: false, isVip: false, createdAt: date,
}
const comic = { ...novel, id: uuid(60), title: '回归漫画', slug: 'regression-comic' }
const novelChapters = [0, 1].map((i) => ({
  id: uuid(51 + i), novelId: novel.id, chapterNumber: i + 1, title: `小说第${i + 1}章`,
  wordCount: 10, isVip: false, viewCount: 1, content: `第${i + 1}章正文。\n第二段正文。`,
}))
const comicChapters = [0, 1].map((i) => ({
  id: uuid(61 + i), comicId: comic.id, chapterNumber: i + 1, title: `漫画第${i + 1}话`,
  pageCount: 1, isVip: false, viewCount: 1, pageUrls: ['/uploads/poster.png'],
}))

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return `http://127.0.0.1:${server.address().port}`
}

async function createFixture() {
  const requests = []
  const progress = new Map()
  const comments = []
  const commentState = { status: 'pending' }
  const listItems = new Map(Object.entries({ '/movies': movie, '/novels': novel, '/comics': comic, '/contents': article }))
  // Unlinked slugs avoid browser prefetch warming the cache before the test does.
  const cacheStates = new Map([
    ['/contents/slug/cache-article', { status: 200, data: { ...article, id: uuid(41), slug: 'cache-article', title: '缓存文章' } }],
    ['/movies/slug/cache-movie', { status: 200, data: { ...movie, id: uuid(71), slug: 'cache-movie', title: '缓存影视' } }],
    ['/movies/slug/cache-outage', { status: 200, data: { ...movie, id: uuid(72), slug: 'cache-outage', title: '暂时故障影视' } }],
    ['/contents/slug/cache-cold-error', { status: 503, data: { ...article, id: uuid(42), slug: 'cache-cold-error', title: '故障恢复文章' } }],
  ])
  const media = fs.readFileSync(path.join(__dirname, 'sample.webm'))
  const envelope = (res, data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ success: status < 400, data, timestamp: date }))
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const origin = req.headers.origin
    if (origin && new URL(origin).hostname === '127.0.0.1') res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
    let body = ''
    for await (const chunk of req) body += chunk
    const entry = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), authorized: Boolean(req.headers.authorization) }
    if (req.headers['x-portal-cache-version']) entry.cacheVersion = req.headers['x-portal-cache-version']
    if (body) entry.body = JSON.parse(body)
    requests.push(entry)
    res.once('finish', () => { entry.status = res.statusCode; entry.completedAt = Date.now() })
    if (url.pathname.startsWith('/uploads/')) {
      if (url.pathname === '/uploads/broken.webm') { res.writeHead(404); res.end(); return }
      const bytes = url.pathname.endsWith('.webm') ? media : image
      res.setHeader('Content-Type', url.pathname.endsWith('.webm') ? 'video/webm' : 'image/png')
      res.setHeader('Accept-Ranges', 'bytes')
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '')
      const start = range ? Number(range[1]) : 0
      const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1
      if (start > end) { res.writeHead(416); res.end(); return }
      if (range) res.setHeader('Content-Range', `bytes ${start}-${end}/${bytes.length}`)
      res.setHeader('Content-Length', end - start + 1)
      res.writeHead(range ? 206 : 200)
      res.end(req.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1))
      return
    }
    const route = url.pathname.replace(/^\/api\/v1/, '')
    if (route === '/watch-history' || route === '/watch-history/report') {
      if (entry.authorized) { envelope(res, null, 401); return }
      if (req.method === 'POST') {
        progress.set(entry.body.guestId, entry.body)
        res.writeHead(204); res.end(); return
      }
      const record = progress.get(url.searchParams.get('guestId'))
      envelope(res, record?.contentId === url.searchParams.get('contentId') && record?.contentType === url.searchParams.get('contentType') ? record : null); return
    }
    if (route === '/site-settings/public') { envelope(res, [{ key: 'site_name', value: 'Portal Regression' }, { key: 'site_favicon', value: '/uploads/poster.png' }, { key: 'posts_per_page', value: '2' }, { key: 'enable_comment', value: 'true' }, { key: 'comment_audit', value: 'true' }]); return }
    if (route === '/categories') { envelope(res, [category]); return }
    if (route === '/tags') { envelope(res, [tag]); return }
    if (route === '/comments/public') { envelope(res, comments.filter(comment => comment.contentId === url.searchParams.get('contentId') && comment.status === 'approved')); return }
    if (route === '/comments' && req.method === 'POST') {
      const comment = { id: uuid(100 + comments.length), contentId: entry.body.contentId, guestName: entry.body.guestName, body: entry.body.body, isRegistered: false, status: commentState.status, createdAt: date, children: [] }
      comments.push(comment)
      envelope(res, comment, 201); return
    }
    if (cacheStates.has(route)) {
      const state = cacheStates.get(route)
      envelope(res, state.status === 200 ? state.data : null, state.status); return
    }
    if (listItems.has(route)) {
      const page = Number(url.searchParams.get('page') || 1)
      const item = listItems.get(route)
      const data = page === 1 ? [item] : [{ ...item, id: uuid(90), slug: `${item.slug}-page-${page}`, title: `${item.title}第${page}页` }]
      envelope(res, { data, meta: { page, limit: Number(url.searchParams.get('limit') || 24), total: 48, totalPages: 2 } }); return
    }
    const details = { [`/movies/slug/${movie.slug}`]: movie, [`/contents/slug/${article.slug}`]: article, [`/novels/slug/${novel.slug}`]: novel, [`/comics/slug/${comic.slug}`]: comic }
    if (route === '/movies/slug/broken-movie') {
      envelope(res, { ...movie, slug: 'broken-movie', title: '失败影视', sources: [{ ...movie.sources[0], episodes: [{ ...movie.sources[0].episodes[0], url: `${origin || server.origin}/uploads/broken.webm` }] }] }); return
    }
    if (details[route]) { envelope(res, details[route]); return }
    if (route === `/novels/${novel.id}/chapters`) { envelope(res, { data: novelChapters, meta: { total: 2, page: 1, limit: 100, totalPages: 1 } }); return }
    if (route === `/comics/${comic.id}/chapters`) { envelope(res, comicChapters); return }
    const chapter = [...novelChapters, ...comicChapters].find((ch) => route === `/${ch.novelId ? 'novels' : 'comics'}/chapters/${ch.id}`)
    if (chapter) { envelope(res, chapter); return }
    envelope(res, null, 404)
  })
  const origin = await listen(server)
  server.origin = origin
  return { origin, server, requests, progress, commentState, cacheStates, listItems }
}

module.exports = { createFixture, listen, movie, novel, comic, article, novelChapters, comicChapters }
