import { BadRequestException } from '@nestjs/common';
import { CONTENT_IMAGE_URL_PATTERN } from '../../modules/content/dto/create-content.dto';

/**
 * 编辑接口里「库里可能有历史数据」的字段：只有提交值与库里现值不同时才按新规则校验。
 *
 * 为什么不在 Update DTO 里校验格式：后台编辑页（MovieForm / NovelForm / ComicForm / ContentForm）把表单全部字段作为
 * PATCH 体提交，没改动的海报、封面、评分也在里面。采集入库不经过 DTO，库里有 `upload/vod/a.jpg`（相对路径）、
 * `//img.x.com/a.jpg`、`mac://...`、带首尾空白的地址，以及超过 10 的评分（DECIMAL(3,1) 最高 99.9）。Update DTO 若照
 * 新建的规则校验格式，这类条目改任何一个字段都会 400 —— 对以采集为主的站点，这是后台编辑的主路径。
 *
 * 于是 Update DTO 只校验类型与长度；协议白名单 / 取值范围在 service 里、只对「改过的值」执行：
 * 新写入的 javascript: 等协议照样被拦住，原样回传的旧值放行（它本来就在库里，不因这次保存变得更危险）。
 * 新建（Create DTO）与「修复封面」接口的值都是新值，仍在 DTO 里按完整规则校验。
 */

/** null 与 undefined 视为同一个「空」 */
function sameValue(submitted: unknown, stored: unknown): boolean {
  return (submitted ?? null) === (stored ?? null);
}

/** 图片地址的协议白名单：空串（删除）、http(s) 绝对地址或站内路径，与 CONTENT_IMAGE_URL_PATTERN 一致 */
export function isAllowedImageUrl(value: string): boolean {
  return CONTENT_IMAGE_URL_PATTERN.test(value);
}

/**
 * 逐个检查提交了、且与库里现值不同的图片地址字段：[字段名, 提示里的名称]。
 * 例：`assertChangedImageUrls(dto, movie, [['posterUrl', '海报'], ['trailerUrl', '预告片']])`
 */
export function assertChangedImageUrls(
  submitted: object,
  stored: object,
  fields: ReadonlyArray<readonly [field: string, label: string]>,
): void {
  for (const [field, label] of fields) {
    const value = (submitted as Record<string, unknown>)[field];
    if (value === undefined || value === null) continue;
    if (sameValue(value, (stored as Record<string, unknown>)[field])) continue;
    if (typeof value !== 'string' || !isAllowedImageUrl(value)) {
      throw new BadRequestException(`${label}只能是 http(s) 地址或站内路径（/uploads/...）`);
    }
  }
}

export const SCORE_MIN = 0;
export const SCORE_MAX = 10;

/**
 * 评分：与库里现值相同（按数值比较 —— MySQL 把 DECIMAL 读成字符串 "8.5"，编辑页原样回传）时不检查范围；
 * 改过的值必须在 0–10 之间。类型（有限数字）由 Update DTO 保证。
 */
export function assertChangedScore(submitted: unknown, stored: unknown): void {
  if (submitted === undefined) return;
  const value = Number(submitted);
  if (value === Number(stored)) return;
  if (!(value >= SCORE_MIN && value <= SCORE_MAX)) {
    throw new BadRequestException(`评分只能在 ${SCORE_MIN} 到 ${SCORE_MAX} 之间`);
  }
}
