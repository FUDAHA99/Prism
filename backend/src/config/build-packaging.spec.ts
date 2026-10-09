import * as fs from 'fs';
import * as path from 'path';

/**
 * 生产构建不带测试文件（1-F-3 E2E info）：此前 nest build 用的是 tsconfig.json，*.spec.ts 与只给测试用的
 * src/common/testing/**（内存 SQLite 的 HTTP 夹具、鉴权探针）都被编译进 dist，再随 Docker 镜像发到生产。
 * 现在 nest build 用 tsconfig.build.json 排除它们；jest（ts-jest）仍按 tsconfig.json 编译并做类型检查。
 *
 * 实际构建产物另外核对过：运行时文件与此前逐字节相同，只少了 *.spec.* 与 common/testing（见提交说明）。
 */

const BACKEND_ROOT = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');
const read = (relative: string) => fs.readFileSync(path.join(BACKEND_ROOT, relative), 'utf8');

describe('backend 构建配置：生产产物不含测试文件', () => {
  const buildConfig = JSON.parse(read('tsconfig.build.json')) as { extends?: string; exclude?: string[] };
  const nestCli = JSON.parse(read('nest-cli.json')) as { compilerOptions?: Record<string, unknown> };
  const pkg = JSON.parse(read('package.json')) as {
    scripts: Record<string, string>;
    jest: { transform: Record<string, unknown>; testRegex: string };
  };

  it('nest build 显式使用 tsconfig.build.json，它继承 tsconfig.json、只多出排除项', () => {
    expect(pkg.scripts.build).toBe('nest build');
    expect(nestCli.compilerOptions?.tsConfigPath).toBe('tsconfig.build.json');
    expect(nestCli.compilerOptions?.deleteOutDir).toBe(true);
    expect(buildConfig.extends).toBe('./tsconfig.json');
    expect(Object.keys(buildConfig).sort()).toEqual(['exclude', 'extends']);
  });

  it('排除项覆盖 jest 认的全部测试文件与测试夹具目录，并保留 tsconfig 默认的排除（node_modules、dist）', () => {
    const exclude = buildConfig.exclude ?? [];
    expect(exclude).toEqual(expect.arrayContaining(['node_modules', 'dist', '**/*.spec.ts', '**/*.test.ts', 'src/common/testing/**']));
    // jest 的 testRegex 认 *.spec.ts 与 *.test.ts，两种都排除了
    expect(pkg.jest.testRegex).toBe('^.+\\.(spec|test)\\.ts$');
  });

  it('jest 仍用 ts-jest 按 tsconfig.json 编译（类型检查覆盖测试文件），没有改指向 tsconfig.build.json', () => {
    expect(pkg.jest.transform).toEqual({ '^.+\\.ts$': 'ts-jest' });
    expect(JSON.stringify(pkg.jest)).not.toContain('tsconfig.build');
  });

  it('运行时代码不引用测试夹具（common/testing 只给 *.spec.ts 用，被排除后构建不会缺文件）', () => {
    const offenders: string[] = [];
    (function walk(dir: string) {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) {
          if (full === path.join(BACKEND_ROOT, 'src', 'common', 'testing')) continue;
          walk(full);
        } else if (/\.ts$/.test(name) && !/\.(spec|test)\.ts$/.test(name)) {
          if (/from '[^']*common\/testing[^']*'|from '\.\.?\/testing\//.test(fs.readFileSync(full, 'utf8'))) {
            offenders.push(path.relative(BACKEND_ROOT, full));
          }
        }
      }
    })(path.join(BACKEND_ROOT, 'src'));
    expect(offenders).toEqual([]);
  });

  it('Docker 镜像与 CI 走的是同一个 npm run build，构建上下文里带着 tsconfig.build.json 与 nest-cli.json', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toMatch(/^COPY \. \.$/m);
    expect(dockerfile).toMatch(/^RUN npm run build$/m);
    const dockerignore = read('.dockerignore')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const pattern of dockerignore) {
      expect({ pattern, hidesBuildConfig: /tsconfig|nest-cli|^\*\.json$/.test(pattern) }).toEqual({ pattern, hidesBuildConfig: false });
    }
    const ci = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/deploy.yml'), 'utf8');
    expect(ci).toMatch(/working-directory: \$\{\{ matrix\.project \}\}\n\s+run: npm run build/);
  });
});

describe('原生依赖与镜像基础版本的匹配（批次 2 / 3A 复审）', () => {
  it('镜像仍是 node:20 时，better-sqlite3 必须精确锁定在 12.9.0（12.10.0 起没有 Node 20 预编译包）', () => {
    // CI 跑在带编译工具链的 ubuntu 上，改回 ^ 并升到 12.10+ 照样变绿；要到服务器 docker build（alpine 无 python）
    // 才失败。原因与解除条件见 docs/dev-guide.md「better-sqlite3 锁定在 12.9.0」：升到 Node 22 后再放开
    const dockerfile = read('Dockerfile');
    const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string> };
    if (/^FROM node:20\b/m.test(dockerfile)) {
      expect(pkg.dependencies['better-sqlite3']).toBe('12.9.0');
    }
  });
});
