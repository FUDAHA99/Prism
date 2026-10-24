import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '../../..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/deploy.yml'), 'utf8');
const start = workflow.indexOf('            [[ "$PRISM_DEPLOY_SHA" =~');
const end = workflow.indexOf('            PRISM_NGINX_CONF_BACKUP="$BAK" bash', start);
const selection = workflow.slice(start, end);
const bash = process.platform === 'win32'
  ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe')
  : 'bash';

describe('CI 部署绑定通过检查的提交（假 Git，不提交、不联网）', () => {
  it('把 workflow SHA 显式传给远端，并在部署前后核对 HEAD', () => {
    expect(workflow).toContain('PRISM_DEPLOY_SHA: ${{ github.sha }}');
    expect(workflow).toContain('envs: PRISM_DEPLOY_SHA');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(workflow.slice(end)).toContain('[ "$(git rev-parse HEAD)" = "$PRISM_DEPLOY_SHA" ]');
    expect(workflow).not.toContain('git pull origin main');
  });

  it.each([
    ['fast-forward', 0],
    ['dirty', 1],
    ['wrong-fetch', 1],
    ['diverged', 1],
    ['ahead', 1],
  ])('%s 时只允许准确的已验证 SHA 继续', (scenario, status) => {
    const result = spawnSync(bash, ['--noprofile', '--norc', '-c', `
      set -euo pipefail
      scenario="$1"
      PRISM_DEPLOY_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
      head=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
      restore_nginx_conf() { :; }
      git() {
        case "$1 $2" in
          'status --porcelain') if [ "$scenario" = dirty ]; then echo ' M app.ts'; fi ;;
          'fetch origin') [ "$3" = "$PRISM_DEPLOY_SHA" ] ;;
          'rev-parse FETCH_HEAD')
            if [ "$scenario" = wrong-fetch ]; then echo "$head"; else echo "$PRISM_DEPLOY_SHA"; fi ;;
          'merge --ff-only')
            [ "$scenario" != diverged ] || return 1
            if [ "$scenario" != ahead ]; then head="$3"; fi ;;
          'rev-parse HEAD') echo "$head" ;;
          *) return 99 ;;
        esac
      }
      ${selection}
      printf 'selected=%s\\n' "$head"
    `, 'deploy-revision-test', scenario], { encoding: 'utf8', timeout: 10_000 });
    if (result.error) throw result.error;
    expect(result.status).toBe(status);
    if (status === 0) expect(result.stdout).toContain(`selected=${'a'.repeat(40)}`);
    else expect(result.stdout).not.toContain('selected=');
  });
});
