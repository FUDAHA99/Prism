/* eslint-disable */
/**
 * 演示数据 seed 脚本
 *  - 分类 categories（3 个根分类）
 *  - 文章 contents（3 篇）
 *  - 小说 novels (3) + novel_chapters (每本 5 章)
 *  - 漫画 comics (3) + comic_chapters (每本 3 话，每话 4 页)
 *  - 给已有的 movie 挂一条 movie_source + 若干 movie_episode
 *
 * 幂等：用 slug / (movieId+name) / (novelId+chapterNumber) 之类做去重判断，
 * 已存在就跳过；不会重复插入。
 *
 * 用法：在 backend 目录下：node scripts/seed-demo.js
 */
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// 读取 backend/.env 的数据库配置
function loadEnv() {
  const envPath = path.resolve(__dirname, '..', '.env');
  const out = {};
  if (!fs.existsSync(envPath)) return out;
  for (const line of fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

const env = loadEnv();
const config = {
  host: env.DATABASE_HOST || '127.0.0.1',
  port: parseInt(env.DATABASE_PORT || '3306', 10),
  user: env.DATABASE_USER || 'cms',
  password: env.DATABASE_PASSWORD || 'cms123',
  database: env.DATABASE_NAME || 'cms_dev',
};

const uuid = () => crypto.randomUUID();
const now = () => new Date();

async function ensureCategory(conn, { name, slug, description }) {
  const [rows] = await conn.execute(
    'SELECT id FROM categories WHERE slug = ? LIMIT 1', [slug],
  );
  if (rows.length) return rows[0].id;
  const id = uuid();
  await conn.execute(
    `INSERT INTO categories (id, name, slug, description, sortOrder, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
    [id, name, slug, description || null, now(), now()],
  );
  console.log(`  + category: ${name}`);
  return id;
}

async function ensureContent(conn, payload) {
  const [rows] = await conn.execute(
    'SELECT id FROM contents WHERE slug = ? LIMIT 1', [payload.slug],
  );
  if (rows.length) return rows[0].id;
  const id = uuid();
  await conn.execute(
    `INSERT INTO contents
       (id, title, slug, contentType, status, categoryId, featuredImageUrl,
        excerpt, body, viewCount, isPublished, publishedAt, createdAt, updatedAt)
     VALUES (?,?,?,?,?,?,?,?,?,0,1,?,?,?)`,
    [
      id, payload.title, payload.slug, 'article', 'published',
      payload.categoryId || null, payload.featuredImageUrl || null,
      payload.excerpt || null, payload.body,
      now(), now(), now(),
    ],
  );
  console.log(`  + article: ${payload.title}`);
  return id;
}

async function ensureNovel(conn, n) {
  const [rows] = await conn.execute(
    'SELECT id FROM novels WHERE slug = ? LIMIT 1', [n.slug],
  );
  let id;
  if (rows.length) {
    id = rows[0].id;
  } else {
    id = uuid();
    await conn.execute(
      `INSERT INTO novels
         (id, title, slug, author, categoryId, subType, coverUrl, intro,
          wordCount, chapterCount, serialStatus, status, isFeatured, isVip,
          score, viewCount, favoriteCount, publishedAt, createdAt, updatedAt)
       VALUES (?,?,?,?,?,?,?,?,0,0,?,?,0,0,?,0,0,?,?,?)`,
      [
        id, n.title, n.slug, n.author, n.categoryId || null, n.subType || null,
        n.coverUrl || null, n.intro || null,
        n.serialStatus || 'ongoing', 'published', n.score || 0,
        now(), now(), now(),
      ],
    );
    console.log(`  + novel: ${n.title}`);
  }

  // chapters
  let totalWords = 0;
  for (const ch of n.chapters) {
    const [exist] = await conn.execute(
      'SELECT id FROM novel_chapters WHERE novelId = ? AND chapterNumber = ? LIMIT 1',
      [id, ch.chapterNumber],
    );
    const wc = ch.content.length;
    totalWords += wc;
    if (exist.length) continue;
    await conn.execute(
      `INSERT INTO novel_chapters
         (id, novelId, chapterNumber, title, content, wordCount,
          isVip, isPublished, viewCount, createdAt, updatedAt)
       VALUES (?,?,?,?,?,?,0,1,0,?,?)`,
      [uuid(), id, ch.chapterNumber, ch.title, ch.content, wc, now(), now()],
    );
  }
  await conn.execute(
    'UPDATE novels SET chapterCount = ?, wordCount = ?, lastChapterAt = ? WHERE id = ?',
    [n.chapters.length, totalWords, now(), id],
  );
  return id;
}

async function ensureComic(conn, c) {
  const [rows] = await conn.execute(
    'SELECT id FROM comics WHERE slug = ? LIMIT 1', [c.slug],
  );
  let id;
  if (rows.length) {
    id = rows[0].id;
  } else {
    id = uuid();
    await conn.execute(
      `INSERT INTO comics
         (id, title, slug, author, categoryId, subType, coverUrl, intro,
          chapterCount, serialStatus, status, isFeatured, isVip,
          score, viewCount, favoriteCount, publishedAt, createdAt, updatedAt)
       VALUES (?,?,?,?,?,?,?,?,0,?,?,0,0,?,0,0,?,?,?)`,
      [
        id, c.title, c.slug, c.author, c.categoryId || null, c.subType || null,
        c.coverUrl || null, c.intro || null,
        c.serialStatus || 'ongoing', 'published', c.score || 0,
        now(), now(), now(),
      ],
    );
    console.log(`  + comic: ${c.title}`);
  }

  for (const ch of c.chapters) {
    const [exist] = await conn.execute(
      'SELECT id FROM comic_chapters WHERE comicId = ? AND chapterNumber = ? LIMIT 1',
      [id, ch.chapterNumber],
    );
    if (exist.length) continue;
    await conn.execute(
      `INSERT INTO comic_chapters
         (id, comicId, chapterNumber, title, pageUrls, pageCount,
          isVip, isPublished, viewCount, createdAt, updatedAt)
       VALUES (?,?,?,?,?,?,0,1,0,?,?)`,
      [
        uuid(), id, ch.chapterNumber, ch.title,
        JSON.stringify(ch.pageUrls), ch.pageUrls.length, now(), now(),
      ],
    );
  }
  await conn.execute(
    'UPDATE comics SET chapterCount = ?, lastChapterAt = ? WHERE id = ?',
    [c.chapters.length, now(), id],
  );
  return id;
}

async function ensureMovie(conn, m) {
  const [rows] = await conn.execute(
    'SELECT id FROM movies WHERE slug = ? LIMIT 1', [m.slug],
  );
  if (rows.length) return rows[0].id;
  const id = uuid();
  await conn.execute(
    `INSERT INTO movies
       (id, title, originalTitle, slug, movieType, categoryId, subType,
        year, region, language, director, actors, intro, posterUrl,
        duration, totalEpisodes, currentEpisode, isFinished,
        score, status, isFeatured, isVip, viewCount, publishedAt, createdAt, updatedAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,?,?,?)`,
    [
      id,
      m.title,
      m.originalTitle || null,
      m.slug,
      m.movieType,
      m.categoryId || null,
      m.subType || null,
      m.year || null,
      m.region || null,
      m.language || null,
      m.director || null,
      m.actors || null,
      m.intro || null,
      m.posterUrl || null,
      m.duration || null,
      m.totalEpisodes || null,
      m.currentEpisode || null,
      m.isFinished ? 1 : 0,
      m.score || 0,
      'published',
      m.isFeatured ? 1 : 0,
      now(), now(), now(),
    ],
  );
  console.log(`  + movie: ${m.title} [${m.movieType}]`);
  return id;
}

async function ensureComment(conn, { contentId, parentId, guestName, guestEmail, body, status }) {
  // 用 contentId + guestName + body 的前 20 字做去重（seed 场景够用）
  const [rows] = await conn.execute(
    'SELECT id FROM comments WHERE contentId = ? AND guestName = ? AND SUBSTR(body,1,20) = ? LIMIT 1',
    [contentId, guestName, body.substring(0, 20)],
  );
  if (rows.length) return rows[0].id;
  const id = uuid();
  await conn.execute(
    `INSERT INTO comments
       (id, contentId, parentId, guestName, guestEmail, body, status, ipAddress, createdAt)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, contentId, parentId || null, guestName, guestEmail, body,
     status || 'approved', '127.0.0.1', now()],
  );
  return id;
}

async function upsertSiteSetting(conn, key, value, group, description) {
  await conn.execute(
    `INSERT INTO site_settings (id, \`key\`, \`value\`, \`group\`, \`description\`, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`), updatedAt = VALUES(updatedAt)`,
    [uuid(), key, value, group || 'general', description || null, now()],
  );
}

async function ensureMoviePlaySource(conn, movieId, sourceName, episodes) {
  const [exist] = await conn.execute(
    'SELECT id FROM movie_sources WHERE movieId = ? AND name = ? LIMIT 1',
    [movieId, sourceName],
  );
  let sourceId;
  if (exist.length) {
    sourceId = exist[0].id;
  } else {
    sourceId = uuid();
    await conn.execute(
      `INSERT INTO movie_sources
         (id, movieId, name, kind, player, sortOrder, createdAt, updatedAt)
       VALUES (?,?,?,?,?,0,?,?)`,
      [sourceId, movieId, sourceName, 'play', 'm3u8', now(), now()],
    );
    console.log(`  + movie source: ${sourceName} (movie ${movieId})`);
  }

  for (const ep of episodes) {
    const [er] = await conn.execute(
      'SELECT id FROM movie_episodes WHERE sourceId = ? AND episodeNumber = ? LIMIT 1',
      [sourceId, ep.episodeNumber],
    );
    if (er.length) continue;
    await conn.execute(
      `INSERT INTO movie_episodes
         (id, sourceId, title, episodeNumber, url, durationSec, sortOrder, createdAt, updatedAt)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        uuid(), sourceId, ep.title, ep.episodeNumber, ep.url,
        ep.durationSec || null, ep.episodeNumber, now(), now(),
      ],
    );
  }
}

async function main() {
  const conn = await mysql.createConnection(config);
  console.log('Connected to MySQL', `${config.host}:${config.port}/${config.database}`);

  // ─── 分类 ───
  console.log('\n[分类]');
  const catTech = await ensureCategory(conn, { name: '技术', slug: 'tech', description: '技术分享' });
  const catLife = await ensureCategory(conn, { name: '生活', slug: 'life', description: '日常杂记' });
  const catNews = await ensureCategory(conn, { name: '资讯', slug: 'news', description: '行业资讯' });

  // ─── 文章 ───
  console.log('\n[文章]');
  await ensureContent(conn, {
    title: 'Next.js 14 App Router 入门',
    slug: 'nextjs-14-app-router-intro',
    categoryId: catTech,
    excerpt: '快速了解 Next.js 14 的 App Router 心智模型与常见模式。',
    body: '# Next.js 14\n\n本文介绍 App Router 的关键概念：Server Components、Streaming、Caching、Route Handlers。\n\n## Server Components\n默认所有组件都在服务端渲染，靠 use client 切到客户端。\n\n## Caching\n请求级、Route 级、Full Route Cache 三层。',
  });
  await ensureContent(conn, {
    title: 'NestJS 实战：模块化与依赖注入',
    slug: 'nestjs-modules-and-di',
    categoryId: catTech,
    excerpt: '聊一聊在中型项目里 NestJS 怎么组织模块边界。',
    body: '# NestJS 模块化\n\n模块边界的划分原则：按业务能力，而不是按技术分层。\n\n依赖注入避免 service 互相 import，推荐用 Provider Token。',
  });
  await ensureContent(conn, {
    title: '一段日常：晚上九点的咖啡',
    slug: 'late-night-coffee',
    categoryId: catLife,
    excerpt: '深夜独处的一些碎想。',
    body: '夜里九点，写完最后一行 commit message，泡了一杯手冲。\n\n窗外的霓虹散开，世界仿佛只剩这一杯热气。',
  });

  // ─── 小说 ───
  console.log('\n[小说]');
  await ensureNovel(conn, {
    title: '雾色长安',
    slug: 'wuse-changan',
    author: '青冥',
    categoryId: catLife,
    subType: '言情·古风',
    intro: '一段被困在长安的恋情，一座永不落雪的城。',
    serialStatus: 'ongoing',
    score: 8.6,
    chapters: Array.from({ length: 5 }, (_, i) => ({
      chapterNumber: i + 1,
      title: `第${i + 1}章 ${['初遇', '惊变', '别离', '归途', '相逢'][i]}`,
      content: `这是《雾色长安》的第 ${i + 1} 章正文。\n\n` +
        `长安城的雾，是从子时开始落下的。\n` +
        `她披一件月白色斗篷，立在朱雀大街的转角。\n` +
        `他从远处走来，脚步在湿青石上发出微响。\n\n` +
        `(此处是占位文字，真实章节会更长)`,
    })),
  });
  await ensureNovel(conn, {
    title: '星海尽头',
    slug: 'xinghai-jintou',
    author: '林墨',
    categoryId: catTech,
    subType: '科幻·硬核',
    intro: '人类把方舟射向半人马座的那天，地球开始倒计时。',
    serialStatus: 'finished',
    score: 9.1,
    chapters: Array.from({ length: 5 }, (_, i) => ({
      chapterNumber: i + 1,
      title: `第${i + 1}章 ${['启航', '断链', '极光', '冷眠', '终点'][i]}`,
      content: `《星海尽头》第 ${i + 1} 章。\n\n` +
        `主控屏上跳出红色警报，舰长把手按在生物锁上。\n` +
        `他知道，从这一刻起，他们再也回不去地球。`,
    })),
  });
  await ensureNovel(conn, {
    title: '川渝怪谈',
    slug: 'chuanyu-guaitan',
    author: '老李',
    categoryId: catNews,
    subType: '悬疑·短篇',
    intro: '十二个发生在巴蜀小镇的怪事。',
    serialStatus: 'ongoing',
    score: 7.8,
    chapters: Array.from({ length: 5 }, (_, i) => ({
      chapterNumber: i + 1,
      title: `第${i + 1}怪 ${['夜行客', '红伞', '无名碑', '哭嫁', '阴沟'][i]}`,
      content: `川渝怪谈·第 ${i + 1} 篇。\n\n` +
        `镇上人都说，那条小巷子晚上不要走。\n` +
        `可是那一晚，他偏偏去了。`,
    })),
  });

  // ─── 漫画 ───
  console.log('\n[漫画]');
  // 用 picsum.photos 提供占位漫画页图（每页 800x1200）
  const pageImg = (seed) => `https://picsum.photos/seed/${seed}/800/1200`;
  await ensureComic(conn, {
    title: '机械之心',
    slug: 'mechanical-heart',
    author: '一原',
    categoryId: catTech,
    subType: '科幻·机甲',
    intro: '一台被遗忘的机甲，一个失忆的少女。',
    serialStatus: 'ongoing',
    score: 8.9,
    chapters: Array.from({ length: 3 }, (_, i) => ({
      chapterNumber: i + 1,
      title: `第${i + 1}话 ${['苏醒', '第一次行走', '风暴'][i]}`,
      pageUrls: Array.from({ length: 4 }, (_, p) =>
        pageImg(`mh-${i + 1}-${p + 1}`)),
    })),
  });
  await ensureComic(conn, {
    title: '深夜便利店',
    slug: 'late-night-store',
    author: '夏目',
    categoryId: catLife,
    subType: '治愈·日常',
    intro: '凌晨三点，便利店里来了一只会说话的猫。',
    serialStatus: 'ongoing',
    score: 8.4,
    chapters: Array.from({ length: 3 }, (_, i) => ({
      chapterNumber: i + 1,
      title: `第${i + 1}话 ${['关东煮', '雨夜', '老朋友'][i]}`,
      pageUrls: Array.from({ length: 4 }, (_, p) =>
        pageImg(`lns-${i + 1}-${p + 1}`)),
    })),
  });
  await ensureComic(conn, {
    title: '剑与彼岸',
    slug: 'sword-and-yonder',
    author: '夜雨',
    categoryId: catNews,
    subType: '热血·冒险',
    intro: '少年提剑，自西域而来。',
    serialStatus: 'finished',
    score: 9.0,
    chapters: Array.from({ length: 3 }, (_, i) => ({
      chapterNumber: i + 1,
      title: `第${i + 1}话 ${['出关', '初战', '彼岸'][i]}`,
      pageUrls: Array.from({ length: 4 }, (_, p) =>
        pageImg(`sy-${i + 1}-${p + 1}`)),
    })),
  });

  // ─── 影视：12 部，覆盖 5 种 movieType + 多地区 ───
  console.log('\n[影视]');
  // movie（4 部）
  await ensureMovie(conn, {
    title: '流浪地球 3', slug: 'wandering-earth-3', movieType: 'movie',
    subType: '科幻·灾难', year: 2026, region: '中国大陆', language: '普通话',
    director: '郭帆', actors: '吴京,刘德华,李雪健',
    intro: '太阳再次失控，人类将最后的希望押注于一颗新的恒星。',
    duration: 138, totalEpisodes: 1, currentEpisode: 1, isFinished: true,
    score: 9.2, isFeatured: true,
  });
  await ensureMovie(conn, {
    title: '奥本海默', originalTitle: 'Oppenheimer', slug: 'oppenheimer-2023',
    movieType: 'movie', subType: '剧情·传记', year: 2023,
    region: '美国', language: '英语',
    director: '克里斯托弗·诺兰', actors: '基里安·墨菲,艾米莉·布朗特',
    intro: '原子弹之父的史诗传记，一场改变世界的审判。',
    duration: 180, totalEpisodes: 1, currentEpisode: 1, isFinished: true, score: 9.0,
  });
  await ensureMovie(conn, {
    title: '哥斯拉大战金刚2：帝国崛起',
    originalTitle: 'Godzilla x Kong: The New Empire',
    slug: 'godzilla-x-kong-2024', movieType: 'movie',
    subType: '科幻·怪兽', year: 2024, region: '美国', language: '英语',
    director: '亚当·温加德', actors: '丽贝卡·豪尔,布莱恩·泰里·亨利',
    intro: '两大怪兽联手对抗来自地球深处的远古威胁。',
    duration: 115, totalEpisodes: 1, currentEpisode: 1, isFinished: true, score: 7.2,
  });
  await ensureMovie(conn, {
    title: '九龙城寨·围城', slug: 'kowloon-city-2024', movieType: 'movie',
    subType: '动作·犯罪', year: 2024, region: '中国香港', language: '粤语',
    director: '郑保瑞', actors: '古天乐,林峰,洪金宝',
    intro: '1980 年代香港九龙城寨，一段热血与义气交织的故事。',
    duration: 126, totalEpisodes: 1, currentEpisode: 1, isFinished: true, score: 8.1,
  });
  // tv（3 部）
  await ensureMovie(conn, {
    title: '庆余年 第三季', slug: 'joy-of-life-s3', movieType: 'tv',
    subType: '古装·权谋', year: 2025, region: '中国大陆', language: '普通话',
    director: '孙皓', actors: '张若昀,李沁,陈道明',
    intro: '范闲归来，朝堂暗流再度汹涌。',
    totalEpisodes: 24, currentEpisode: 24, isFinished: true, score: 9.0, isFeatured: true,
  });
  await ensureMovie(conn, {
    title: '鱿鱼游戏 第三季', originalTitle: 'Squid Game Season 3',
    slug: 'squid-game-s3', movieType: 'tv',
    subType: '生存·惊悚', year: 2025, region: '韩国', language: '韩语',
    director: '黄东赫', actors: '李政宰,李炳宪',
    intro: '成奇勋决定终结这场游戏，但代价超乎想象。',
    totalEpisodes: 6, currentEpisode: 6, isFinished: true, score: 8.8,
  });
  await ensureMovie(conn, {
    title: '黑镜 第七季', originalTitle: 'Black Mirror Season 7',
    slug: 'black-mirror-s7', movieType: 'tv',
    subType: '科幻·悬疑', year: 2025, region: '英国', language: '英语',
    director: '查理·布鲁克', actors: '各集不同',
    intro: '六个独立故事，六种技术带来的噩梦。',
    totalEpisodes: 6, currentEpisode: 6, isFinished: true, score: 8.3,
  });
  // anime（2 部）
  await ensureMovie(conn, {
    title: '葬送的芙莉莲', originalTitle: 'Frieren: Beyond Journey\'s End',
    slug: 'frieren-2024', movieType: 'anime',
    subType: '奇幻·治愈', year: 2024, region: '日本', language: '日语',
    director: '斋藤圭一郎', actors: '种崎敦美,小林千晃',
    intro: '魔法使芙莉莲在漫长的旅途中，慢慢理解生命的意义。',
    totalEpisodes: 28, currentEpisode: 28, isFinished: true, score: 9.4, isFeatured: true,
  });
  await ensureMovie(conn, {
    title: '电锯人', originalTitle: 'Chainsaw Man',
    slug: 'chainsaw-man', movieType: 'anime',
    subType: '热血·暗黑', year: 2022, region: '日本', language: '日语',
    director: '中山龙', actors: '户谷菊次郎,楠木ともり',
    intro: '少年与电锯恶魔合体，成为公安猎魔人。',
    totalEpisodes: 12, currentEpisode: 12, isFinished: true, score: 8.6,
  });
  // variety（2 部）
  await ensureMovie(conn, {
    title: '歌手 2025', slug: 'singer-2025', movieType: 'variety',
    subType: '音乐·竞技', year: 2025, region: '中国大陆', language: '普通话',
    intro: '顶级歌手同台竞演，每一期都是听觉盛宴。',
    totalEpisodes: 12, currentEpisode: 12, isFinished: true, score: 8.5, isFeatured: true,
  });
  await ensureMovie(conn, {
    title: '奔跑吧 第十三季', slug: 'run-s13', movieType: 'variety',
    subType: '竞技·娱乐', year: 2025, region: '中国大陆', language: '普通话',
    intro: '跑男团全员回归，开启全新冒险旅程。',
    totalEpisodes: 20, currentEpisode: 20, isFinished: true, score: 7.9,
  });
  // short（1 部）
  await ensureMovie(conn, {
    title: '我在他乡挺好的', slug: 'alone-in-city', movieType: 'short',
    subType: '都市·情感', year: 2021, region: '中国大陆', language: '普通话',
    director: '刘畅', actors: '任素汐,曹俊,钟楚曦',
    intro: '四个北漂女生的故事，温暖又心酸。',
    totalEpisodes: 30, currentEpisode: 30, isFinished: true, score: 8.7,
  });

  // ─── 评论：每篇文章 3-5 条，含嵌套回复 + 待审 ───
  console.log('\n[评论]');
  const [articles] = await conn.execute(
    "SELECT id, title, slug FROM contents WHERE status = 'published' ORDER BY createdAt",
  );
  const commentData = [
    // 文章 0: nextjs-14-app-router-intro
    [
      { guestName: '小王同学', guestEmail: 'wang@example.com', status: 'approved',
        body: '写得很清楚！App Router 的缓存分层我之前一直搞不太明白，看完这篇终于理解了。' },
      { guestName: '前端打工人', guestEmail: 'fe@example.com', status: 'approved',
        body: 'Server Components 这块踩了好多坑，useState 不能在 Server Component 里用，折腾了半天。' },
      { guestName: '路人甲', guestEmail: 'luren@example.com', status: 'approved',
        body: '请问 Route Handlers 和 API Routes 有什么本质区别吗？' },
      { guestName: '博主', guestEmail: 'admin@metu.dev', status: 'approved',
        body: 'Route Handlers 是 App Router 的替代品，支持 Edge Runtime，也更灵活；API Routes 属于 Pages Router 时代的产物，两者不建议混用。',
        parentIdx: 2 /* 回复「路人甲」 */ },
      { guestName: '待审用户', guestEmail: 'pending@example.com', status: 'pending',
        body: '能不能出一篇 Middleware 的详细教程？' },
    ],
    // 文章 1: nestjs-modules-and-di
    [
      { guestName: '后端老兵', guestEmail: 'senior@example.com', status: 'approved',
        body: 'Provider Token 解耦这一点我们团队也在推，减少了很多循环依赖的问题。' },
      { guestName: '新手村民', guestEmail: 'newbie@example.com', status: 'approved',
        body: '按业务能力分模块这个思路很对，一开始我们按 controller/service/dto 分文件夹，维护起来很痛。' },
      { guestName: '架构思考者', guestEmail: 'arch@example.com', status: 'approved',
        body: '有没有推荐的 NestJS 大型项目模板？GitHub 上几个流行的风格差挺多的。' },
      { guestName: '路人乙', guestEmail: 'luren2@example.com', status: 'pending',
        body: '感觉 NestJS 学习曲线有点陡，装饰器一多就眼花缭乱。' },
    ],
    // 文章 2: late-night-coffee
    [
      { guestName: '夜猫子', guestEmail: 'owl@example.com', status: 'approved',
        body: '写到心里去了。深夜码代码的孤独感，只有自己知道。' },
      { guestName: '同城老张', guestEmail: 'zhang@example.com', status: 'approved',
        body: '手冲真的是程序员的续命水，我每晚都要来一杯。' },
      { guestName: '不喝咖啡的人', guestEmail: 'nocoffee@example.com', status: 'approved',
        body: '喝咖啡睡不着，我只喝热牛奶，但那种深夜独处的感觉是一样的。' },
      { guestName: '夜猫子', guestEmail: 'owl@example.com', status: 'approved',
        body: '对！热牛奶也很好，关键是那个仪式感。',
        parentIdx: 2 /* 回复「不喝咖啡的人」 */ },
      { guestName: '匆匆过客', guestEmail: 'passerby@example.com', status: 'pending',
        body: '博主这是在北京吗？窗外霓虹的城市。' },
    ],
  ];

  for (let ai = 0; ai < Math.min(articles.length, commentData.length); ai++) {
    const article = articles[ai];
    const comments = commentData[ai];
    const insertedIds = [];
    for (const c of comments) {
      const parentId = c.parentIdx !== undefined ? insertedIds[c.parentIdx] : null;
      const id = await ensureComment(conn, {
        contentId: article.id,
        parentId,
        guestName: c.guestName,
        guestEmail: c.guestEmail,
        body: c.body,
        status: c.status,
      });
      insertedIds.push(id);
    }
    console.log(`  + ${comments.length} 条评论 → "${article.title}"`);
  }

  // ─── 站点配置 ───
  console.log('\n[站点配置]');
  const settings = [
    ['site_name',        'METU 内容站',                          'general', '站点名称'],
    ['site_description', '影视·小说·漫画·文章，一站尽览',        'general', '站点描述'],
    ['site_logo',        '',                                      'general', '站点 Logo URL'],
    ['site_favicon',     '',                                      'general', 'Favicon URL'],
    ['site_icp',         '',                                      'general', 'ICP 备案号'],
    ['site_keywords',    'METU,影视,小说,漫画,内容平台',          'seo',     '关键词（逗号分隔）'],
    ['enable_comment',   'true',                                  'general', '是否开启评论'],
    ['comment_audit',    'true',                                  'general', '评论是否需要审核'],
    ['posts_per_page',   '10',                                    'general', '列表每页条数'],
  ];
  for (const [key, value, group, description] of settings) {
    await upsertSiteSetting(conn, key, value, group, description);
    console.log(`  • ${key} = ${value || '(empty)'}`);
  }

  // ─── 影视：给所有现有 movie 挂一个播放线路 ───
  console.log('\n[影视播放源]');
  const [movies] = await conn.execute(
    "SELECT id, title, totalEpisodes, movieType FROM movies WHERE status = 'published'",
  );
  // 公共测试 m3u8（Apple BipBop sample）
  const sampleUrl = 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8';
  for (const m of movies) {
    const epCount = m.movieType === 'movie' ? 1 : Math.min(m.totalEpisodes || 6, 6);
    const episodes = Array.from({ length: epCount }, (_, i) => ({
      episodeNumber: i + 1,
      title: m.movieType === 'movie' ? '正片' : `第${String(i + 1).padStart(2, '0')}集`,
      url: sampleUrl,
      durationSec: 600,
    }));
    await ensureMoviePlaySource(conn, m.id, '线路1', episodes);
  }

  console.log('\n✅ Seed 完成');
  await conn.end();
}

main().catch((err) => {
  console.error('❌ Seed 失败:', err);
  process.exit(1);
});
