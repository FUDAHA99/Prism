import { ValidateBy, ValidateIf, ValidationOptions } from 'class-validator';
import { TransformFnParams } from 'class-transformer';

/** MySQL INT 列的取值范围：超出时库报 Out of range（500），这里先 400 */
export const INT_MIN = -2_147_483_648;
export const INT_MAX = 2_147_483_647;

/** 与后台编辑页的 Slug 校验一致（frontend/src/pages/Movie/MovieForm.tsx） */
export const MOVIE_SLUG_PATTERN = /^[a-z0-9-]+$/;

/** 一部影视在一次请求里最多带多少条线路、一条线路最多多少集（请求体本身还受 100kb 的 JSON 上限约束） */
export const MOVIE_MAX_SOURCES = 50;
export const MOVIE_MAX_EPISODES_PER_SOURCE = 2000;

/** 非空列：没提交（undefined）就不改；提交了 null 照常校验（于是 400），不能把 NOT NULL 列写成 null（500） */
export const unlessUndefined = ValidateIf((_object: unknown, value: unknown) => value !== undefined);

/**
 * 布尔字段只认 JSON 的 true / false：返回请求体里的原始值，交给 IsBoolean 判定。
 * 全局开了 enableImplicitConversion，不这样做的话字符串 "false" 会被 Boolean("false") 转成 true。
 */
export const rawValue = ({ obj, key }: TransformFnParams): unknown => (obj as Record<string, unknown>)[key];

/**
 * 去掉浏览器解析 URL 时会忽略的字符后看协议头：开头的控制字符 / 空白，以及任意位置的 Tab 与换行
 * （"java\tscript:" 在浏览器里就是 javascript:）。
 */
const DANGEROUS_SCHEME = /^(?:javascript|vbscript|data|file):/i;
export function hasDangerousScheme(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return DANGEROUS_SCHEME.test(value.replace(/^[\u0000- ]+/, '').replace(/[\t\n\r]/g, ''));
}

/**
 * 剧集播放 / 下载地址：协议不做白名单（m3u8 / mp4 直链、磁力链、网盘分享页、站内路径都有，采集来的也原样入库），
 * 只拒绝能在页面里执行脚本或读本地文件的协议（javascript: / vbscript: / data: / file:）。
 */
export function IsSafeMediaUrl(validationOptions?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isSafeMediaUrl',
      validator: {
        validate: (value: unknown) => typeof value === 'string' && !hasDangerousScheme(value),
        defaultMessage: (args) => `${args.property} 不能使用 javascript: / vbscript: / data: / file: 协议`,
      },
    },
    validationOptions,
  );
}
