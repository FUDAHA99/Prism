import * as fs from 'fs';
import * as path from 'path';

/**
 * 审计动作名的前后端一致性（批次 1-F-1 跟进）。
 *
 * 后台「操作日志」按 action 精确筛选（AuditService.findAll → WHERE action = ?）。筛选下拉里写错一个名字，
 * 对应的操作就永远查不到 —— 此前的 ROLE_ASSIGN 后端从未写过，而角色分配实际写的是
 * USER_ASSIGN_ROLES / USER_REMOVE_ROLES。这里从后端源码里静态取出每个 auditService.log 调用写入的
 * action，与 frontend/src/pages/AuditLog/index.tsx 的 ACTION_GROUPS 清单逐项比对。
 */

const SRC_ROOT = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(SRC_ROOT, '../..');
const AUDIT_LOG_PAGE = path.join(REPO_ROOT, 'frontend', 'src', 'pages', 'AuditLog', 'index.tsx');

function walkFiles(dir: string, accept: (file: string) => boolean): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkFiles(full, accept);
    return accept(full) ? [full] : [];
  });
}

/** 从 `(` 之后开始，取到与之配对的 `)` 为止的调用参数文本 */
function callArguments(text: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < text.length; i++) {
    if (text[i] === '(') depth++;
    if (text[i] === ')' && --depth === 0) return text.slice(openParen + 1, i);
  }
  throw new Error('括号不配对');
}

interface AuditCall {
  file: string;
  /** action 属性的表达式原文 */
  expression: string | null;
  actions: string[];
}

/** 后端源码里每个 auditService.log({...}) 调用，以及其 action 表达式中出现的全部字符串字面量 */
function scanBackendAuditCalls(): AuditCall[] {
  const files = walkFiles(SRC_ROOT, (f) => f.endsWith('.ts') && !/\.(spec|test)\.ts$/.test(f));
  const calls: AuditCall[] = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\bauditService\s*\.\s*log\s*\(/g)) {
      const args = callArguments(text, (m.index ?? 0) + m[0].length - 1);
      const expression = /(?:^|[\s,{])action\s*:\s*([^\n]+?)\s*,?\s*$/m.exec(args)?.[1] ?? null;
      const actions = expression ? [...expression.matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((a) => a[1]) : [];
      calls.push({ file: path.relative(REPO_ROOT, file).replace(/\\/g, '/'), expression, actions });
    }
  }
  return calls;
}

/** 前端筛选清单 ACTION_GROUPS 里的 [动作名, 说明] */
function scanFrontendOptions(): string[] {
  const text = fs.readFileSync(AUDIT_LOG_PAGE, 'utf8');
  const start = text.indexOf('const ACTION_GROUPS');
  const end = text.indexOf('const ACTION_OPTIONS');
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return [...text.slice(start, end).matchAll(/\[\s*'([A-Z][A-Z0-9_]*)'\s*,\s*'[^']+'\s*\]/g)].map((m) => m[1]);
}

describe('审计动作名：后台筛选项与后端实际写入的一致', () => {
  const calls = scanBackendAuditCalls();
  const backendActions = [...new Set(calls.flatMap((c) => c.actions))].sort();

  it('后端每个 auditService.log 调用的 action 都能静态解析为字符串字面量', () => {
    expect(calls.length).toBeGreaterThan(40); // 防止扫描规则失效后测试变空
    expect(
      calls
        .filter((c) => c.actions.length === 0 || !/^(?:'[A-Z][A-Z0-9_]*'|[\w.]+ \? '[A-Z][A-Z0-9_]*' : '[A-Z][A-Z0-9_]*')$/.test(c.expression ?? ''))
        .map((c) => `${c.file}: action: ${c.expression}`),
    ).toEqual([]);
  });

  it('角色分配写的是 USER_ASSIGN_ROLES / USER_REMOVE_ROLES，不存在 ROLE_ASSIGN', () => {
    expect(backendActions).toEqual(expect.arrayContaining(['USER_ASSIGN_ROLES', 'USER_REMOVE_ROLES', 'USER_CHANGE_PASSWORD']));
    expect(backendActions).not.toContain('ROLE_ASSIGN');
  });

  it('frontend 操作日志页的筛选项与后端写入的动作名完全一致（不多不少、不重复）', () => {
    const options = scanFrontendOptions();
    expect(options.length).toBe(new Set(options).size);
    expect({
      后端写了但筛选里没有: backendActions.filter((a) => !options.includes(a)),
      筛选里有但后端从不写: options.filter((a) => !backendActions.includes(a)).sort(),
    }).toEqual({ 后端写了但筛选里没有: [], 筛选里有但后端从不写: [] });
  });
});
