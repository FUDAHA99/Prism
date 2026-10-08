/**
 * 把 CORS_ORIGIN（逗号分隔）解析成 cors 库可用的白名单数组。
 *
 * cors@2.8.5 对字符串白名单做严格 ===（cors/lib/index.js isOriginAllowed），
 * 而浏览器发出的 Origin 头永远是「协议://小写主机[:非默认端口]」，不带路径
 * 和末尾斜杠。所以 "https://a.com/"、逗号后带空格的 " https://b.com"、
 * "https://A.com"、"https://a.com:443" 过去都会静默失配。
 * 这里统一 trim + URL.origin 归一化，丢弃空项和非 http(s) 项，并通过 warn 回调逐条报告。
 *
 * 返回空数组时仍是 fail-closed：不会下发 Access-Control-Allow-Origin。
 */
export function parseCorsOrigins(
  raw: string | undefined,
  warn: (message: string) => void = () => undefined,
): string[] {
  const origins: string[] = [];
  for (const item of (raw ?? '').split(',')) {
    const entry = item.trim();
    if (!entry) continue;

    let url: URL | null = null;
    try {
      url = new URL(entry);
    } catch {
      url = null;
    }
    // "example.com" 解析直接抛错；"localhost:3000" 会被解析成协议 "localhost:"
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      warn(
        `CORS_ORIGIN 忽略无法识别的项 "${entry}"：需写完整的 http(s) 地址，如 https://example.com`,
      );
      continue;
    }

    const origin = url.origin;
    if (origin !== entry) {
      warn(
        `CORS_ORIGIN 项 "${entry}" 已归一化为 "${origin}"（浏览器 Origin 头不含路径与末尾斜杠）`,
      );
    }
    if (!origins.includes(origin)) origins.push(origin);
  }
  return origins;
}
