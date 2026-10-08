/**
 * 苹果 CMS V10 (MacCMS) JSON API 客户端
 *
 * 标准接口形态：
 *   列表：  {apiUrl}?ac=videolist&pg=1&h=24&t=1
 *           - ac:      videolist（标准列表）
 *           - pg:      页码
 *           - h:       最近 N 小时（增量）
 *           - t:       type_id（分类筛选）
 *           - wd:      关键词
 *           - ids:     vod_id 单/多条
 *   详情：  {apiUrl}?ac=detail&ids=1,2,3
 *
 * 返回结构（JSON）：
 *   {
 *     code: 1,
 *     msg: "数据列表",
 *     page: 1,
 *     pagecount: 100,
 *     limit: "20",
 *     total: 1234,
 *     list: [ { vod_id, vod_name, vod_play_url, ... } ]
 *   }
 */

import { CollectSource, CollectSourceType } from './entities/collect-source.entity';
import { SafeFetch, SafeFetchError, safeFetch } from '../../common/net/safe-fetch';
import { HEADER_VALUE_RE, sanitizeOutgoingHeaders } from '../../common/net/http-headers';

export interface MacCmsListParams {
  page?: number;
  hours?: number;       // h
  typeId?: string;      // t
  keyword?: string;     // wd
  ids?: string;         // ids（单条或逗号分隔）
}

export interface MacCmsItem {
  vod_id: number | string;
  vod_name: string;
  vod_sub?: string;
  vod_en?: string;
  type_id: number | string;
  type_name: string;
  vod_pic?: string;
  vod_actor?: string;
  vod_director?: string;
  vod_writer?: string;
  vod_blurb?: string;
  vod_remarks?: string;
  vod_pubdate?: string;
  vod_total?: number;
  vod_serial?: string;
  vod_year?: string;
  vod_area?: string;
  vod_lang?: string;
  vod_content?: string;
  vod_play_from?: string;   // "ckm3u8$$$kkm3u8"
  vod_play_url?: string;    // "第1集$url1#第2集$url2$$$..."
  vod_score?: string;
  vod_time?: string;
  vod_hits?: number;
  [k: string]: any;
}

export interface MacCmsListResponse {
  code: number;
  msg: string;
  page: number;
  pagecount: number;
  limit: string | number;
  total: number;
  list: MacCmsItem[];
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 (CMS-Collector/1.0)';

/** 单次接口响应（解压后）的上限：一页 detail 通常几十到几百 KB */
export const MACCMS_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * 采集过程中可以原样展示给后台的错误：文案由我们自己写，不含上游响应内容。
 * detail 只进服务端日志。
 */
export class CollectError extends Error {
  readonly detail?: string;

  constructor(message: string, detail?: string) {
    super(message);
    this.name = 'CollectError';
    this.detail = detail;
  }
}

/**
 * 返回给客户端（测试连接、探查分类、采集日志）的错误文案。
 * 只有 SafeFetchError / CollectError 的固定文案会透出；其他异常（数据库、代码缺陷）一律用 fallback，
 * 细节看服务端日志。此前「返回非 JSON」会把响应体前 200 字符拼进错误，等于把内网服务的内容带回给调用方。
 */
export function collectErrorMessage(
  err: unknown,
  fallback = '采集请求失败（内部错误，详见服务端日志）',
): string {
  if (err instanceof SafeFetchError) return `请求采集接口失败：${err.message}`;
  if (err instanceof CollectError) return err.message;
  return fallback;
}

/** 只用于服务端日志的错误描述（含被拦截的地址等），不要返回给客户端 */
export function collectErrorLogDetail(err: unknown): string {
  if (err instanceof SafeFetchError) return `${err.code}${err.detail ? ` ${err.detail}` : ''}`;
  if (err instanceof CollectError) return `${err.message}${err.detail ? ` (${err.detail})` : ''}`;
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

function buildQuery(params: Record<string, any>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.append(k, String(v));
  }
  return sp.toString();
}

function timeoutMsOf(source: CollectSource): number {
  const sec = Number(source.timeoutSec);
  const safeSec = Number.isFinite(sec) && sec > 0 ? Math.min(sec, 600) : 30;
  return safeSec * 1000;
}

function userAgentOf(source: CollectSource): string {
  const ua = source.userAgent;
  return typeof ua === 'string' && ua && ua.length <= 500 && HEADER_VALUE_RE.test(ua) ? ua : DEFAULT_UA;
}

/** 描述一段解析失败的响应：只给字节数与粗略类型，不回显内容 */
function describeNonJson(text: string, bytes: number): string {
  const head = text.trimStart().slice(0, 1);
  const hint = head === '<' ? '，内容像是 HTML/XML 页面，请检查接口地址与接口类型' : '';
  return `采集接口返回的不是 JSON（${bytes} 字节${hint}）`;
}

/**
 * 拉取列表（含详情：MacCMS 标准 list 不含 vod_play_url，必须 ac=detail 才有）
 * 我们这里用 ac=detail 一次性拿详细数据 —— 接近所有资源站都支持。
 *
 * 出站请求统一走 safe-fetch：只允许公网 http/https、建连时校验解析出的 IP、
 * 逐跳校验重定向（最多 3 跳）、总时限 = 采集源的超时设置、响应体上限 8 MiB。
 * fetcher 参数只给测试注入用。
 */
export async function fetchMacCmsList(
  source: CollectSource,
  params: MacCmsListParams,
  fetcher: SafeFetch = safeFetch,
): Promise<MacCmsListResponse> {
  if (source.sourceType !== CollectSourceType.MACCMS_JSON) {
    throw new CollectError(
      `当前实现仅支持 maccms_json，源 [${source.name}] 类型为 ${source.sourceType}`,
    );
  }

  const qs = buildQuery({
    ac: 'detail',
    pg: params.page ?? 1,
    h: params.hours,
    t: params.typeId,
    wd: params.keyword,
    ids: params.ids,
  });

  const url = source.apiUrl.includes('?')
    ? `${source.apiUrl}&${qs}`
    : `${source.apiUrl}?${qs}`;

  const headers: Record<string, string> = {
    'user-agent': userAgentOf(source),
    accept: 'application/json, text/plain, */*',
    // 库里可能有加校验之前写入的旧数据：非对象、逐跳头、含换行的值都会被丢掉
    ...sanitizeOutgoingHeaders(source.extraHeaders),
  };

  const res = await fetcher(url, {
    method: 'GET',
    headers,
    timeoutMs: timeoutMsOf(source),
    maxBytes: MACCMS_MAX_RESPONSE_BYTES,
  });
  if (res.status < 200 || res.status >= 300) {
    // 不带 statusText：那也是对方可控的文本
    throw new CollectError(`采集接口返回 HTTP ${res.status}`);
  }
  // 与 fetch 的 res.text() 一致：按 UTF-8 解码并去掉 BOM（不少 PHP 站点会输出 BOM）
  const text = res.body.toString('utf8').replace(/^\uFEFF/, '');
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CollectError(describeNonJson(text, res.body.length));
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new CollectError('采集接口返回的 JSON 不是对象');
  }
  return {
    code: Number(json.code ?? 0),
    msg: String(json.msg ?? ''),
    page: Number(json.page ?? params.page ?? 1),
    pagecount: Number(json.pagecount ?? 1),
    limit: json.limit ?? 20,
    total: Number(json.total ?? (json.list || []).length),
    list: Array.isArray(json.list) ? json.list : [],
  };
}

/**
 * 解析 MacCMS 的 vod_play_from / vod_play_url 为 [线路, 剧集列表]
 *
 * vod_play_from = "ckm3u8$$$kkm3u8"
 * vod_play_url  = "第1集$http://a.m3u8#第2集$http://b.m3u8$$$第1集$http://x.m3u8#第2集$http://y.m3u8"
 *
 * 返回：[{ name:"ckm3u8", episodes:[{title,url,episodeNumber}] }, ...]
 */
export interface ParsedSource {
  name: string;
  episodes: { title: string; url: string; episodeNumber: number }[];
}

export function parsePlayData(
  playFrom: string | undefined,
  playUrl: string | undefined,
): ParsedSource[] {
  if (!playFrom || !playUrl) return [];
  const fromList = playFrom.split('$$$');
  const urlGroups = playUrl.split('$$$');
  const out: ParsedSource[] = [];

  for (let i = 0; i < fromList.length; i++) {
    const name = (fromList[i] || '').trim();
    if (!name) continue;
    const group = urlGroups[i] || '';
    const items = group.split('#').filter(Boolean);
    const episodes = items.map((item, idx) => {
      const [titleRaw, urlRaw] = item.split('$');
      const title = (titleRaw || `第${idx + 1}集`).trim();
      const url = (urlRaw || '').trim();
      // 尝试从 title 解析集数（"第1集" / "01" / "1"）
      const m = title.match(/(\d+)/);
      const episodeNumber = m ? parseInt(m[1], 10) : idx + 1;
      return { title, url, episodeNumber };
    }).filter((e) => e.url);
    out.push({ name, episodes });
  }
  return out;
}

/**
 * 把字符串类的可能值转 number / null
 */
export function toIntOrNull(v: any): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export function toFloatOrNull(v: any): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

export function toDateOrNull(v: any): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * 生成稳定的 slug：source-id-外站vodId（避免不同源撞 slug）
 */
export function buildCollectSlug(sourcePrefix: string, vodId: any): string {
  return `c-${sourcePrefix}-${vodId}`;
}
