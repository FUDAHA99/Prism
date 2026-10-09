#!/usr/bin/env node
// 依赖审计门禁：把 npm audit（官方源）的结果，与 .github/audit-allowlist.json 里按 GHSA 编号登记的例外逐条比对。
//
//   node scripts/audit-gate.mjs <backend|frontend|portal> [--registry=https://registry.npmjs.org]
//
// 退出码：
//   0  通过：生产依赖（--omit=dev）的公告全部已登记且未过期。开发依赖的公告只报告，不阻断。
//   1  要有人处理：生产依赖出现未登记的公告、登记已过期，或例外清单本身写错。
//   2  门禁给不出结论：参数不对，或 npm audit 没拿到有效报告（源不支持 audit，如 npmmirror；网络故障；输出无法解析）。
//
// 只读 lockfile，不需要先 npm ci；零依赖（CI 的这个 job 只装了 node）。
// 不用 npm audit --audit-level：next 14 的 critical 没有 14.x 修复版本，按级别卡会永远是红的；
// 而且按级别卡没法逐条豁免，也没有到期复查，还会把新出现的低级别公告一起藏起来。
// 例外清单格式：{ "<项目>": [{ "id": "GHSA-…", "package": "…", "reason": "…", "expires": "YYYY-MM-DD" }] }，
// 到期日当天仍有效（按 UTC 日期），次日起失败。
import { execFileSync, execSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OFFICIAL = 'https://registry.npmjs.org';
const PROJECTS = ['backend', 'frontend', 'portal'];
const ALLOWLIST = join(ROOT, '.github', 'audit-allowlist.json');
const SEVERITY_ORDER = ['critical', 'high', 'moderate', 'low', 'info'];

const inActions = Boolean(process.env.GITHUB_ACTIONS);
// 工作流命令的消息要转义 % 和换行，否则 GitHub 会截断或误解析
const escapeCommand = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, 300);
function annotate(level, message) {
  console.log(inActions ? `::${level}::${escapeCommand(message)}` : `[${level}] ${message}`);
}
function usage(problem) {
  annotate('error', `${problem}。用法：node scripts/audit-gate.mjs <${PROJECTS.join('|')}> [--registry=${OFFICIAL}]`);
  process.exit(2);
}

// ── 参数 ──────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
const flags = argv.filter((a) => a.startsWith('--'));
const unknownFlags = flags.filter((a) => !a.startsWith('--registry='));
if (positional.length !== 1 || !PROJECTS.includes(positional[0])) usage(`项目名不对：${positional.join(' ') || '（未给）'}`);
if (unknownFlags.length) usage(`不认识的参数：${unknownFlags.join(' ')}`);
const project = positional[0];
const registryFlag = flags.find((a) => a.startsWith('--registry='));
const registry = (registryFlag ? registryFlag.slice('--registry='.length) : OFFICIAL).replace(/\/+$/, '');
// Windows 上要经 shell 启动 npm.cmd，registry 会拼进命令串，所以只放行 URL 里常见的字符
if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~%-]*)*$/.test(registry)) usage(`registry 不是合法的 http(s) 地址：${registry}`);

// ── 例外清单 ──────────────────────────────────────────────────────
const today = new Date().toISOString().slice(0, 10); // UTC 日期
const isDate = (s) =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) &&
  new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const isGhsa = (s) => typeof s === 'string' && /^GHSA(-[0-9a-z]{4}){3}$/.test(s);
const nonEmpty = (s) => typeof s === 'string' && s.trim() !== '';

let failed = false;
const allow = new Map(); // id → entry
(function loadAllowlist() {
  if (!existsSync(ALLOWLIST)) {
    annotate('warning', `${project}: 没有找到 .github/audit-allowlist.json，按空清单处理`);
    return;
  }
  let data;
  try {
    data = JSON.parse(readFileSync(ALLOWLIST, 'utf8'));
  } catch (e) {
    failed = true;
    annotate('error', `${project}: .github/audit-allowlist.json 不是合法 JSON：${oneLine(e.message)}`);
    return;
  }
  const list = data?.[project] ?? [];
  if (!Array.isArray(list)) {
    failed = true;
    annotate('error', `${project}: .github/audit-allowlist.json 里 "${project}" 必须是数组`);
    return;
  }
  list.forEach((entry, i) => {
    const where = `.github/audit-allowlist.json ${project}[${i}]`;
    const problems = [];
    if (!isGhsa(entry?.id)) problems.push(`id 必须是 GHSA-xxxx-xxxx-xxxx（现在是 ${JSON.stringify(entry?.id)}）`);
    if (!nonEmpty(entry?.package)) problems.push('缺少 package');
    if (!nonEmpty(entry?.reason)) problems.push('缺少 reason（为什么现在不修、什么时候修）');
    if (!isDate(entry?.expires)) problems.push(`expires 必须是 YYYY-MM-DD（现在是 ${JSON.stringify(entry?.expires)}）`);
    if (isGhsa(entry?.id) && allow.has(entry.id)) problems.push(`${entry.id} 重复登记`);
    if (problems.length) {
      failed = true;
      annotate('error', `${project}: ${where} 格式不对：${problems.join('；')}`);
      return;
    }
    allow.set(entry.id, entry);
  });
})();

// ── npm audit ─────────────────────────────────────────────────────
function runAudit(scope) {
  const args = ['audit', '--json', `--registry=${registry}`, scope === 'prod' ? '--omit=dev' : '--include=dev'];
  const options = {
    cwd: join(ROOT, project),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    timeout: 180_000,
  };
  let stdout = '';
  let stderr = '';
  let spawnProblem = '';
  try {
    // Windows 上 npm 是 npm.cmd，只能经 shell 启动；参数是上面拼好的固定值（registry 已校验字符集），
    // 拼成一条命令串，避免新版 Node 对「shell: true 加参数数组」的弃用告警
    stdout = process.platform === 'win32' ? execSync(`npm ${args.join(' ')}`, options) : execFileSync('npm', args, options);
  } catch (e) {
    // 有漏洞时 npm audit 的退出码就是非 0，stdout 里仍是完整报告，从异常对象里取
    stdout = String(e.stdout ?? '');
    stderr = String(e.stderr ?? '');
    if (e.signal || e.code === 'ETIMEDOUT' || e.code === 'ENOENT' || e.code === 'ENOBUFS') {
      spawnProblem = `npm 没能正常跑完（${e.code ?? ''} ${e.signal ?? ''}）`;
    }
  }
  let report = null;
  try {
    report = JSON.parse(stdout);
  } catch {
    report = null;
  }
  const dependencyCount = report?.metadata?.dependencies?.total;
  if (
    spawnProblem || !report || report.error || report.message ||
    typeof report.auditReportVersion !== 'number' || !(dependencyCount > 0)
  ) {
    // npmmirror 返回的是 {message: '404 … [NOT_IMPLEMENTED] …', error: {summary: ''}}：
    // summary 是空串，必须用 || 往后取，用 ?? 会停在空串上，报错信息就成了空的
    const detail = spawnProblem || report?.error?.summary || report?.message || stderr || stdout || 'npm 没有任何输出';
    annotate(
      'error',
      `${project}: npm audit（${scope === 'prod' ? '生产依赖' : '全部依赖'}）没有拿到有效报告，registry=${registry}。` +
        `审计只能走 ${OFFICIAL}，npmmirror 等镜像站没有实现审计接口。原因：${oneLine(detail)}`,
    );
    if (process.env.GITHUB_STEP_SUMMARY) {
      const note = `### 依赖审计：${project}（无法给出结论）\n\nnpm audit 没有拿到有效报告，见本步骤的报错。\n\n`;
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, note);
    }
    process.exit(2);
  }
  const advisories = new Map(); // GHSA id → { id, pkg, severity, title, url, range }
  for (const vuln of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vuln.via ?? []) {
      // via 里的字符串表示「经由另一个受影响的包」，公告本身记在那个包自己的条目里
      if (!via || typeof via !== 'object') continue;
      const id = String(via.url ?? '').split('/').pop() || `npm-${via.source}`;
      if (!advisories.has(id)) {
        advisories.set(id, { id, pkg: via.name, severity: via.severity, title: via.title, url: via.url, range: via.range });
      }
    }
  }
  return { advisories, counts: report.metadata.vulnerabilities ?? {} };
}

const prod = runAudit('prod');
const full = runAudit('full');

// ── 比对 ──────────────────────────────────────────────────────────
const rows = []; // { rank, status, a, note }
let unregistered = 0;
let expired = 0;
for (const a of prod.advisories.values()) {
  const entry = allow.get(a.id);
  if (!entry) {
    failed = true;
    unregistered++;
    annotate(
      'error',
      `${project}: 生产依赖有未登记的公告 ${a.id}（${a.severity}，${a.pkg} ${a.range}）：${a.title} ${a.url}。` +
        '能升级就升级；暂时修不了的，在 .github/audit-allowlist.json 登记理由和到期日',
    );
    rows.push({ rank: 0, status: '未登记，阻断', a, note: a.title });
    continue;
  }
  if (entry.package !== a.pkg) {
    annotate('warning', `${project}: ${a.id} 登记的 package 是 ${entry.package}，audit 报的是 ${a.pkg}，检查是不是贴错了编号`);
  }
  if (entry.expires < today) {
    failed = true;
    expired++;
    annotate(
      'error',
      `${project}: ${a.id}（${a.pkg}）的例外已于 ${entry.expires} 到期。重新评估：能修就修；` +
        `修不了就更新 reason 并顺延 expires。原理由：${entry.reason}`,
    );
    rows.push({ rank: 1, status: '登记已过期，阻断', a, note: `${entry.reason}（到期 ${entry.expires}）` });
    continue;
  }
  rows.push({ rank: 3, status: '已登记', a, note: `${entry.reason}（到期 ${entry.expires}）` });
}
for (const entry of allow.values()) {
  if (prod.advisories.has(entry.id)) continue;
  const devHit = full.advisories.get(entry.id);
  const why = devHit ? '现在只出现在开发依赖里（开发依赖不阻断）' : 'audit 已不再报告';
  annotate('warning', `${project}: 例外 ${entry.id}（${entry.package}）${why}，可以从 .github/audit-allowlist.json 删掉`);
  rows.push({
    rank: 2,
    status: '清单多余，可删',
    a: devHit ?? { id: entry.id, pkg: entry.package, severity: '-', title: '', url: '' },
    note: why,
  });
}
const devOnly = [...full.advisories.values()].filter((a) => !prod.advisories.has(a.id) && !allow.has(a.id));
if (devOnly.length) {
  annotate(
    'notice',
    `${project}: 开发依赖另有 ${devOnly.length} 条公告（不阻断）：${devOnly.map((a) => `${a.pkg}/${a.id}`).join(' ')}`,
  );
}

// ── 汇总表（GitHub 的 Step Summary）───────────────────────────────
const sevRank = (s) => (SEVERITY_ORDER.includes(s) ? SEVERITY_ORDER.indexOf(s) : SEVERITY_ORDER.length);
const bySeverity = (x, y) => sevRank(x.severity) - sevRank(y.severity) || x.pkg.localeCompare(y.pkg) || x.id.localeCompare(y.id);
// 表格单元格：| 会拆列；<Link> 这类尖括号会被 GitHub 当成 HTML 标签吞掉
const cell = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const link = (a) => (a.url ? `[${a.id}](${a.url})` : a.id);
const counts = (c) =>
  `${c.total ?? 0} 个包（critical ${c.critical ?? 0} / high ${c.high ?? 0} / moderate ${c.moderate ?? 0} / low ${c.low ?? 0}）`;
const verdict = failed ? '失败' : '通过';

if (process.env.GITHUB_STEP_SUMMARY) {
  rows.sort((x, y) => x.rank - y.rank || bySeverity(x.a, y.a));
  const lines = [
    `### 依赖审计：${project}（${verdict}）`,
    '',
    `registry：${registry}；日期：${today}（UTC）`,
    '',
    `受影响：生产依赖 ${counts(prod.counts)}；全部依赖 ${counts(full.counts)}。`,
    '',
  ];
  if (rows.length) {
    lines.push('| 状态 | 公告 | 级别 | 包 | 说明 |', '|---|---|---|---|---|');
    for (const r of rows) lines.push(`| ${r.status} | ${link(r.a)} | ${r.a.severity} | ${cell(r.a.pkg)} | ${cell(r.note)} |`);
  } else {
    lines.push('生产依赖没有公告，例外清单里也没有本项目的条目。');
  }
  if (devOnly.length) {
    lines.push('', `<details><summary>只在开发依赖里的公告 ${devOnly.length} 条（不阻断）</summary>`, '');
    lines.push('| 公告 | 级别 | 包 | 标题 |', '|---|---|---|---|');
    for (const a of devOnly.sort(bySeverity)) lines.push(`| ${link(a)} | ${a.severity} | ${cell(a.pkg)} | ${cell(a.title)} |`);
    lines.push('', '</details>');
  }
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n\n`);
}

console.log(
  `${project}: ${verdict}。生产依赖公告 ${prod.advisories.size} 条（已登记 ${prod.advisories.size - unregistered}，` +
    `其中过期 ${expired}；未登记 ${unregistered}）；开发依赖另有 ${devOnly.length} 条（不阻断）`,
);
process.exit(failed ? 1 : 0);
