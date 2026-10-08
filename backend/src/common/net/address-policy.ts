import { isIP } from 'net';

/**
 * 出站请求的目标地址策略：只允许公网单播地址。
 *
 * 采集源 apiUrl、上游返回的封面地址都由外部控制，服务端代为请求时必须挡住
 * 回环、内网、链路本地（169.254.169.254 云元数据）、CGNAT、组播与各类保留段，
 * 否则后台就成了打内网的跳板（SSRF）。
 *
 * 这里只做纯函数判定，真正的拦截在 safe-fetch.ts：IP 字面量在发请求前判定，
 * 域名在建连时对 DNS 解析出的每个地址判定（与实际连接的是同一个地址，防 DNS rebinding）。
 *
 * 各函数返回「拦截原因」标签（只用于服务端日志），null 表示放行。
 */

type V4Block = readonly [base: string, prefix: number, label: string];

/** IANA IPv4 Special-Purpose Address Registry 里非全球可达的段 */
const V4_BLOCKS: readonly V4Block[] = [
  ['0.0.0.0', 8, 'this-network'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'cgnat'], // 含阿里云元数据 100.100.100.200
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local'], // 含 AWS/GCP/Azure/腾讯云等元数据 169.254.169.254
  ['172.16.0.0', 12, 'private'], // 含 Docker 默认网段
  ['192.0.0.0', 24, 'ietf-protocol'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, '6to4-relay'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'], // 含 255.255.255.255
];

type V6Block = readonly [base: string, prefix: number, label: string];

/** IPv6 里需要整段拦截的范围（内嵌 IPv4 的几类单独处理） */
const V6_BLOCKS: readonly V6Block[] = [
  ['::', 96, 'ipv4-compatible'], // 已废弃的 ::a.b.c.d；:: 与 ::1 在前面单独给出标签
  ['::ffff:0:0:0', 96, 'ipv4-translated'],
  ['64:ff9b:1::', 48, 'nat64-local'],
  ['100::', 64, 'discard'],
  ['2001::', 23, 'ietf-special'], // 含 Teredo 2001::/32、benchmarking、ORCHID
  ['2001:db8::', 32, 'documentation'],
  ['3fff::', 20, 'documentation'],
  ['5f00::', 16, 'srv6-sid'],
  ['fc00::', 7, 'unique-local'], // 含 AWS IMDS 的 fd00:ec2::254
  ['fe80::', 10, 'link-local'],
  ['fec0::', 10, 'site-local'],
  ['ff00::', 8, 'multicast'],
];

/**
 * 不在公网 DNS 里、只可能解析到内部的名字（RFC 6761 / 6762 / 8375 与常见内网后缀）。
 * 解析后的 IP 检查才是真正的防线，这里是纵深防御，并让错误更早、更明确。
 */
const RESERVED_NAME_SUFFIXES: readonly string[] = [
  'localhost',
  'local',
  'internal',
  'localdomain',
  'home.arpa',
  'lan',
  'home',
  'corp',
  'intranet',
  'test',
  'invalid',
  'example',
  'onion',
];

/** 规范点分十进制 IPv4 → 无符号 32 位整数；不是规范形式时返回 null */
export function parseIPv4(ip: string): number | null {
  if (isIP(ip) !== 4) return null;
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/** IPv6 → 8 个 16 位分组；支持 :: 缩写、末尾内嵌 IPv4、zone id（%eth0，丢弃） */
export function parseIPv6(ip: string): number[] | null {
  const bare = ip.split('%')[0];
  if (isIP(bare) !== 6) return null;

  let text = bare;
  const tail: number[] = [];
  const lastColon = text.lastIndexOf(':');
  const lastPart = text.slice(lastColon + 1);
  if (lastPart.includes('.')) {
    const v4 = parseIPv4(lastPart);
    if (v4 === null) return null;
    tail.push(v4 >>> 16, v4 & 0xffff);
    // 保留末尾冒号，让 "::a.b.c.d" 变成 "::" 后正常处理
    text = text.slice(0, lastColon + 1);
    if (text.endsWith(':') && !text.endsWith('::')) text = text.slice(0, -1);
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const toGroups = (s: string) => (s === '' ? [] : s.split(':').map((h) => parseInt(h, 16)));
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  const explicit = head.length + rest.length + tail.length;

  let groups: number[];
  if (halves.length === 2) {
    if (explicit > 7) return null;
    groups = [...head, ...new Array(8 - explicit).fill(0), ...rest, ...tail];
  } else {
    groups = [...head, ...tail];
  }
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) {
    return null;
  }
  return groups;
}

function v4InBlock(ip: number, base: string, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ((ip & mask) >>> 0) === ((parseIPv4(base)! & mask) >>> 0);
}

function v6InBlock(groups: number[], base: string, prefix: number): boolean {
  const baseGroups = parseIPv6(base)!;
  let bits = prefix;
  for (let i = 0; i < 8 && bits > 0; i++) {
    const take = Math.min(16, bits);
    const mask = (0xffff << (16 - take)) & 0xffff;
    if ((groups[i] & mask) !== (baseGroups[i] & mask)) return false;
    bits -= take;
  }
  return true;
}

function classifyIPv4Number(ip: number): string | null {
  for (const [base, prefix, label] of V4_BLOCKS) {
    if (v4InBlock(ip, base, prefix)) return label;
  }
  return null;
}

function embeddedV4(hi: number, lo: number): number {
  return ((hi << 16) | lo) >>> 0;
}

function classifyIPv6Groups(g: number[]): string | null {
  const zeroUpTo = (n: number) => g.slice(0, n).every((x) => x === 0);

  if (zeroUpTo(8)) return 'unspecified';
  if (zeroUpTo(7) && g[7] === 1) return 'loopback';

  // ::ffff:a.b.c.d（IPv4-mapped）：按内嵌的 IPv4 判定，[::ffff:127.0.0.1] 与 127.0.0.1 同等对待
  if (zeroUpTo(5) && g[5] === 0xffff) {
    const reason = classifyIPv4Number(embeddedV4(g[6], g[7]));
    return reason ? `ipv4-mapped:${reason}` : null;
  }
  // 64:ff9b::/96（NAT64 well-known prefix）：经 NAT64 网关到达内嵌的 IPv4
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    const reason = classifyIPv4Number(embeddedV4(g[6], g[7]));
    return reason ? `nat64:${reason}` : null;
  }
  // 2002::/16（6to4）：第 2、3 组是内嵌的 IPv4
  if (g[0] === 0x2002) {
    const reason = classifyIPv4Number(embeddedV4(g[1], g[2]));
    return reason ? `6to4:${reason}` : null;
  }

  for (const [base, prefix, label] of V6_BLOCKS) {
    if (v6InBlock(g, base, prefix)) return label;
  }
  // 全球单播只分配在 2000::/3，其余都是未分配/保留
  if ((g[0] & 0xe000) !== 0x2000) return 'reserved';
  return null;
}

/**
 * 判定一个 IP 地址（规范形式，如 dns.lookup 的返回值）。
 * 返回拦截原因；null 表示公网地址、可以访问。不是合法 IP 一律拦截。
 */
export function classifyIp(ip: string): string | null {
  const text = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip;
  const v4 = parseIPv4(text);
  if (v4 !== null) return classifyIPv4Number(v4);
  const v6 = parseIPv6(text);
  if (v6 !== null) return classifyIPv6Groups(v6);
  return 'invalid-ip';
}

/**
 * 主机名按 WHATWG URL 规则规范化（与 Node 发请求时看到的一致）：
 * 小写、IDN 转 punycode、IPv4 的各种写法（0x7f.1、2130706433、017700000001、127.1）
 * 统一成点分十进制、IPv6 去掉方括号。无法解析时返回 null。
 */
export function canonicalHostname(host: string): string | null {
  let h = (host ?? '').trim();
  if (!h) return null;
  if (isIP(h) === 6) h = `[${h}]`;
  // 带端口的输入（默认端口会被 URL 吞掉，靠 url.port 查不出来）
  if (h.startsWith('[') ? !h.endsWith(']') : h.includes(':')) return null;
  let url: URL;
  try {
    url = new URL(`http://${h}/`);
  } catch {
    return null;
  }
  // 只接受「纯主机名」：带端口、路径、userinfo 的输入说明调用方传错了东西
  if (url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    return null;
  }
  const name = url.hostname;
  return name.startsWith('[') && name.endsWith(']') ? name.slice(1, -1) : name;
}

/**
 * 判定域名本身（不做 DNS）：单标签名（localhost、Docker 服务名 mysql/redis/backend 等）
 * 与保留后缀直接拦截。传入应是 canonicalHostname 之后、非 IP 的名字。
 */
export function classifyDomainName(name: string): string | null {
  const bare = name.toLowerCase().replace(/\.$/, '');
  if (!bare) return 'empty-host';
  if (!bare.includes('.')) return bare === 'localhost' ? 'localhost' : 'single-label';
  for (const suffix of RESERVED_NAME_SUFFIXES) {
    if (bare === suffix || bare.endsWith(`.${suffix}`)) return `reserved-name:${suffix}`;
  }
  return null;
}

/**
 * 判定 URL 里的主机部分：IP 字面量直接判定；域名只做名字检查，
 * 解析出的地址要在建连时再判定（见 safe-fetch.ts）。null 表示可以继续。
 */
export function classifyHostname(host: string): string | null {
  const name = canonicalHostname(host);
  if (name === null) return 'invalid-host';
  if (isIP(name)) return classifyIp(name);
  return classifyDomainName(name);
}
