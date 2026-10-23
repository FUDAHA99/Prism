import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gzipSync } from 'zlib';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const COMMON = path.join(REPO_ROOT, 'scripts/backup-common.sh').replace(/\\/g, '/');
// Windows 的系统 bash.exe 是 WSL 启动器；这些测试需要 Git Bash 自带的 GNU 工具。
const BASH = process.platform === 'win32'
  ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe')
  : 'bash';
const PAYLOADS = ['mysql.sql.gz', 'uploads.tar.gz', 'redis.rdb', 'config.tar.gz', 'tls.tar.gz', 'format'];

describe('备份公共校验（隔离假数据，不连接 Docker）', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-backup-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function run(body: string, ...args: string[]) {
    const result = spawnSync(BASH, ['--noprofile', '--norc', '-c', `
      docker() { printf 'Unexpected Docker call\\n' >&2; return 99; }
      source "$1"
      shift
      PROJECT_DIR=$PWD
      BACKUP_DIR="$PWD/backup"
      ${body}
    `, 'backup-test', COMMON, ...args], { cwd: dir, encoding: 'utf8', timeout: 10_000 });
    if (result.error) throw result.error;
    expect(result.stderr).not.toContain('Unexpected Docker call');
    return result;
  }

  function expectSuccess(body: string, ...args: string[]) {
    const result = run(body, ...args);
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  }

  // 最小 ustar 夹具：只生成内存中的条目，绝不创建或提取 .env、链接或特殊文件。
  function archive(name: string, type = '0') {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    for (const offset of [100, 108, 116]) header.write('0000600\0', offset, 'ascii');
    for (const offset of [124, 136]) header.write('00000000000\0', offset, 'ascii');
    header.fill(' ', 148, 156);
    header.write(type, 156, 'ascii');
    if (type === '1' || type === '2') header.write('target', 157, 'ascii');
    header.write('ustar\0', 257, 'ascii');
    header.write('00', 263, 'ascii');
    const checksum = header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0');
    header.write(`${checksum}\0 `, 148, 'ascii');
    fs.writeFileSync(path.join(dir, 'fixture.tar.gz'), gzipSync(Buffer.concat([header, Buffer.alloc(1024)])));
  }

  function bundle(format = 'prism-full-backup-v1') {
    const root = path.join(dir, 'bundle');
    fs.mkdirSync(root);
    for (const name of PAYLOADS) fs.writeFileSync(path.join(root, name), `fixture: ${name}\n`);
    fs.writeFileSync(path.join(root, 'format'), `${format}\n`);
    const manifest = PAYLOADS.map((name) => {
      const hash = createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex');
      return `${hash}  ${name}\n`;
    }).join('');
    fs.writeFileSync(path.join(root, 'SHA256SUMS'), manifest);
    return root;
  }

  it('环境文件允许本地变体，排除示例、模板和非环境文件', () => {
    expectSuccess(`
      for name in .env .env.prod .env.local .env.production.local; do env_name "$name"; done
      for name in .env.example .env.prod.sample .env.local.template .environment config.json; do
        if env_name "$name"; then exit 1; fi
      done
    `);
  });

  it('配置路径只允许四个固定目录的环境文件及明确列出的配置文件', () => {
    expectSuccess(`
      for name in .env.prod backend/.env frontend/.env.local portal/.env.prod docker-compose.prod.yml nginx/nginx.active.conf; do
        config_path "$name"
      done
      for name in ../.env backend/nested/.env uploads/.env backend/.env.example nginx/nginx.conf docker-compose.yml; do
        if config_path "$name"; then exit 1; fi
      done
    `);
  });

  it.each([
    ['.env.prod', '0', 'config'],
    ['backend/.env.local', '0', 'config'],
    ['./images/', '5', 'uploads'],
    ['fullchain.pem', '0', 'tls'],
  ])('接受合法归档条目 %s（类型 %s，范围 %s）', (name, type, scope) => {
    archive(name, type);
    expectSuccess('check_tar fixture.tar.gz "$1"', scope);
  });

  it.each([
    ['../outside', '0', 'uploads', 'Archive contains a traversal path'],
    ['images/../../outside', '0', 'uploads', 'Archive contains a traversal path'],
    ['/outside', '0', 'tls', 'Unsupported archive path'],
    ['images\\outside', '0', 'uploads', 'Unsupported archive path'],
    ['backend/main.ts', '0', 'config', 'Configuration archive exceeds the allowed scope'],
    ['.env.prod', '5', 'config', 'Configuration archive must contain regular files only'],
    ['link', '1', 'uploads', 'Archive contains a link or special file'],
    ['link', '2', 'tls', 'Archive contains a link or special file'],
    ['pipe', '6', 'uploads', 'Archive contains a link or special file'],
  ])('拒绝越界或特殊归档条目 %s（类型 %s）', (name, type, scope, error) => {
    archive(name, type);
    const result = run('check_tar fixture.tar.gz "$1"', scope);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(error);
  });

  it('拒绝损坏的 gzip 文件', () => {
    fs.writeFileSync(path.join(dir, 'fixture.tar.gz'), 'not gzip');
    expect(run('check_tar fixture.tar.gz uploads').status).not.toBe(0);
  });

  it('接受包含六项有效载荷且 SHA256 manifest 完全匹配的 bundle', () => {
    bundle();
    expectSuccess('bundle_checksums_valid bundle');
  });

  it.each(['tampered', 'missing', 'empty', 'extra', 'format', 'manifest'])('拒绝异常 bundle：%s', (change) => {
    const root = bundle(change === 'format' ? 'prism-full-backup-v2' : undefined);
    if (change === 'tampered') fs.appendFileSync(path.join(root, 'redis.rdb'), 'changed');
    if (change === 'missing') fs.renameSync(path.join(root, 'redis.rdb'), path.join(root, 'wrong-name.rdb'));
    if (change === 'empty') fs.writeFileSync(path.join(root, 'redis.rdb'), '');
    if (change === 'extra') fs.writeFileSync(path.join(root, 'unexpected'), 'extra');
    if (change === 'manifest') {
      fs.appendFileSync(path.join(root, 'SHA256SUMS'), `${'0'.repeat(64)}  ../outside\n`);
    }
    // retention 用 if 调用校验：失败必须显式返回，不能依赖 set -e。
    expectSuccess('if bundle_checksums_valid bundle; then exit 1; fi');
  });

  it('接受普通目录树，拒绝缺失目录', () => {
    fs.mkdirSync(path.join(dir, 'tree'));
    fs.writeFileSync(path.join(dir, 'tree/file'), 'fixture');
    expectSuccess('check_tree tree');
    const result = run('check_tree missing');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Missing or linked directory');
  });

  it('退出时释放自己的备份锁', () => {
    expectSuccess('lock_backup; test -d "$BACKUP_DIR/.backup.lock"');
    expect(fs.existsSync(path.join(dir, 'backup/.backup.lock'))).toBe(false);
  });

  it('已有锁时拒绝进入，并保留其他进程的锁', () => {
    fs.mkdirSync(path.join(dir, 'backup/.backup.lock'), { recursive: true });
    const result = run('lock_backup');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Another backup/restore holds the lock');
    expect(fs.existsSync(path.join(dir, 'backup/.backup.lock'))).toBe(true);
  });
});
