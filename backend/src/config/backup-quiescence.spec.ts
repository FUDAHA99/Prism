import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const backup = path.resolve(__dirname, '../../../scripts/backup.sh');
const bash = process.platform === 'win32'
  ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe')
  : 'bash';

describe('备份在读取配置或导出数据前要求 backend 停止', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-backup-quiescence-'));
    fs.copyFileSync(backup, path.join(dir, 'backup.sh'));
    // 只执行真实编排脚本；容器与配置读取均为替身，绝不读取真实环境文件或调用 Docker。
    fs.writeFileSync(path.join(dir, 'backup-common.sh'), `
      PROJECT_DIR="$PWD"
      BACKUP_DIR="$PWD/backup"
      BACKEND_ID=backend
      REDIS_ID=redis
      lock_backup() { mkdir -p "$BACKUP_DIR"; }
      load_containers() { :; }
      die() { printf '%s\\n' "$*" >&2; exit 1; }
      require_state() {
        if [[ "$1" = backend && "$2" = false && "$PRISM_TEST_BACKEND_RUNNING" = true ]]; then
          printf 'backend must be stopped\\n' >&2
          exit 42
        fi
      }
      collect_config() {
        printf 'reached collection\\n' > "$PROJECT_DIR/collection-attempted"
        exit 79
      }
    `);
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it.each([['true', 42], ['false', 79]] as const)(
    'backend running=%s 时在正确阶段停止隔离夹具', (running, status) => {
      const result = spawnSync(bash, ['--noprofile', '--norc', './backup.sh'], {
        cwd: dir, encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, BACKUP_KEEP: '7', PRISM_TEST_BACKEND_RUNNING: running },
      });
      if (result.error) throw result.error;
      expect(result.status).toBe(status);
      expect(fs.existsSync(path.join(dir, 'collection-attempted'))).toBe(running === 'false');
      if (running === 'true') expect(result.stderr).toContain('backend must be stopped');
    },
  );
});
