import * as fs from 'fs';
import * as path from 'path';
import { REGISTER_SETTING_KEY, REGISTRATION_OPEN_STARTUP_WARNING } from './registration-policy';

/**
 * 升级上来的安装公开注册仍开着（1-F-3 复审 low）：旧版本写入的 enable_register 默认值是 'true'，initDefaults 只补缺失的键。
 * 两处提醒，都只读、从不修改：backend 启动时一行 WARN（site-setting.http.spec.ts 覆盖），scripts/deploy.sh 例行部署时
 * 在 mysql 容器里只读查询一次，开着就打出 docs/deploy.md 5.3 ⑥ 的关闭方法。
 *
 * 这里静态锁住 deploy.sh 那一步的性质；它在 bash 里的实际行为（开 / 关 / 缺行 / 查询失败四种情况、退出码）
 * 用桩 docker 跑过一遍，见提交说明。
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const script = fs.readFileSync(path.join(REPO_ROOT, 'scripts/deploy.sh'), 'utf8');
const deployDoc = fs.readFileSync(path.join(REPO_ROOT, 'docs/deploy.md'), 'utf8');

/** 函数体：从 `name() {` 到下一个行首的 `}` */
function functionBody(name: string): string {
  const start = script.indexOf(`\n${name}() {`);
  expect(start).toBeGreaterThan(0);
  return script.slice(start, script.indexOf('\n}\n', start) + 2);
}

const CLOSE_SQL = "UPDATE site_settings SET value = 'false' WHERE `key` = 'enable_register';";

describe('scripts/deploy.sh：例行部署只读检查公开注册开关', () => {
  const body = functionBody('check_register_switch');
  const main = script.slice(script.indexOf('\nmain() {'));

  it('查询只读：只有一条 SELECT，查的就是 backend 判断注册开关用的那个键', () => {
    const sql = /^REGISTER_SWITCH_SQL="(.*)"$/m.exec(script)?.[1];
    expect(sql).toBe("SELECT value FROM site_settings WHERE \\`key\\` = 'enable_register';");
    expect(sql).toContain(`'${REGISTER_SETTING_KEY}'`);
    expect(sql).not.toMatch(/\b(UPDATE|INSERT|DELETE|REPLACE|ALTER|DROP)\b/i);
    // 函数里能写库的语句只出现在给人看的提示文字里，从不执行
    const executable = body
      .split('\n')
      .filter((line) => !/^\s*(#|warn |log )/.test(line))
      .join('\n');
    expect(executable).not.toMatch(/\b(UPDATE|INSERT|DELETE|REPLACE)\b/);
  });

  it('在 mysql 容器里执行，库名 / 账号 / 口令取自容器自己的环境变量（单引号，宿主机不展开）', () => {
    expect(body).toContain('$COMPOSE exec -T mysql sh -c');
    expect(body).toContain(`'exec mysql --default-character-set=utf8mb4 -N -B -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"'`);
    expect(body).toContain('<<<"$REGISTER_SWITCH_SQL"');
  });

  it('不中止部署：查询失败只警告并 return 0，函数里没有 die / exit', () => {
    expect(body).not.toMatch(/\bdie\b|\bexit\b/);
    expect(body).toMatch(/if ! value=\$\(\$COMPOSE exec[\s\S]*?\); then\n\s*warn "[^"]*"\n\s*return 0\n\s*fi/);
  });

  it("只有值恰好是 'true' 才提醒（与 backend 的 registrationOpenFrom 相同），提醒里给出 5.3 ⑥ 的关闭方法", () => {
    expect(body).toContain('if [ "$value" = "true" ]; then');
    const warnings = body.split('\n').filter((line) => line.trim().startsWith('warn '));
    expect(warnings.join('\n')).toContain('系统配置 → 功能设置');
    expect(warnings.join('\n')).toContain(CLOSE_SQL.replace(/`/g, '\\`'));
    expect(warnings.join('\n')).toContain('docs/deploy.md 5.3 ⑥');
    expect(warnings.join('\n')).toContain('不会替你修改');
  });

  it('只在例行部署、backend 就绪并补齐系统角色之后执行（首次部署是新库，种子值就是 false）', () => {
    const call = main.indexOf('\n    check_register_switch\n');
    expect(call).toBeGreaterThan(0);
    expect(main.indexOf('backend 已就绪')).toBeLessThan(call);
    expect(main.indexOf('seed-admin.js --roles-only;')).toBeLessThan(call);
    // 位于 `if ! $first_deploy; then … fi` 里
    const routine = main.indexOf('if ! $first_deploy; then');
    expect(routine).toBeGreaterThan(0);
    expect(routine).toBeLessThan(call);
    expect(main.slice(routine, call)).not.toMatch(/\n  fi\n/);
    const code = main
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    expect(code.match(/\bcheck_register_switch\b/g)).toHaveLength(1);
  });

  it('docs/deploy.md 5.3 ⑥ 里有同一条关闭语句与只读查询；backend 启动提醒指向同一节', () => {
    const section = deployDoc.slice(deployDoc.indexOf('**⑥ 公开注册'));
    expect(section).toContain(CLOSE_SQL);
    expect(section).toContain("SELECT `key`, value FROM site_settings WHERE `key` = 'enable_register';");
    expect(REGISTRATION_OPEN_STARTUP_WARNING).toContain('docs/deploy.md 5.3 ⑥');
    expect(REGISTRATION_OPEN_STARTUP_WARNING).toContain('系统配置 → 功能设置');
  });
});
