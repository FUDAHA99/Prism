import * as dns from 'dns';
import * as http from 'http';
import * as https from 'https';
import { isIP, LookupFunction } from 'net';
import * as zlib from 'zlib';
import { classifyDomainName, classifyIp } from './address-policy';
import { sanitizeOutgoingHeaders } from './http-headers';

/**
 * 服务端代为请求外部 URL（采集接口、封面检测等）的唯一出口。
 *
 * - 只允许 http/https；
 * - IP 字面量发请求前判定；域名在**建连时**由自定义 lookup 判定 DNS 解析出的每个地址，
 *   判定的地址就是随后连接的地址，DNS rebinding 无法在「检查」与「连接」之间换 IP；
 * - 不自动跟随重定向：每一跳都重新做协议与地址检查，最多 3 跳；跨源跳转只保留无害请求头；
 * - 总时限覆盖所有跳与读 body；响应体按解压后的字节数限长（防解压炸弹）；
 * - 错误只有固定的中文文案（SafeFetchError.message），绝不包含响应体；
 *   被拦截的地址等细节放在 detail 里，只用于服务端日志。
 *
 * 用 node:http/https 而不是全局 fetch：全局 fetch（undici）没法换连接时的 DNS 解析，
 * 而 undici 包本身不在依赖里；http.request 的 lookup 选项是稳定 API。
 * 注意 Node 对 IP 字面量不调用 lookup，所以 IP 必须在发请求前单独判定（assertAllowedUrl）。
 *
 * 已知边界：不限制端口（目标是挡内网，公网地址的任意端口都允许）；不读 HTTP(S)_PROXY 环境变量。
 */

export type SafeFetchErrorCode =
  | 'INVALID_URL'
  | 'UNSUPPORTED_PROTOCOL'
  | 'BLOCKED_ADDRESS'
  | 'TOO_MANY_REDIRECTS'
  | 'TIMEOUT'
  | 'RESPONSE_TOO_LARGE'
  | 'UNSUPPORTED_ENCODING'
  | 'DNS_FAILED'
  | 'CONNECTION_REFUSED'
  | 'CONNECTION_RESET'
  | 'UNREACHABLE'
  | 'TLS_ERROR'
  | 'BAD_RESPONSE'
  | 'INVALID_HEADER'
  | 'NETWORK';

const ERROR_MESSAGES: Record<SafeFetchErrorCode, string> = {
  INVALID_URL: '地址格式不正确',
  UNSUPPORTED_PROTOCOL: '只允许 http/https 地址',
  BLOCKED_ADDRESS: '目标地址指向内网、本机或保留地址，已拦截',
  TOO_MANY_REDIRECTS: '重定向次数超过上限',
  TIMEOUT: '请求超时',
  RESPONSE_TOO_LARGE: '响应内容超过大小上限',
  UNSUPPORTED_ENCODING: '响应使用了不支持的压缩格式',
  DNS_FAILED: '域名解析失败',
  CONNECTION_REFUSED: '连接被拒绝',
  CONNECTION_RESET: '连接被中断',
  UNREACHABLE: '目标主机不可达',
  TLS_ERROR: 'TLS 证书校验失败',
  BAD_RESPONSE: '对方返回的响应格式不正确',
  INVALID_HEADER: '请求头不合法',
  NETWORK: '网络请求失败',
};

export class SafeFetchError extends Error {
  readonly code: SafeFetchErrorCode;
  /** 仅供服务端日志（被拦截的 IP、底层错误码等），不要返回给客户端 */
  readonly detail?: string;

  constructor(code: SafeFetchErrorCode, detail?: string) {
    super(ERROR_MESSAGES[code]);
    this.name = 'SafeFetchError';
    this.code = code;
    this.detail = detail;
  }
}

export interface SafeFetchOptions {
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
  /** 总时限（毫秒），覆盖全部重定向与读取响应体。默认 10s，上限 10 分钟 */
  timeoutMs?: number;
  /** 解压后的响应体字节上限，默认 5 MiB */
  maxBytes?: number;
  /** 最多跟随几次重定向，默认且最多 3 */
  maxRedirects?: number;
}

export interface SafeFetchResponse {
  status: number;
  /** 最终地址（跟随重定向之后） */
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  redirects: number;
}

export type SafeFetch = (url: string, options?: SafeFetchOptions) => Promise<SafeFetchResponse>;

type ResolveAll = (
  hostname: string,
  options: dns.LookupAllOptions,
  callback: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void,
) => void;

/** 可注入的依赖：只供测试替换（伪造 DNS 结果、允许回环地址上的测试服务器） */
export interface SafeFetchDeps {
  resolve?: ResolveAll;
  /** 地址策略：返回拦截原因，null 放行。默认 classifyIp */
  classifyAddress?: (ip: string) => string | null;
}

export const SAFE_FETCH_MAX_REDIRECTS = 3;
export const SAFE_FETCH_DEFAULT_TIMEOUT_MS = 10_000;
export const SAFE_FETCH_MAX_TIMEOUT_MS = 600_000;
export const SAFE_FETCH_DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** 跨源重定向后只保留这些请求头：Authorization / Cookie / API key 类附加头不能带去别的站 */
const CROSS_ORIGIN_SAFE_HEADERS = new Set(['user-agent', 'accept', 'accept-language', 'referer']);

const defaultResolve: ResolveAll = (hostname, options, callback) =>
  dns.lookup(hostname, options, callback);

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function bareHostname(url: URL): string {
  const h = url.hostname;
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

/** 每一跳都要过的检查：协议 + 主机（IP 字面量直接判定；域名先做名字检查，地址留给建连时） */
function assertAllowedUrl(url: URL, classifyAddress: (ip: string) => string | null): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SafeFetchError('UNSUPPORTED_PROTOCOL', url.protocol);
  }
  const host = bareHostname(url);
  // Node 对 IP 字面量不会调用 lookup，所以 IP 必须在这里判定
  const reason = isIP(host) ? classifyAddress(host) : classifyDomainName(host);
  if (reason) throw new SafeFetchError('BLOCKED_ADDRESS', `${host} (${reason})`);
}

/**
 * 建连时的 DNS 解析：解析出的地址只要有一个不是公网地址就整体拒绝
 * （同时解析到公网与内网的域名本身就可疑）。兼容 autoSelectFamily 的 all: true 调用。
 */
function guardedLookup(
  resolve: ResolveAll,
  classifyAddress: (ip: string) => string | null,
): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0);
      if (!addresses || addresses.length === 0) {
        const notFound: NodeJS.ErrnoException = new Error('no address');
        notFound.code = 'ENOTFOUND';
        return callback(notFound, '', 0);
      }
      for (const a of addresses) {
        const reason = classifyAddress(a.address);
        if (reason) {
          return callback(
            new SafeFetchError('BLOCKED_ADDRESS', `${hostname} -> ${a.address} (${reason})`),
            '',
            0,
          );
        }
      }
      if (options.all) return callback(null, addresses);
      return callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

function toSafeFetchError(err: unknown): SafeFetchError {
  if (err instanceof SafeFetchError) return err;
  const e = err as NodeJS.ErrnoException | undefined;
  const code = typeof e?.code === 'string' ? e.code : '';
  const detail = code || e?.name || 'unknown';
  if (['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_FAIL', 'EAI_NODATA'].includes(code)) {
    return new SafeFetchError('DNS_FAILED', detail);
  }
  if (code === 'ECONNREFUSED') return new SafeFetchError('CONNECTION_REFUSED', detail);
  if (['ECONNRESET', 'EPIPE', 'ECONNABORTED'].includes(code) || e?.message === 'aborted') {
    return new SafeFetchError('CONNECTION_RESET', detail);
  }
  if (code === 'ETIMEDOUT') return new SafeFetchError('TIMEOUT', detail);
  if (['EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN', 'ENETDOWN', 'EADDRNOTAVAIL'].includes(code)) {
    return new SafeFetchError('UNREACHABLE', detail);
  }
  // HPE_*：HTTP 解析错误；Z_*：gzip/deflate 解压错误；ERR__ERROR_*：brotli 解压错误
  if (code.startsWith('HPE_') || code.startsWith('Z_') || code.startsWith('ERR__ERROR')) {
    return new SafeFetchError('BAD_RESPONSE', detail);
  }
  if (code.startsWith('ERR_TLS') || code.startsWith('ERR_SSL') || /CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)/.test(code)) {
    return new SafeFetchError('TLS_ERROR', detail);
  }
  if (['ERR_INVALID_CHAR', 'ERR_INVALID_HTTP_TOKEN', 'ERR_HTTP_INVALID_HEADER_VALUE'].includes(code)) {
    return new SafeFetchError('INVALID_HEADER', detail);
  }
  return new SafeFetchError('NETWORK', detail);
}

interface HopResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

interface HopOptions {
  method: 'GET' | 'HEAD';
  headers: Record<string, string>;
  deadline: number;
  maxBytes: number;
  lookup: LookupFunction;
}

const EMPTY = Buffer.alloc(0);

function createDecoder(encoding: string): zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | null | undefined {
  // 与 undici 一致：容忍截断的压缩流
  const flush = { flush: zlib.constants.Z_SYNC_FLUSH, finishFlush: zlib.constants.Z_SYNC_FLUSH };
  switch (encoding) {
    case '':
    case 'identity':
      return null;
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip(flush);
    case 'deflate':
      return zlib.createInflate(flush);
    case 'br':
      return zlib.createBrotliDecompress();
    default:
      return undefined; // 不支持
  }
}

/** 发一跳请求。重定向响应不读 body；连接在拿到结果后立即销毁（不复用、不排空） */
function requestOnce(url: URL, opts: HopOptions): Promise<HopResult> {
  return new Promise<HopResult>((resolve, reject) => {
    const remaining = opts.deadline - Date.now();
    if (remaining <= 0) {
      reject(new SafeFetchError('TIMEOUT'));
      return;
    }

    let settled = false;
    let req: http.ClientRequest | undefined;
    let res: http.IncomingMessage | undefined;
    let decoder: zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | null | undefined;

    const settle = (err: unknown, value?: HopResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 成功或失败都直接断开：避免对方继续推送数据占着连接
      decoder?.destroy();
      res?.destroy();
      req?.destroy();
      if (err) reject(toSafeFetchError(err));
      else resolve(value!);
    };
    const timer = setTimeout(() => settle(new SafeFetchError('TIMEOUT')), remaining);

    const mod = url.protocol === 'https:' ? https : http;
    const requestOptions: https.RequestOptions = {
      protocol: url.protocol,
      hostname: bareHostname(url),
      port: url.port ? Number(url.port) : undefined,
      path: `${url.pathname || '/'}${url.search}`,
      method: opts.method,
      headers: {
        'accept-encoding': 'gzip, deflate, br',
        ...opts.headers,
      },
      // 不用全局 keep-alive Agent：复用的连接可能不是经过本次 lookup 检查建立的
      agent: false,
      lookup: opts.lookup,
    };
    try {
      if (url.username || url.password) {
        requestOptions.auth = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
      }
    } catch {
      settle(new SafeFetchError('INVALID_URL', 'malformed userinfo'));
      return;
    }

    try {
      req = mod.request(requestOptions);
    } catch (err) {
      settle(err);
      return;
    }

    req.on('error', (err) => settle(err));
    req.on('response', (incoming) => {
      res = incoming;
      incoming.on('error', (err) => settle(err));
      // 对方在 body 读完前断开：没有 'end'，只有 'close'
      incoming.on('close', () => {
        if (!incoming.complete) settle(new SafeFetchError('CONNECTION_RESET', 'closed before end'));
      });
      const status = incoming.statusCode ?? 0;
      const headers = incoming.headers;

      const isRedirect = REDIRECT_STATUSES.has(status) && typeof headers.location === 'string';
      if (isRedirect || opts.method === 'HEAD' || status === 204 || status === 304) {
        settle(null, { status, headers, body: EMPTY });
        return;
      }

      const encoding = String(headers['content-encoding'] ?? '').trim().toLowerCase();
      decoder = createDecoder(encoding);
      if (decoder === undefined) {
        settle(new SafeFetchError('UNSUPPORTED_ENCODING', encoding.slice(0, 50)));
        return;
      }
      const declared = Number(headers['content-length']);
      if (!decoder && Number.isFinite(declared) && declared > opts.maxBytes) {
        settle(new SafeFetchError('RESPONSE_TOO_LARGE', `content-length ${declared}`));
        return;
      }

      const stream: NodeJS.ReadableStream = decoder ? incoming.pipe(decoder) : incoming;
      if (decoder) decoder.on('error', (err) => settle(err));
      const chunks: Buffer[] = [];
      let total = 0;
      stream.on('data', (chunk: Buffer) => {
        if (settled) return;
        total += chunk.length;
        if (total > opts.maxBytes) {
          settle(new SafeFetchError('RESPONSE_TOO_LARGE', `> ${opts.maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      stream.on('end', () => settle(null, { status, headers, body: Buffer.concat(chunks, total) }));
    });
    req.end();
  });
}

/** 构造一个 safeFetch；生产代码只用下面导出的 safeFetch，参数只给测试注入用 */
export function createSafeFetch(deps: SafeFetchDeps = {}): SafeFetch {
  const classifyAddress = deps.classifyAddress ?? classifyIp;
  const lookup = guardedLookup(deps.resolve ?? defaultResolve, classifyAddress);

  return async function safeFetchImpl(rawUrl, options = {}) {
    let current: URL;
    try {
      current = new URL(rawUrl);
    } catch {
      throw new SafeFetchError('INVALID_URL');
    }
    assertAllowedUrl(current, classifyAddress);

    const timeoutMs = clamp(options.timeoutMs, 1, SAFE_FETCH_MAX_TIMEOUT_MS, SAFE_FETCH_DEFAULT_TIMEOUT_MS);
    const maxBytes = clamp(options.maxBytes, 0, Number.MAX_SAFE_INTEGER, SAFE_FETCH_DEFAULT_MAX_BYTES);
    const maxRedirects = clamp(options.maxRedirects, 0, SAFE_FETCH_MAX_REDIRECTS, SAFE_FETCH_MAX_REDIRECTS);
    const deadline = Date.now() + timeoutMs;
    let method: 'GET' | 'HEAD' = options.method === 'HEAD' ? 'HEAD' : 'GET';
    let headers = sanitizeOutgoingHeaders(options.headers);

    for (let hop = 0; ; hop++) {
      const res = await requestOnce(current, { method, headers, deadline, maxBytes, lookup });
      const location = res.headers.location;
      if (!REDIRECT_STATUSES.has(res.status) || typeof location !== 'string') {
        return { status: res.status, url: current.href, headers: res.headers, body: res.body, redirects: hop };
      }
      if (hop >= maxRedirects) {
        throw new SafeFetchError('TOO_MANY_REDIRECTS', `> ${maxRedirects}`);
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new SafeFetchError('BAD_RESPONSE', 'invalid Location');
      }
      assertAllowedUrl(next, classifyAddress);
      if (next.origin !== current.origin) {
        headers = Object.fromEntries(
          Object.entries(headers).filter(([name]) => CROSS_ORIGIN_SAFE_HEADERS.has(name)),
        );
      }
      if (res.status === 303 && method !== 'HEAD') method = 'GET';
      current = next;
    }
  };
}

export const safeFetch: SafeFetch = createSafeFetch();
