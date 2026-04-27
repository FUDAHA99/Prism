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

function buildQuery(params: Record<string, any>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.append(k, String(v));
  }
  return sp.toString();
}

/**
 * 拉取列表（含详情：MacCMS 标准 list 不含 vod_play_url，必须 ac=detail 才有）
 * 我们这里用 ac=detail 一次性拿详细数据 —— 接近所有资源站都支持。
 */
export async function fetchMacCmsList(
  source: CollectSource,
  params: MacCmsListParams,
): Promise<MacCmsListResponse> {
  if (source.sourceType !== CollectSourceType.MACCMS_JSON) {
    throw new Error(
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
    'User-Agent': source.userAgent || DEFAULT_UA,
    Accept: 'application/json, text/plain, */*',
    ...(source.extraHeaders || {}),
  };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), (source.timeoutSec || 30) * 1000);

  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`返回非 JSON（前 200 字符）：${text.slice(0, 200)}`);
    }
    if (typeof json !== 'object' || json === null) {
      throw new Error('返回结构非对象');
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
  } finally {
    clearTimeout(t);
  }
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
