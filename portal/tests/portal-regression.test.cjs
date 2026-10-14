// Real Next HTTP + browser regression. All mutable output stays outside the repository.
// The tiny, silent VP8 fixture was generated with ffmpeg: 64x36, 1 fps, 70 seconds.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawn, execFileSync } = require('node:child_process')
const { chromium } = require('playwright')
const { createFixture, listen, movie, article, novelChapters, comicChapters } = require('./fixture.cjs')

const source = path.resolve(__dirname, '..')
const repository = path.dirname(source)
const outputParent = path.resolve(process.env.PORTAL_TEST_OUTPUT_DIR || os.tmpdir())
const relative = path.relative(repository, outputParent)
assert(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), 'Test output must be outside the repository')
fs.mkdirSync(outputParent, { recursive: true })
const output = fs.mkdtempSync(path.join(outputParent, 'portal-regression-'))
const children = []
const servers = []
const report = { node: process.version, output, runner: 'Playwright Chromium via npm test', cases: [], limitations: ['Desktop Chromium only; no Safari/native HLS, DRM or remote CDN coverage.', 'Native WebM decode and seek are real. Progress reporting uses the real media timeupdate and React navigation cleanup.', 'Known pre-existing behavior: novel/comic pagination loses q; from-start link retains stored progress.'] }
let browser
let fixture
let cleanupPromise
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

function cleanup() {
  if (cleanupPromise) return cleanupPromise
  cleanupPromise = (async () => {
    report.fixtureRequests = fixture?.requests
    report.cleanupErrors = []
    let closeTimer
    try {
      await Promise.race([browser?.close(), new Promise((_, reject) => { closeTimer = setTimeout(() => reject(new Error('Browser close timed out')), 5000) })])
    } catch (error) { report.cleanupErrors.push(String(error)) }
    finally { clearTimeout(closeTimer) }
    for (const child of children.reverse()) {
      if (child.exitCode !== null) continue
      try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        else {
          child.kill('SIGTERM')
          await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(3000)])
          if (child.exitCode === null) child.kill('SIGKILL')
        }
      } catch (error) { if (child.exitCode === null) report.cleanupErrors.push(String(error)) }
    }
    for (const server of servers.reverse()) {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
    save()
  })()
  return cleanupPromise
}

function isolatedSource(name) {
  const target = path.join(output, name)
  fs.cpSync(source, target, {
    recursive: true,
    filter: file => {
      const name = path.basename(file)
      return !name.startsWith('.env') && !name.endsWith('.log') && !['node_modules', '.next', 'tests', '.git', 'tsconfig.tsbuildinfo'].includes(name)
    },
  })
  fs.symlinkSync(path.join(source, 'node_modules'), path.join(target, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  return target
}

function nextProcess(target, args, mode, name) {
  const env = {}
  for (const key of ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  Object.assign(env, { NODE_ENV: mode, NODE_TLS_REJECT_UNAUTHORIZED: '1', NEXT_TELEMETRY_DISABLED: '1', BACKEND_INTERNAL_URL: fixture.origin, NEXT_PUBLIC_API_BASE: fixture.origin })
  const log = fs.openSync(path.join(output, `${name}.log`), 'w')
  const child = spawn(process.execPath, [path.join(source, 'node_modules/next/dist/bin/next'), ...args], { cwd: target, env, windowsHide: true, stdio: ['ignore', log, log] })
  fs.closeSync(log)
  children.push(child)
  return child
}

async function freePort() {
  const server = http.createServer()
  const origin = await listen(server)
  await new Promise(resolve => server.close(resolve))
  return Number(new URL(origin).port)
}

async function startNext(target, mode) {
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const child = nextProcess(target, [...(mode === 'development' ? ['dev', '--webpack'] : ['start']), '-H', '127.0.0.1', '-p', String(port)], mode, mode)
  for (let tries = 0; tries < 120; tries++) {
    if (child.exitCode !== null) throw new Error(`Next exited ${child.exitCode}; see ${mode}.log`)
    try { if ((await fetch(origin + '/about', { signal: AbortSignal.timeout(1000) })).ok) return origin } catch {}
    await pause(500)
  }
  throw new Error(`Next readiness timed out; see ${mode}.log`)
}

async function productionProxy(nextOrigin) {
  const server = http.createServer((req, res) => {
    const upstream = new URL(req.url, /^\/(api\/v1|uploads)\//.test(req.url) ? fixture.origin : nextOrigin)
    const proxied = http.request(upstream, { method: req.method, headers: { ...req.headers, host: upstream.host } }, response => {
      res.writeHead(response.statusCode, response.headers)
      response.pipe(res)
    })
    proxied.on('error', error => { res.writeHead(502); res.end(error.message) })
    req.pipe(proxied)
  })
  servers.push(server)
  return listen(server)
}

async function scenario(name, origin, body, allowedHttp = () => false) {
  const entry = { name, pageErrors: [], consoleErrors: [], httpErrors: [], requestFailures: [], externalRequests: [], screenshots: [] }
  report.cases.push(entry)
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 }, serviceWorkers: 'block' })
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    if (/^https?:$/.test(url.protocol) && ![origin, fixture.origin].includes(url.origin)) {
      entry.externalRequests.push(url.href)
      return route.abort('blockedbyclient')
    }
    return route.continue()
  })
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => entry.pageErrors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') entry.consoleErrors.push({ text: message.text(), url: message.location().url }) })
  page.on('response', response => { if (response.status() >= 400) entry.httpErrors.push({ url: response.url(), status: response.status() }) })
  page.on('requestfailed', request => entry.requestFailures.push({ url: request.url(), error: request.failure()?.errorText }))
  const screenshot = async label => {
    const file = path.join(output, `${name}-${label}.png`)
    await page.screenshot({ path: file, fullPage: true })
    entry.screenshots.push(file)
  }
  try {
    await body(page, context, entry, screenshot)
    entry.url = page.url()
    await page.waitForFunction(() => document.title.trim().length > 0)
    entry.title = await page.title()
    assert(entry.url.startsWith(origin))
    assert(entry.title.length > 0)
    assert((await page.locator('main').innerText()).trim().length > 0)
    // Next's healthy development indicator shares this host with the error overlay.
    assert.equal(await page.locator('nextjs-portal [data-nextjs-dialog], nextjs-portal [data-nextjs-error-overlay-nav]').count(), 0)
    assert.deepEqual(entry.pageErrors, [])
    assert.deepEqual(entry.externalRequests, [])
    assert.deepEqual(entry.httpErrors.filter(item => !allowedHttp(item)), [])
    const unexpectedConsole = entry.consoleErrors.filter(item => !(item.text.startsWith('Failed to load resource:') && entry.httpErrors.some(http => http.url === item.url && allowedHttp(http))))
    assert.deepEqual(unexpectedConsole, [])
    assert.deepEqual(entry.requestFailures.filter(item => !item.error?.includes('ERR_ABORTED')), [])
    entry.passed = true
  } catch (error) {
    entry.failure = error.stack
    await screenshot('failure').catch(() => {})
    throw error
  } finally {
    await context.close()
    save()
  }
}

async function goto(page, origin, route, heading) {
  await page.goto(origin + route)
  await page.getByRole('heading', { name: heading, exact: true }).waitFor()
}

async function title(page, expected) {
  // Next can stream metadata after the page body has become visible.
  await page.waitForFunction(expected => document.title === expected + ' | Portal Regression', expected)
}

async function playback(page) {
  const video = page.locator('video')
  await video.waitFor()
  await video.evaluate(async element => {
    element.muted = true
    await Promise.race([element.play(), new Promise((_, reject) => setTimeout(() => reject(new Error('Media play timed out')), 10000))])
  })
  await page.waitForFunction(() => { const video = document.querySelector('video'); return video.readyState >= 3 && video.duration >= 60 && video.currentTime > 0 })
  return video
}

async function resumeScenario(origin, name) {
  return scenario(name, origin, async (page, context, entry, screenshot) => {
    const guestId = '00000000-0000-4000-8000-000000000099'
    const srcIdx = 1
    const epIdx = 2
    const episodeId = movie.sources[srcIdx].episodes[epIdx].id
    fixture.progress.set(guestId, { contentId: movie.id, contentType: 'movie', episodeId, srcIdx, epIdx, progressSec: 45, durationSec: 70 })
    const start = fixture.requests.length
    await context.addInitScript(({ guestId }) => {
      localStorage.setItem('cms_guest_id', guestId)
      localStorage.setItem('access_token', 'expired-regression-token')
    }, { guestId })
    await goto(page, origin, '/movies/regression-movie', '回归影视')
    const resume = page.getByRole('link', { name: /继续看/ })
    await resume.waitFor()
    assert((await resume.innerText()).includes('0:45'))
    assert.equal(await resume.getAttribute('href'), '/movies/regression-movie/play/1/2')
    await resume.click()
    await page.getByRole('heading', { name: /^回归影视\s*第3集$/ }).waitFor()
    const video = await playback(page)
    await page.waitForFunction(() => document.querySelector('video').currentTime >= 45)
    assert.equal(await page.evaluate(key => localStorage.getItem(key), `resume_${movie.id}_${srcIdx}_${epIdx}`), '45')
    await page.getByText('已从 0:45 继续播放', { exact: true }).waitFor()
    await screenshot('resume')
    // Let decoded playback advance beyond the stored value, then verify the new value round-trips.
    await page.waitForFunction(() => document.querySelector('video').currentTime >= 47)
    await video.evaluate(element => element.pause())
    const updatedProgress = await video.evaluate(element => Math.round(element.currentTime))
    const posted = page.waitForResponse(response => {
      const request = response.request()
      return response.url().endsWith('/api/v1/watch-history/report') && response.status() === 204 && request.method() === 'POST' && !request.headers().authorization && request.postDataJSON().episodeId === episodeId
    })
    await page.getByRole('link', { name: '返回详情', exact: true }).click()
    const postedResponse = await posted
    await resume.waitFor()
    const calls = fixture.requests.slice(start).filter(item => item.path.startsWith('/api/v1/watch-history'))
    const gets = calls.filter(item => item.method === 'GET')
    const posts = calls.filter(item => item.method === 'POST')
    for (const request of gets) assert.deepEqual(request.query, { contentType: 'movie', contentId: movie.id, guestId })
    assert(gets.some(item => item.authorized) && gets.some(item => !item.authorized))
    assert(posts.some(item => item.authorized) && posts.some(item => !item.authorized))
    const body = postedResponse.request().postDataJSON()
    assert.equal(body.guestId, guestId)
    assert.equal(body.contentId, movie.id)
    assert.equal(body.episodeId, episodeId)
    assert.equal(body.contentType, 'movie')
    assert.equal(body.srcIdx, srcIdx)
    assert.equal(body.epIdx, epIdx)
    assert(Math.abs(body.progressSec - updatedProgress) <= 1)
    assert(body.progressSec > 45 && body.durationSec >= 60)
    await page.getByRole('link', { name: new RegExp(`继续看.*0:${String(body.progressSec).padStart(2, '0')}`) }).waitFor()
    await title(page, movie.title)
    entry.resume = { calls, duration: await video.count() ? await video.evaluate(element => element.duration) : body.durationSec, reportStatus: 204 }
  }, item => item.status === 401 && item.url.includes('/api/v1/watch-history'))
}

test('portal HTTP and browser regression', { timeout: 360000 }, async t => {
  // Test timeout does not cancel an awaited build/browser promise; the hook still owns cleanup.
  t.after(cleanup)
  console.log(`Portal regression evidence: ${output}`)
  try {
    fixture = await createFixture()
    servers.push(fixture.server)
    browser = await chromium.launch({ headless: true, ...(process.env.PORTAL_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.PORTAL_TEST_BROWSER_EXECUTABLE } : {}) })
    const production = isolatedSource('production')
    const build = nextProcess(production, ['build', '--webpack'], 'production', 'build')
    const buildCode = await new Promise((resolve, reject) => { build.once('error', reject); build.once('exit', resolve) })
    assert.equal(buildCode, 0, `Next build failed; see ${path.join(output, 'build.log')}`)
    report.productionBuild = 'passed (includes Next TypeScript validation)'
    const direct = await startNext(production, 'production')
    const origin = await productionProxy(direct)
    report.origins = { fixture: fixture.origin, production: origin, direct }
    assert.equal((await fetch(direct + '/api/v1/watch-history')).status, 404, 'Production Next must not proxy the API')
    await t.test('home, navigation and paginated public lists', async () => {
      await scenario('pages', origin, async (page, _context, entry, screenshot) => {
        await goto(page, origin, '/', '回归文章')
        for (const title of ['🎬 影视推荐', '📚 小说推荐', '🖼 漫画推荐']) await page.getByRole('heading', { name: title, exact: true }).waitFor()
        assert((await page.title()).includes('Portal Regression'))
        await screenshot('home')
        await page.locator('header').getByRole('link', { name: '影视', exact: true }).click()
        await page.getByRole('heading', { name: '影视', exact: true }).waitFor()
        for (const [route, heading, secondTitle] of [
          ['/movies?type=tv&region=%E5%A4%A7%E9%99%86&year=2026&q=fixture', '影视', '回归影视第2页'],
          ['/novels', '小说', '回归小说第2页'], ['/comics', '漫画', '回归漫画第2页'],
          ['/articles', '全部文章', '回归文章第2页'],
          ['/category/regression-category', '回归分类', '回归文章第2页'], ['/tag/regression-tag', '# 回归标签', '回归文章第2页'],
        ]) {
          await goto(page, origin, route, heading)
          await title(page, route.startsWith('/category') ? '分类：回归分类' : route.startsWith('/tag') ? '标签：回归标签' : heading)
          await page.getByRole('link', { name: '下一页', exact: true }).click()
          await page.getByText(secondTitle, { exact: true }).waitFor()
          assert.equal(new URL(page.url()).searchParams.get('page'), '2')
          if (route.startsWith('/movies')) {
            for (const [key, value] of Object.entries({ type: 'tv', region: '大陆', year: '2026', q: 'fixture' })) assert.equal(new URL(page.url()).searchParams.get(key), value)
          }
          await page.getByRole('link', { name: '上一页', exact: true }).waitFor()
        }
        await goto(page, origin, '/movies?page=not-a-page', '影视')
        await page.getByText('回归影视', { exact: true }).waitFor()
        const moviesPage2 = fixture.requests.find(item => item.path === '/api/v1/movies' && item.query.page === '2')
        assert.deepEqual(moviesPage2.query, { status: 'published', limit: '24', page: '2', movieType: 'tv', region: '大陆', year: '2026', search: 'fixture' })
        assert(fixture.requests.some(item => item.path === '/api/v1/contents' && item.query.page === '2' && item.query.limit === '2' && item.query.categoryId))
        assert(fixture.requests.some(item => item.path === '/api/v1/contents' && item.query.page === '2' && item.query.tagId))
        entry.pagination = 'Six lists, movie filters and invalid-page fallback passed'
      })
    })
    await t.test('article, novel and comic readers', async () => {
      await scenario('readers', origin, async (page, _context, entry, screenshot) => {
        await goto(page, origin, '/articles/regression-article', '回归文章')
        await title(page, '回归文章')
        await page.getByRole('heading', { name: '门户正文', exact: true }).waitFor()
        assert.equal(await page.locator('.prose table td').innerText(), '表格正文')
        assert.equal(await page.locator('.prose script').count(), 0)
        assert.equal(await page.evaluate(() => Boolean(window.__portalXss)), false)
        await screenshot('article')
        await goto(page, origin, '/novels/regression-novel', '回归小说')
        await title(page, '回归小说')
        await page.getByRole('link', { name: '开始阅读', exact: true }).click()
        await page.getByRole('heading', { name: novelChapters[0].title, exact: true }).waitFor()
        assert((await page.locator('.novel-reader').innerText()).includes('第1章正文'))
        await page.getByRole('link', { name: '下一章 →', exact: true }).click()
        await page.getByRole('heading', { name: novelChapters[1].title, exact: true }).waitFor()
        await title(page, novelChapters[1].title)
        await page.getByRole('link', { name: '← 上一章', exact: true }).waitFor()
        await goto(page, origin, '/comics/regression-comic', '回归漫画')
        await title(page, '回归漫画')
        await page.getByRole('link', { name: '开始阅读', exact: true }).click()
        await page.getByRole('heading', { name: comicChapters[0].title, exact: true }).waitFor()
        await page.locator('.comic-page-wrap img').evaluate(async image => { await image.decode(); if (!image.naturalWidth) throw new Error('Comic image did not decode') })
        await page.getByRole('link', { name: '下一话 →', exact: true }).click()
        await page.getByRole('heading', { name: comicChapters[1].title, exact: true }).waitFor()
        await title(page, comicChapters[1].title)
        await screenshot('comic')
        entry.readers = 'Markdown, chapter navigation and decoded image passed'
      })
    })
    await t.test('native playback, episodes, sources and failure state', async () => {
      await scenario('playback', origin, async (page, _context, entry, screenshot) => {
        await goto(page, origin, '/movies/regression-movie', '回归影视')
        await title(page, '回归影视')
        await page.getByRole('link', { name: '▶ 立即观看', exact: true }).click()
        await page.getByRole('heading', { name: /^回归影视\s*第1集$/ }).waitFor()
        const video = await playback(page)
        entry.nativeVideo = await video.evaluate(element => ({ duration: element.duration, width: element.videoWidth, height: element.videoHeight }))
        assert.equal(entry.nativeVideo.width, 64)
        await page.getByRole('link', { name: '下一集 →', exact: true }).click()
        await page.getByRole('heading', { name: /^回归影视\s*第2集$/ }).waitFor()
        await title(page, '回归影视 - 第2集 - 在线播放')
        await playback(page)
        assert.equal(await video.evaluate(element => new URL(element.currentSrc).pathname), '/uploads/source-0-episode-1.webm')
        await page.getByRole('link', { name: '← 上一集', exact: true }).waitFor()
        await page.getByRole('link', { name: '线路2', exact: true }).click()
        await page.getByRole('heading', { name: /^回归影视\s*第1集$/ }).waitFor()
        assert(page.url().endsWith('/play/1/0'))
        await playback(page)
        assert.equal(await video.evaluate(element => new URL(element.currentSrc).pathname), '/uploads/source-1-episode-0.webm')
        await screenshot('video')
        await goto(page, origin, '/movies/broken-movie/play/0/0', /^失败影视\s*第1集$/)
        await page.getByText('⚠️ 无法播放', { exact: true }).waitFor()
        const external = page.getByRole('link', { name: '尝试用外部播放器打开', exact: true })
        assert.equal(await external.getAttribute('href'), fixture.origin + '/uploads/broken.webm')
        await screenshot('failure-state')
      }, item => item.status === 404 && item.url.endsWith('/uploads/broken.webm'))
    })
    await t.test('missing details and invalid playback route', async () => {
      await scenario('not-found', origin, async (page, _context, entry) => {
        for (const route of ['/articles/missing', '/movies/missing', '/novels/missing', '/comics/missing', '/movies/regression-movie/play/99/0']) {
          await goto(page, origin, route, '404')
          await page.getByText('页面没有找到', { exact: true }).waitFor()
        }
        entry.missing = 'Four missing details and out-of-range source show 404'
      }, item => item.status === 404)
    })
    await t.test('production resume read, seek, report and expired-token retry', () => resumeScenario(origin, 'production-resume'))
    await t.test('guest comments follow the response moderation status', async () => {
      await scenario('comments', origin, async (page, _context, entry, screenshot) => {
        const start = fixture.requests.length
        const posts = () => fixture.requests.slice(start).filter(item => item.path === '/api/v1/comments' && item.method === 'POST')
        await goto(page, origin, '/articles/regression-article', '回归文章')
        await page.getByText('暂无评论，欢迎抢沙发 🛋', { exact: true }).waitFor()
        await page.getByText('评论将在审核通过后展示', { exact: true }).waitFor()
        await page.getByRole('button', { name: '提交评论', exact: true }).click()
        await page.getByText('请填写昵称、邮箱和评论内容', { exact: true }).waitFor()
        assert.equal(posts().length, 0)
        const name = page.getByPlaceholder('昵称 *', { exact: true })
        const email = page.getByPlaceholder('邮箱 *（不会公开）', { exact: true })
        const body = page.getByPlaceholder('说点什么吧... *', { exact: true })
        await name.fill(' 回归游客 ')
        await email.fill('reader@example.test')
        await body.fill(' 等待审核的评论 ')
        const pendingPost = page.waitForResponse(response => response.url().endsWith('/api/v1/comments') && response.request().method() === 'POST')
        await page.getByRole('button', { name: '提交评论', exact: true }).click()
        await page.getByText('✅ 评论已提交，审核通过后将公开显示', { exact: true }).waitFor()
        assert.equal((await pendingPost).status(), 201)
        assert.equal(await body.inputValue(), '')
        assert.equal(await name.inputValue(), ' 回归游客 ')
        assert.equal(await email.inputValue(), 'reader@example.test')
        assert.equal(await page.getByText('等待审核的评论', { exact: true }).count(), 0)
        assert.deepEqual(posts()[0].body, { contentId: article.id, guestName: '回归游客', guestEmail: 'reader@example.test', body: '等待审核的评论' })
        // Cached site settings still require review; the POST response decides visibility.
        fixture.commentState.status = 'approved'
        await body.fill('直接公开的评论')
        const refreshed = page.waitForResponse(response => response.url().includes('/api/v1/comments/public?') && response.request().method() === 'GET' && response.status() === 200)
        const approvedPost = page.waitForResponse(response => response.url().endsWith('/api/v1/comments') && response.request().method() === 'POST')
        await page.getByRole('button', { name: '提交评论', exact: true }).click()
        await page.getByText('✅ 评论提交成功', { exact: true }).waitFor()
        await refreshed
        assert.equal((await approvedPost).status(), 201)
        await page.getByText('直接公开的评论', { exact: true }).waitFor()
        await page.getByRole('heading', { name: '💬 评论 (1)', exact: true }).waitFor()
        assert.equal(await body.inputValue(), '')
        assert.equal(posts().length, 2)
        assert.deepEqual(posts()[1].body, { contentId: article.id, guestName: '回归游客', guestEmail: 'reader@example.test', body: '直接公开的评论' })
        const gets = fixture.requests.slice(start).filter(item => item.path === '/api/v1/comments/public')
        assert(gets.length >= 2)
        for (const get of gets) assert.deepEqual(get.query, { contentId: article.id })
        entry.comments = { postStatuses: [201, 201], publicCount: 1, posts: posts(), publicReads: gets.length }
        await screenshot('approved')
      })
    })
    await t.test('production cache expiry, withdrawal and transient failure', async () => {
      await scenario('cache', origin, async (page, _context, _entry, screenshot) => {
        const observations = report.cache = { next: require('next/package.json').version, details: [], listRequestCounts: [] }
        const count = apiPath => fixture.requests.filter(item => item.path === '/api/v1' + apiPath).length
        const render = async route => {
          const response = await page.goto(origin + route)
          await page.locator('main h1').first().waitFor()
          return { status: response.status(), html: await page.locator('main').innerText(), missing: await page.getByRole('heading', { name: '404', exact: true }).count() === 1 }
        }
        const missing = response => response.missing && response.html.includes('页面没有找到')
        const cases = [
          ['/articles/cache-article', '/contents/slug/cache-article', 404, 30],
          ['/movies/cache-movie', '/movies/slug/cache-movie', 404, 60],
          ['/movies/cache-outage', '/movies/slug/cache-outage', 503, 60],
        ]
        for (const [route, apiPath, status, seconds] of cases) {
          assert.equal(count(apiPath), 0)
          const warmed = await render(route)
          assert.equal(warmed.status, 200)
          assert(warmed.html.includes(fixture.cacheStates.get(apiPath).data.title) && !missing(warmed))
          const warmCount = count(apiPath)
          assert(warmCount > 0)
          fixture.cacheStates.get(apiPath).status = status
          const cached = await render(route)
          assert.equal(cached.status, 200)
          assert(!missing(cached))
          assert.equal(count(apiPath), warmCount, 'A warm detail must reuse its cached result')
          observations.details.push({ route, apiPath, seconds, backendStatusAfterWarm: status, warmCount, warmedAt: Date.now() })
        }
        const cold = '/contents/slug/cache-cold-error'
        assert(missing(await render('/articles/cache-cold-error')))
        fixture.cacheStates.get(cold).status = 200
        const recovered = await render('/articles/cache-cold-error')
        assert.equal(recovered.status, 200)
        assert(recovered.html.includes('故障恢复文章') && !missing(recovered))
        assert(count(cold) >= 2, 'A cold 503 must not become a persistent cached null')
        observations.coldFailureRecovered = true
        for (let i = 0; i < 2; i++) {
          const before = fixture.requests.filter(item => item.path === '/api/v1/movies' && item.query.search === 'cache-probe').length
          const response = await fetch(origin + '/movies?q=cache-probe', { signal: AbortSignal.timeout(10000) })
          await response.text()
          assert.equal(response.status, 200)
          observations.listRequestCounts.push(fixture.requests.filter(item => item.path === '/api/v1/movies' && item.query.search === 'cache-probe').length - before)
        }
        // Observe force-dynamic + explicit fetch revalidate on each Next version; do not assume its caching policy.
        const verifyExpired = async item => {
          const deadline = Date.now() + 15000
          let result = await render(item.route)
          const failedRefresh = () => fixture.requests.find(request => request.path === '/api/v1' + item.apiPath && request.status === 503 && request.completedAt > item.warmedAt)
          while (Date.now() < deadline && (item.backendStatusAfterWarm === 404 ? !missing(result) : !failedRefresh())) {
            await pause(250)
            result = await render(item.route)
          }
          assert(count(item.apiPath) > item.warmCount, 'Expired detail must revalidate against the backend')
          if (item.backendStatusAfterWarm === 404) assert(missing(result), 'Withdrawn detail must disappear after cache refresh')
          else {
            assert(failedRefresh(), 'The backend must have completed the failed refresh')
            item.failedRefreshCompletedAt = failedRefresh().completedAt
            await pause(250)
            result = await render(item.route)
            assert.equal(result.status, 200)
            assert(result.html.includes('暂时故障影视') && !missing(result), 'A failed background refresh must preserve the last successful value')
            item.readAfterFailedRefreshAt = Date.now()
          }
          item.finalStatus = result.status
          item.finalBackendRequests = count(item.apiPath)
          item.elapsedMs = Date.now() - item.warmedAt
        }
        // Check both boundaries within one 61-second window: a 30/60 mix-up must fail.
        await pause(Math.max(0, observations.details[0].warmedAt + 31000 - Date.now()))
        await verifyExpired(observations.details[0])
        for (const item of observations.details.slice(1)) {
          await pause(Math.max(0, item.warmedAt + 31000 - Date.now()))
          const cached = await render(item.route)
          assert.equal(cached.status, 200)
          assert(!missing(cached))
          assert.equal(count(item.apiPath), item.warmCount, '60-second details must still be cached at the 30-second boundary')
          item.cachedAt31Seconds = true
          item.cachedCheckElapsedMs = Date.now() - item.warmedAt
        }
        await pause(Math.max(0, Math.max(...observations.details.map(item => item.warmedAt)) + 61000 - Date.now()))
        for (const item of observations.details.slice(1)) await verifyExpired(item)
        observations.passed = true
        await screenshot('retained-after-503')
        save()
      }, item => item.status === 404)
    })
    const dev = await startNext(isolatedSource('development'), 'development')
    report.origins.development = dev
    await t.test('development resume reaches fixture through Next rewrite', () => resumeScenario(dev, 'development-resume'))
  } finally {
    await cleanup()
    assert.deepEqual(report.cleanupErrors, [])
  }
})
