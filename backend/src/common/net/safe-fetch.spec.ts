import * as http from 'http';
import { AddressInfo } from 'net';
import * as zlib from 'zlib';
import { classifyIp } from './address-policy';
import { createSafeFetch, SafeFetch, safeFetch, SafeFetchError } from './safe-fetch';

/**
 * safe-fetch 的集成测试：在 127.0.0.1 上起真实的 HTTP 服务器。
 *
 * - 生产用的 safeFetch 对它的任何写法（IP、整数、十六进制、localhost、IPv6、伪造 DNS）都必须拦截，
 *   并且服务器一次请求都收不到 —— 拦截发生在连接之前；
 * - 其余行为（重定向逐跳校验、大小上限、超时、解压、跨源去掉凭据头）用一个只额外放行 127.0.0.1 的
 *   测试实例验证，其他地址仍走生产的 classifyIp。
 */

const SECRET = 'INTERNAL-ONLY-SECRET-7f3a9c';

interface TestServer {
  port: number;
  origin: string;
  hits: Map<string, number>;
  lastHeaders: Map<string, http.IncomingHttpHeaders>;
  lastMethod: Map<string, string>;
  close: () => Promise<void>;
}

function totalHits(server: TestServer): number {
  let n = 0;
  for (const v of server.hits.values()) n += v;
  return n;
}

const bomb = zlib.gzipSync(Buffer.alloc(32 * 1024 * 1024)); // 32 MiB 的 0，压缩后约 32 KB

async function startServer(peer?: () => TestServer): Promise<TestServer> {
  const hits = new Map<string, number>();
  const lastHeaders = new Map<string, http.IncomingHttpHeaders>();
  const lastMethod = new Map<string, string>();
  const sockets = new Set<import('net').Socket>();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    lastHeaders.set(path, req.headers);
    lastMethod.set(path, req.method ?? '');
    const self = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const chain = path.match(/^\/chain\/(\d+)$/);
    if (chain) {
      const n = Number(chain[1]);
      if (n === 0) return res.end('chain-end');
      res.writeHead(302, { location: `/chain/${n - 1}` });
      return res.end();
    }

    switch (path) {
      case '/ok':
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('hello');
      case '/secret':
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end(SECRET);
      case '/echo-headers':
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(req.headers));
      case '/to-metadata':
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
        return res.end();
      case '/to-localhost':
        res.writeHead(301, { location: `http://localhost:${(server.address() as AddressInfo).port}/ok` });
        return res.end();
      case '/to-mapped-v6':
        res.writeHead(307, { location: `http://[::ffff:127.0.0.1]:${(server.address() as AddressInfo).port}/ok` });
        return res.end();
      case '/to-decimal':
        // 169.254.169.254 的十进制整数写法
        res.writeHead(308, { location: 'http://2852039166/latest/meta-data/' });
        return res.end();
      case '/to-ftp':
        res.writeHead(302, { location: 'ftp://example.com/file' });
        return res.end();
      case '/to-file':
        res.writeHead(302, { location: 'file:///etc/passwd' });
        return res.end();
      case '/to-same-origin':
        res.writeHead(302, { location: `${self}/echo-headers` });
        return res.end();
      case '/to-peer':
        res.writeHead(302, { location: `${peer!().origin}/echo-headers` });
        return res.end();
      case '/see-other':
        res.writeHead(303, { location: '/method' });
        return res.end();
      case '/method':
        return res.end(req.method);
      case '/redirect-with-body':
        // 重定向响应带一个无穷 body：不能被读，否则会一直耗下去
        res.writeHead(302, { location: '/ok' });
        res.write('x'.repeat(1024));
        return; // 不 end
      case '/big':
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        for (let i = 0; i < 64; i++) res.write(Buffer.alloc(64 * 1024, 0x61));
        return res.end();
      case '/big-declared':
        res.writeHead(200, { 'content-length': String(64 * 1024 * 1024) });
        return res.write('partial'); // 只看声明长度就该拒绝
      case '/gzip-bomb':
        res.writeHead(200, { 'content-encoding': 'gzip' });
        return res.end(bomb);
      case '/gzip':
        res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'application/json' });
        return res.end(zlib.gzipSync(JSON.stringify({ ok: 'gzip' })));
      case '/deflate':
        res.writeHead(200, { 'content-encoding': 'deflate' });
        return res.end(zlib.deflateSync(JSON.stringify({ ok: 'deflate' })));
      case '/br':
        res.writeHead(200, { 'content-encoding': 'br' });
        return res.end(zlib.brotliCompressSync(JSON.stringify({ ok: 'br' })));
      case '/corrupt-gzip':
        res.writeHead(200, { 'content-encoding': 'gzip' });
        return res.end(Buffer.from('definitely not gzip ' + SECRET));
      case '/zstd':
        res.writeHead(200, { 'content-encoding': 'zstd' });
        return res.end(SECRET);
      case '/hang':
        return; // 永不响应
      case '/trickle': {
        res.writeHead(200);
        const t = setInterval(() => res.write('.'), 50);
        res.on('close', () => clearInterval(t));
        return;
      }
      case '/hang-up':
        res.writeHead(200, { 'content-length': '1000' });
        res.write('partial ' + SECRET);
        setTimeout(() => req.socket.destroy(), 20);
        return;
      case '/status-500':
        res.writeHead(500, { 'content-type': 'text/plain' });
        return res.end(SECRET);
      default:
        res.writeHead(404);
        return res.end();
    }
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    hits,
    lastHeaders,
    lastMethod,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

async function fetchError(fetcher: SafeFetch, url: string, options = {}): Promise<SafeFetchError> {
  try {
    await fetcher(url, options);
  } catch (err) {
    expect(err).toBeInstanceOf(SafeFetchError);
    return err as SafeFetchError;
  }
  throw new Error(`期望 ${url} 失败，但请求成功了`);
}

const FIXED_MESSAGES = new Set([
  '地址格式不正确',
  '只允许 http/https 地址',
  '目标地址指向内网、本机或保留地址，已拦截',
  '重定向次数超过上限',
  '请求超时',
  '响应内容超过大小上限',
  '响应使用了不支持的压缩格式',
  '域名解析失败',
  '连接被拒绝',
  '连接被中断',
  '目标主机不可达',
  'TLS 证书校验失败',
  '对方返回的响应格式不正确',
  '请求头不合法',
  '网络请求失败',
]);

function expectSafeMessage(err: SafeFetchError) {
  expect(FIXED_MESSAGES.has(err.message)).toBe(true);
  expect(err.message).not.toContain(SECRET);
}

/** 只额外放行 127.0.0.1（测试服务器），其他一律按生产策略 */
const allowTestServer = (ip: string) => (ip === '127.0.0.1' ? null : classifyIp(ip));

let a: TestServer;
let b: TestServer;

beforeAll(async () => {
  a = await startServer(() => b);
  b = await startServer(() => a);
});

afterAll(async () => {
  await a.close();
  await b.close();
});

beforeEach(() => {
  a.hits.clear();
  b.hits.clear();
});

describe('safeFetch（生产策略）拦截本机与内网地址，且请求根本发不出去', () => {
  const variants = (port: number) => [
    `http://127.0.0.1:${port}/ok`,
    `http://localhost:${port}/ok`,
    `http://LOCALHOST.:${port}/ok`,
    `http://foo.localhost:${port}/ok`,
    `http://127.1:${port}/ok`,
    `http://0x7f.1:${port}/ok`,
    `http://0x7f000001:${port}/ok`,
    `http://2130706433:${port}/ok`,
    `http://017700000001:${port}/ok`,
    `http://0177.0.0.1:${port}/ok`,
    `http://%31%32%37.0.0.1:${port}/ok`,
    `http://[::1]:${port}/ok`,
    `http://[::ffff:127.0.0.1]:${port}/ok`,
    `http://[::ffff:7f00:1]:${port}/ok`,
    `http://[0:0:0:0:0:ffff:7f00:1]:${port}/ok`,
    `http://0.0.0.0:${port}/ok`,
    `http://0:${port}/ok`,
    `https://127.0.0.1:${port}/ok`,
    `http://user:pass@127.0.0.1:${port}/ok`,
  ];

  it('各种写法的回环地址', async () => {
    for (const url of variants(a.port)) {
      const err = await fetchError(safeFetch, url);
      expect({ url, code: err.code }).toEqual({ url, code: 'BLOCKED_ADDRESS' });
      expectSafeMessage(err);
    }
    expect(totalHits(a)).toBe(0);
  });

  it.each([
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'http://[fd00:ec2::254]/latest/meta-data/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://100.100.100.200/latest/meta-data/',
    'http://10.0.0.1/',
    'http://172.17.0.1:3306/',
    'http://192.168.1.1/',
    'http://mysql:3306/',
    'http://redis:6379/',
    'http://[fe80::1]/',
    'http://224.0.0.1/',
    'http://255.255.255.255/',
  ])('%s', async (url) => {
    const err = await fetchError(safeFetch, url, { timeoutMs: 2000 });
    expect(err.code).toBe('BLOCKED_ADDRESS');
  });

  it.each([
    ['file:///etc/passwd', 'UNSUPPORTED_PROTOCOL'],
    ['ftp://example.com/', 'UNSUPPORTED_PROTOCOL'],
    ['gopher://127.0.0.1:6379/_INFO', 'UNSUPPORTED_PROTOCOL'],
    ['data:text/plain,hello', 'UNSUPPORTED_PROTOCOL'],
    ['javascript:alert(1)', 'UNSUPPORTED_PROTOCOL'],
    ['not a url', 'INVALID_URL'],
    ['', 'INVALID_URL'],
  ])('%s → %s', async (url, code) => {
    const err = await fetchError(safeFetch, url);
    expect(err.code).toBe(code);
  });
});

describe('建连时校验 DNS 解析结果（防 DNS rebinding）', () => {
  const fakeResolve = (answers: Record<string, string[] | (() => string[])>) => {
    const calls: string[] = [];
    const resolve = (hostname: string, _opts: unknown, cb: (err: any, addrs: any[]) => void) => {
      calls.push(hostname);
      const entry = answers[hostname];
      if (!entry) {
        const e: NodeJS.ErrnoException = new Error('not found');
        e.code = 'ENOTFOUND';
        return cb(e, []);
      }
      const list = typeof entry === 'function' ? entry() : entry;
      cb(
        null,
        list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
      );
    };
    return { resolve, calls };
  };

  it('公网域名解析到 127.0.0.1：在连接前拦截，服务器收不到请求', async () => {
    const dns = fakeResolve({ 'rebind.example.net': ['127.0.0.1'] });
    const fetcher = createSafeFetch({ resolve: dns.resolve });
    const err = await fetchError(fetcher, `http://rebind.example.net:${a.port}/ok`);
    expect(err.code).toBe('BLOCKED_ADDRESS');
    expect(err.detail).toContain('127.0.0.1');
    expect(dns.calls).toEqual(['rebind.example.net']);
    expect(totalHits(a)).toBe(0);
  });

  it('解析结果里只要混有一个内网地址就整体拒绝', async () => {
    const dns = fakeResolve({ 'mixed.example.net': ['93.184.216.34', '169.254.169.254'] });
    const err = await fetchError(createSafeFetch({ resolve: dns.resolve }), 'http://mixed.example.net/');
    expect(err.code).toBe('BLOCKED_ADDRESS');
  });

  it('解析到 IPv4-mapped IPv6 形式的内网地址同样拦截', async () => {
    const dns = fakeResolve({ 'mapped.example.net': ['::ffff:10.0.0.5'] });
    const err = await fetchError(createSafeFetch({ resolve: dns.resolve }), 'http://mapped.example.net/');
    expect(err.code).toBe('BLOCKED_ADDRESS');
  });

  it('每次建连都重新解析并校验：第一次解析到放行地址、重定向后同名解析到回环 → 拦截', async () => {
    let n = 0;
    const dns = fakeResolve({
      // 测试实例只放行 127.0.0.1；第二次解析换成 127.0.0.2（回环，生产策略拦截）
      'rebind.example.net': () => (n++ === 0 ? ['127.0.0.1'] : ['127.0.0.2']),
    });
    const fetcher = createSafeFetch({ resolve: dns.resolve, classifyAddress: allowTestServer });
    a.hits.clear();
    // /chain/1 → 302 到同源 /chain/0：第二跳重新建连、重新解析
    const err = await fetchError(fetcher, `http://rebind.example.net:${a.port}/chain/1`);
    expect(err.code).toBe('BLOCKED_ADDRESS');
    expect(err.detail).toContain('127.0.0.2');
    expect(dns.calls).toEqual(['rebind.example.net', 'rebind.example.net']);
    expect(a.hits.get('/chain/1')).toBe(1);
    expect(a.hits.get('/chain/0')).toBeUndefined();
  });

  it('域名解析失败给出固定文案', async () => {
    const dns = fakeResolve({});
    const err = await fetchError(createSafeFetch({ resolve: dns.resolve }), 'http://nope.example.net/');
    expect(err.code).toBe('DNS_FAILED');
    expectSafeMessage(err);
  });
});

describe('放行测试服务器后的行为', () => {
  const fetcher = createSafeFetch({ classifyAddress: allowTestServer });

  it('正常 GET 返回状态码与响应体', async () => {
    const res = await fetcher(`${a.origin}/ok`);
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('hello');
    expect(res.redirects).toBe(0);
    expect(res.url).toBe(`${a.origin}/ok`);
  });

  it('HEAD 不读响应体', async () => {
    const res = await fetcher(`${a.origin}/ok`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(0);
    expect(a.lastMethod.get('/ok')).toBe('HEAD');
  });

  it('URL 里带账号密码时按 Basic 认证发送；畸形的百分号编码给固定文案', async () => {
    const res = await fetcher(`http://u%40x:p%3Aw@127.0.0.1:${a.port}/echo-headers`);
    const echoed = JSON.parse(res.body.toString());
    expect(Buffer.from(echoed.authorization.replace('Basic ', ''), 'base64').toString()).toBe('u@x:p:w');
    expect((await fetchError(fetcher, `http://%zz@127.0.0.1:${a.port}/ok`)).code).toBe('INVALID_URL');
  });

  it('非 2xx 也照常返回（由调用方决定怎么报错）', async () => {
    const res = await fetcher(`${a.origin}/status-500`);
    expect(res.status).toBe(500);
  });

  describe('重定向逐跳校验', () => {
    it.each([
      ['/to-metadata', 'BLOCKED_ADDRESS'],
      ['/to-localhost', 'BLOCKED_ADDRESS'],
      ['/to-mapped-v6', 'BLOCKED_ADDRESS'],
      ['/to-decimal', 'BLOCKED_ADDRESS'],
      ['/to-ftp', 'UNSUPPORTED_PROTOCOL'],
      ['/to-file', 'UNSUPPORTED_PROTOCOL'],
    ])('%s → %s', async (path, code) => {
      const err = await fetchError(fetcher, `${a.origin}${path}`);
      expect(err.code).toBe(code);
      expect(a.hits.get(path)).toBe(1);
      expect(a.hits.get('/ok')).toBeUndefined();
    });

    it('最多跟随 3 跳', async () => {
      const ok = await fetcher(`${a.origin}/chain/3`);
      expect(ok.status).toBe(200);
      expect(ok.redirects).toBe(3);
      expect(ok.body.toString()).toBe('chain-end');

      const err = await fetchError(fetcher, `${a.origin}/chain/4`);
      expect(err.code).toBe('TOO_MANY_REDIRECTS');
      expect(a.hits.get('/chain/0')).toBe(1); // 只来自上面成功的那次
    });

    it('maxRedirects 可以调小，但不能超过 3', async () => {
      expect((await fetchError(fetcher, `${a.origin}/chain/1`, { maxRedirects: 0 })).code).toBe('TOO_MANY_REDIRECTS');
      expect((await fetchError(fetcher, `${a.origin}/chain/4`, { maxRedirects: 10 })).code).toBe('TOO_MANY_REDIRECTS');
    });

    it('303 改用 GET；HEAD 保持 HEAD', async () => {
      const res = await fetcher(`${a.origin}/see-other`);
      expect(res.body.toString()).toBe('GET');
      await fetcher(`${a.origin}/see-other`, { method: 'HEAD' });
      expect(a.lastMethod.get('/method')).toBe('HEAD');
    });

    it('重定向响应的 body 不读（对方不结束也不会卡住）', async () => {
      const res = await fetcher(`${a.origin}/redirect-with-body`, { timeoutMs: 3000 });
      expect(res.status).toBe(200);
      expect(res.body.toString()).toBe('hello');
    });

    const credentialHeaders = {
      Authorization: 'Bearer upstream-key',
      Cookie: 'sid=abc',
      'X-Api-Key': 'k-123',
      Referer: 'https://resource.example.com/',
      'User-Agent': 'PrismTest/1.0',
    };

    it('同源重定向保留请求头', async () => {
      const res = await fetcher(`${a.origin}/to-same-origin`, { headers: credentialHeaders });
      const echoed = JSON.parse(res.body.toString());
      expect(echoed.authorization).toBe('Bearer upstream-key');
      expect(echoed['x-api-key']).toBe('k-123');
    });

    it('跨源重定向只保留 UA/Accept/Referer，凭据类请求头不带去别的站', async () => {
      const res = await fetcher(`${a.origin}/to-peer`, { headers: credentialHeaders });
      expect(res.url).toBe(`${b.origin}/echo-headers`);
      const echoed = JSON.parse(res.body.toString());
      expect(echoed.authorization).toBeUndefined();
      expect(echoed.cookie).toBeUndefined();
      expect(echoed['x-api-key']).toBeUndefined();
      expect(echoed.referer).toBe('https://resource.example.com/');
      expect(echoed['user-agent']).toBe('PrismTest/1.0');
    });
  });

  describe('请求头过滤', () => {
    it('逐跳头、Host 覆盖、含换行的值被丢掉，其余照发', async () => {
      const res = await fetcher(`${a.origin}/echo-headers`, {
        headers: {
          Host: 'internal.admin',
          'Content-Length': '999',
          'Transfer-Encoding': 'chunked',
          Connection: 'upgrade',
          'Proxy-Authorization': 'Basic x',
          'Accept-Encoding': 'zstd',
          'X-Injected': 'a\r\nX-Evil: 1',
          'Bad Name': 'v',
          'X-Ok': 'fine',
        },
      });
      const echoed = JSON.parse(res.body.toString());
      expect(echoed.host).toBe(`127.0.0.1:${a.port}`);
      expect(echoed['content-length']).toBeUndefined();
      expect(echoed['transfer-encoding']).toBeUndefined();
      expect(echoed['proxy-authorization']).toBeUndefined();
      expect(echoed['x-injected']).toBeUndefined();
      expect(echoed['x-evil']).toBeUndefined();
      expect(echoed['accept-encoding']).toBe('gzip, deflate, br');
      expect(echoed['x-ok']).toBe('fine');
    });
  });

  describe('响应体大小上限（按解压后计算）', () => {
    it('分块传输超过上限', async () => {
      const err = await fetchError(fetcher, `${a.origin}/big`, { maxBytes: 1024 * 1024 });
      expect(err.code).toBe('RESPONSE_TOO_LARGE');
    });

    it('Content-Length 声明超过上限，直接拒绝', async () => {
      const err = await fetchError(fetcher, `${a.origin}/big-declared`, { maxBytes: 1024 * 1024 });
      expect(err.code).toBe('RESPONSE_TOO_LARGE');
    });

    it('gzip 解压炸弹（32 KB → 32 MiB）在解压到上限时中止', async () => {
      const before = process.memoryUsage().arrayBuffers;
      const err = await fetchError(fetcher, `${a.origin}/gzip-bomb`, { maxBytes: 1024 * 1024 });
      expect(err.code).toBe('RESPONSE_TOO_LARGE');
      // 没有把 32 MiB 全部解出来
      expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(16 * 1024 * 1024);
    });

    it('上限以内的大响应可以正常读完', async () => {
      const res = await fetcher(`${a.origin}/big`, { maxBytes: 8 * 1024 * 1024 });
      expect(res.body.length).toBe(64 * 64 * 1024);
    });
  });

  describe('解压', () => {
    it.each(['/gzip', '/deflate', '/br'])('%s', async (path) => {
      const res = await fetcher(`${a.origin}${path}`);
      expect(JSON.parse(res.body.toString())).toEqual({ ok: path.slice(1) });
    });

    it('不支持的 Content-Encoding', async () => {
      const err = await fetchError(fetcher, `${a.origin}/zstd`);
      expect(err.code).toBe('UNSUPPORTED_ENCODING');
      expectSafeMessage(err);
    });

    it('损坏的 gzip 给固定文案，不带响应内容', async () => {
      const err = await fetchError(fetcher, `${a.origin}/corrupt-gzip`);
      expect(err.code).toBe('BAD_RESPONSE');
      expectSafeMessage(err);
    });
  });

  describe('超时与连接错误', () => {
    it('迟迟不响应：按总时限中止', async () => {
      const started = Date.now();
      const err = await fetchError(fetcher, `${a.origin}/hang`, { timeoutMs: 300 });
      expect(err.code).toBe('TIMEOUT');
      expect(Date.now() - started).toBeLessThan(3000);
    });

    it('响应体慢速滴灌：总时限同样生效', async () => {
      const err = await fetchError(fetcher, `${a.origin}/trickle`, { timeoutMs: 300 });
      expect(err.code).toBe('TIMEOUT');
    });

    it('读到一半连接断开', async () => {
      const err = await fetchError(fetcher, `${a.origin}/hang-up`, { timeoutMs: 3000 });
      expect(err.code).toBe('CONNECTION_RESET');
      expectSafeMessage(err);
    });

    it('连接被拒绝', async () => {
      const closed = await startServer();
      const port = closed.port;
      await closed.close();
      const err = await fetchError(fetcher, `http://127.0.0.1:${port}/`, { timeoutMs: 3000 });
      expect(err.code).toBe('CONNECTION_REFUSED');
      expectSafeMessage(err);
    });
  });
});
