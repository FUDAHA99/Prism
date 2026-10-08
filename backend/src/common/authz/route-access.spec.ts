import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Controller, ExecutionContext, ForbiddenException, Get, Logger, RequestMethod } from '@nestjs/common';
import {
  CONTROLLER_WATERMARK,
  GUARDS_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { MetadataScanner, Reflector } from '@nestjs/core';
import { PathsExplorer } from '@nestjs/core/router/paths-explorer';
import { AuthGuard } from '@nestjs/passport';
import { Access, ACCESS_LEVEL_KEY, ACCESS_LEVELS, AccessLevel, ROLES_FOR_LEVEL } from './access.decorator';
import { API_GLOBAL_PREFIX } from '../api-prefix';
import { JwtOptionalGuard } from '../guards/jwt-optional.guard';
import { RolesGuard } from '../../modules/role/guards/roles.guard';
import { ROLES_KEY } from '../../modules/role/decorators/roles.decorator';
import { AppModule } from '../../app.module';

/**
 * 全路由访问矩阵回归测试（批次 1-F）。
 *
 * 清点时 143 条路由里 29 条完全无守卫、85 条只校验登录不校验角色 —— 靠人记得挂守卫不可靠。
 * 这里从代码本身枚举全部路由，与下面声明式的 MATRIX 逐条比对：
 *   (a) 路由集合与 MATRIX 完全相等：新增接口必须先在这里登记级别，删掉的接口必须同步删除；
 *   (b) 每个 handler 都用 Access(...) 声明了访问级别，未声明即失败；
 *   (c) 守卫链与角色元数据和级别精确对应（AuthGuard 在 RolesGuard 之前）；
 *   (d) 用真实 RolesGuard + Reflector 对匿名 / 无角色 / user / editor / admin 逐一裁决；
 *   (e) portal 实际调用的接口都必须是 public / optional（portal 从不带 Authorization）；
 *   (f) admin SPA 调用的每个接口都能解析到已注册路由（防止删接口误伤后台）。
 *
 * MATRIX 的来源是 docs/access-matrix.md 的 target 列，1-F-1 的翻译规则：
 * public / public-filtered → 'public'（过滤是 1-F-2 的事）；optional-auth → 已在读 req.user 的
 * watch-history 为 'optional'，其余暂为 'public'；staff:admin,editor → 'staff'；remove → 已删除。
 *
 * 1-F-3 把 Access() 改为只写元数据、由全局 AccessGuard 执行时，(c)(d) 的守卫链部分随实现调整，
 * MATRIX 本身不变 —— 它就是翻转前后语义等价的依据。
 */

// ───────────────────────── 目标访问矩阵 ─────────────────────────

const MATRIX: Record<string, AccessLevel> = {
  // AdvertisementController
  'GET /api/v1/advertisements': 'admin',
  'POST /api/v1/advertisements': 'admin',
  'DELETE /api/v1/advertisements/:id': 'admin',
  'GET /api/v1/advertisements/:id': 'admin',
  'PATCH /api/v1/advertisements/:id': 'admin',
  'POST /api/v1/advertisements/:id/toggle': 'admin',
  // AuditController
  'GET /api/v1/audit-logs': 'admin',
  // AuthController
  'POST /api/v1/auth/change-password': 'authenticated',
  'POST /api/v1/auth/login': 'public',
  'POST /api/v1/auth/logout': 'authenticated',
  'GET /api/v1/auth/me': 'authenticated',
  'POST /api/v1/auth/refresh': 'public',
  'POST /api/v1/auth/register': 'public',
  // CategoryController
  'GET /api/v1/categories': 'public',
  'POST /api/v1/categories': 'staff',
  'DELETE /api/v1/categories/:id': 'staff',
  'GET /api/v1/categories/:id': 'public',
  'PATCH /api/v1/categories/:id': 'staff',
  // CollectController
  'GET /api/v1/collect/logs': 'admin',
  'GET /api/v1/collect/logs/:id': 'admin',
  'DELETE /api/v1/collect/mappings/:mappingId': 'admin',
  'GET /api/v1/collect/sources': 'admin',
  'POST /api/v1/collect/sources': 'admin',
  'DELETE /api/v1/collect/sources/:id': 'admin',
  'GET /api/v1/collect/sources/:id': 'admin',
  'PATCH /api/v1/collect/sources/:id': 'admin',
  'GET /api/v1/collect/sources/:id/discover-categories': 'admin',
  'GET /api/v1/collect/sources/:id/mappings': 'admin',
  'POST /api/v1/collect/sources/:id/mappings': 'admin',
  'POST /api/v1/collect/sources/:id/mappings/batch': 'admin',
  'POST /api/v1/collect/sources/:id/run': 'admin',
  'POST /api/v1/collect/sources/:id/test': 'admin',
  // ComicController
  'GET /api/v1/comics': 'public', // 矩阵目标 optional-auth，1-F-2 加发布状态过滤时改 optional
  'POST /api/v1/comics': 'staff',
  'DELETE /api/v1/comics/:id': 'staff',
  'GET /api/v1/comics/:id': 'staff',
  'PATCH /api/v1/comics/:id': 'staff',
  'GET /api/v1/comics/:id/chapters': 'public', // 矩阵目标 optional-auth，1-F-2 改 optional
  'POST /api/v1/comics/:id/chapters': 'staff',
  'POST /api/v1/comics/:id/publish': 'staff',
  'POST /api/v1/comics/:id/unpublish': 'staff',
  'DELETE /api/v1/comics/chapters/:chapterId': 'staff',
  'GET /api/v1/comics/chapters/:chapterId': 'public',
  'PATCH /api/v1/comics/chapters/:chapterId': 'staff',
  'GET /api/v1/comics/slug/:slug': 'public',
  // CommentController
  'GET /api/v1/comments': 'staff',
  'POST /api/v1/comments': 'public', // 矩阵目标 optional-auth，1-F-2 改由服务端填身份时改 optional
  'DELETE /api/v1/comments/:id': 'staff',
  'GET /api/v1/comments/:id': 'staff',
  'PATCH /api/v1/comments/:id/approve': 'staff',
  'PATCH /api/v1/comments/:id/spam': 'staff',
  'POST /api/v1/comments/batch/approve': 'staff',
  'POST /api/v1/comments/batch/delete': 'staff',
  'POST /api/v1/comments/batch/spam': 'staff',
  'GET /api/v1/comments/public': 'public',
  // ContentController
  'GET /api/v1/contents': 'public', // 矩阵目标 optional-auth，1-F-2 改 optional
  'POST /api/v1/contents': 'staff',
  'DELETE /api/v1/contents/:id': 'staff',
  'GET /api/v1/contents/:id': 'staff',
  'PATCH /api/v1/contents/:id': 'staff',
  'POST /api/v1/contents/:id/publish': 'staff',
  'POST /api/v1/contents/:id/unpublish': 'staff',
  'GET /api/v1/contents/slug/:slug': 'public',
  // FriendLinkController
  'GET /api/v1/friend-links': 'public', // 矩阵目标 optional-auth，1-F-2 改 optional
  'POST /api/v1/friend-links': 'admin',
  'DELETE /api/v1/friend-links/:id': 'admin',
  'PATCH /api/v1/friend-links/:id': 'admin',
  // MediaController
  'GET /api/v1/media': 'staff',
  'DELETE /api/v1/media/:id': 'staff',
  'GET /api/v1/media/:id': 'staff',
  'POST /api/v1/media/upload': 'staff',
  // MenuController
  'GET /api/v1/menus': 'admin',
  'POST /api/v1/menus': 'admin',
  'DELETE /api/v1/menus/:id': 'admin',
  'PATCH /api/v1/menus/:id': 'admin',
  // MovieController
  'GET /api/v1/movies': 'public', // 矩阵目标 optional-auth，1-F-2 改 optional
  'POST /api/v1/movies': 'staff',
  'DELETE /api/v1/movies/:id': 'staff',
  'GET /api/v1/movies/:id': 'staff',
  'PATCH /api/v1/movies/:id': 'staff',
  'PATCH /api/v1/movies/:id/poster': 'staff',
  'POST /api/v1/movies/:id/publish': 'staff',
  'POST /api/v1/movies/:id/sources': 'staff',
  'POST /api/v1/movies/:id/unpublish': 'staff',
  'DELETE /api/v1/movies/episodes/:episodeId': 'staff',
  'PATCH /api/v1/movies/episodes/:episodeId': 'staff',
  'GET /api/v1/movies/slug/:slug': 'public',
  'DELETE /api/v1/movies/sources/:sourceId': 'staff',
  'POST /api/v1/movies/sources/:sourceId/episodes': 'staff',
  // NoticeController
  'GET /api/v1/notices': 'staff',
  'POST /api/v1/notices': 'staff',
  'DELETE /api/v1/notices/:id': 'staff',
  'PATCH /api/v1/notices/:id': 'staff',
  'POST /api/v1/notices/:id/toggle-publish': 'staff',
  // NovelController
  'GET /api/v1/novels': 'public', // 矩阵目标 optional-auth，1-F-2 改 optional
  'POST /api/v1/novels': 'staff',
  'DELETE /api/v1/novels/:id': 'staff',
  'GET /api/v1/novels/:id': 'staff',
  'PATCH /api/v1/novels/:id': 'staff',
  'GET /api/v1/novels/:id/chapters': 'public', // 矩阵目标 optional-auth，1-F-2 改 optional
  'POST /api/v1/novels/:id/chapters': 'staff',
  'POST /api/v1/novels/:id/publish': 'staff',
  'POST /api/v1/novels/:id/unpublish': 'staff',
  'DELETE /api/v1/novels/chapters/:chapterId': 'staff',
  'GET /api/v1/novels/chapters/:chapterId': 'public', // 矩阵目标 optional-auth，1-F-2 改 optional
  'PATCH /api/v1/novels/chapters/:chapterId': 'staff',
  'GET /api/v1/novels/slug/:slug': 'public',
  // RoleController
  'GET /api/v1/roles': 'admin',
  'POST /api/v1/roles': 'admin',
  'DELETE /api/v1/roles/:id': 'admin',
  'GET /api/v1/roles/:id': 'admin',
  'PATCH /api/v1/roles/:id': 'admin',
  'POST /api/v1/roles/:id/permissions': 'admin',
  'GET /api/v1/roles/permissions': 'admin',
  // SiteSettingController
  'GET /api/v1/site-settings': 'admin',
  'POST /api/v1/site-settings/batch': 'admin',
  'GET /api/v1/site-settings/public': 'public',
  // StatsController
  'GET /api/v1/stats/dashboard': 'staff',
  'GET /api/v1/stats/system': 'staff',
  // TagController
  'GET /api/v1/tags': 'public',
  'POST /api/v1/tags': 'staff',
  'DELETE /api/v1/tags/:id': 'staff',
  'GET /api/v1/tags/:id': 'public',
  'PATCH /api/v1/tags/:id': 'staff',
  // UserController
  'GET /api/v1/users': 'admin',
  'POST /api/v1/users': 'admin',
  'DELETE /api/v1/users/:id': 'admin',
  'GET /api/v1/users/:id': 'admin',
  'PATCH /api/v1/users/:id': 'admin',
  'POST /api/v1/users/:id/assign-roles': 'admin',
  'POST /api/v1/users/:id/remove-roles': 'admin',
  'PATCH /api/v1/users/:id/status': 'admin',
  // WatchHistoryController（handler 用 req.user?.id 区分登录用户与游客）
  'GET /api/v1/watch-history': 'optional',
  'GET /api/v1/watch-history/recent': 'optional',
  'POST /api/v1/watch-history/report': 'optional',
};

/**
 * portal 实际调用的后端接口。portal 的 SSR（BACKEND_INTERNAL_URL）与浏览器请求都不带
 * Authorization，所以这些路由必须是 public 或 optional。下面的测试会扫描 portal 源码，
 * 要求这份清单与源码里的调用点完全一致（新增调用必须登记，删掉的调用必须移除）。
 */
const PORTAL_PATHS: readonly string[] = [
  // portal/lib/api.ts
  'GET /api/v1/contents',
  'GET /api/v1/contents/slug/:slug',
  'GET /api/v1/categories',
  'GET /api/v1/tags',
  'GET /api/v1/comments/public',
  'POST /api/v1/comments',
  'GET /api/v1/movies',
  'GET /api/v1/movies/slug/:slug',
  'GET /api/v1/novels',
  'GET /api/v1/novels/slug/:slug',
  'GET /api/v1/novels/:id/chapters',
  'GET /api/v1/novels/chapters/:chapterId',
  'GET /api/v1/comics',
  'GET /api/v1/comics/slug/:slug',
  'GET /api/v1/comics/:id/chapters',
  'GET /api/v1/comics/chapters/:chapterId',
  'GET /api/v1/site-settings/public',
  // portal/components/CommentSection.tsx 也直接 fetch 评论的两个接口（同上）
  // portal/components/ResumeButton.tsx
  'GET /api/v1/watch-history',
  // portal/app/movies/[slug]/play/[srcIdx]/[ep]/PlayClient.tsx
  'POST /api/v1/watch-history/report',
];

/**
 * admin SPA 里已知解析不到后端路由的调用（登记在此避免掩盖其他回归）。应保持为空：
 * 曾登记过前端的 POST/DELETE /users/:id/roles（后端是 POST /users/:id/assign-roles、/remove-roles，
 * 角色分配因此 404），已改为前端调用后端现有路由。新登记的条目在「已能解析」时下面的测试会失败，提醒清理。
 */
const KNOWN_UNRESOLVED_ADMIN_CALLS: readonly string[] = [];

// ───────────────────────── 从代码枚举路由 ─────────────────────────

type AnyClass = new (...args: any[]) => any;

interface RouteInfo {
  key: string;
  method: string;
  segments: string[];
  controller: AnyClass;
  handlerName: string;
  handler: (...args: any[]) => any;
  methodLevel: AccessLevel | undefined;
  classLevel: AccessLevel | undefined;
  level: AccessLevel | undefined;
  /** 生效的守卫链（类级在前、方法级在后，与 Nest 执行顺序一致），已去掉限流守卫 */
  guards: unknown[];
  /** 与 RolesGuard 相同的取法：方法级覆盖类级 */
  roles: string[] | undefined;
}

const SRC_ROOT = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(SRC_ROOT, '../..');

const toArray = <T>(v: T | T[] | undefined, fallback: T): T[] =>
  v === undefined ? [fallback] : Array.isArray(v) ? v : [v];

const splitPath = (...parts: string[]) => parts.join('/').split('/').filter(Boolean);

const isController = (v: unknown): v is AnyClass =>
  typeof v === 'function' && Reflect.getMetadata(CONTROLLER_WATERMARK, v) === true;


function walkFiles(dir: string, accept: (file: string) => boolean, skipDirs: string[] = []): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return skipDirs.includes(entry.name) ? [] : walkFiles(full, accept, skipDirs);
    return accept(full) ? [full] : [];
  });
}

/** 磁盘上 src 下所有 *.controller.ts 导出的 controller 类 */
function controllersOnDisk(): AnyClass[] {
  const files = walkFiles(SRC_ROOT, (f) => f.endsWith('.controller.ts'));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return files.flatMap((f) => Object.values(require(f) as Record<string, unknown>).filter(isController));
}

/** 从 AppModule 递归收集实际注册的 controller（按模块导入顺序，即 Nest 的路由注册顺序） */
function controllersInAppModule(): AnyClass[] {
  const seen = new Set<unknown>();
  const result: AnyClass[] = [];
  const visit = (entry: any) => {
    if (entry && typeof entry === 'object' && typeof entry.forwardRef === 'function') entry = entry.forwardRef();
    if (!entry || seen.has(entry)) return;
    const isDynamic = typeof entry === 'object' && typeof entry.module === 'function';
    const moduleClass = isDynamic ? entry.module : entry;
    if (typeof moduleClass !== 'function') return; // 异步动态模块（Promise）来自第三方库，不含本项目 controller
    seen.add(entry);
    const controllers = [
      ...(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, moduleClass) ?? []),
      ...(isDynamic ? entry.controllers ?? [] : []),
    ];
    for (const c of controllers) if (!result.includes(c)) result.push(c);
    const imports = [
      ...(Reflect.getMetadata(MODULE_METADATA.IMPORTS, moduleClass) ?? []),
      ...(isDynamic ? entry.imports ?? [] : []),
    ];
    imports.forEach(visit);
  };
  visit(AppModule);
  return result;
}

const METADATA_SCANNER = new MetadataScanner();

function routesOf(controller: AnyClass): RouteInfo[] {
  const proto = controller.prototype;
  const classLevel = Reflect.getMetadata(ACCESS_LEVEL_KEY, controller) as AccessLevel | undefined;
  const classGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, controller) ?? [];
  const classRoles: string[] | undefined = Reflect.getMetadata(ROLES_KEY, controller);
  const controllerPaths = toArray<string>(Reflect.getMetadata(PATH_METADATA, controller), '/');

  // 与 Nest 的 PathsExplorer 完全相同：MetadataScanner 沿原型链收集方法名（子类在前、同名只取一次），
  // 元数据从 proto[name] 读。只看原型自身会漏掉继承自基类的 @Get/@Post（BaseCrudController 写法），
  // 而 Nest 照样注册它们 —— 那样的路由既不会报「未登记」，也不会报「未声明 Access」
  return METADATA_SCANNER.getAllMethodNames(proto)
    .filter((name) => Reflect.hasMetadata(PATH_METADATA, proto[name]))
    .flatMap((handlerName) => {
      const handler = proto[handlerName];
      const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod];
      const methodLevel = Reflect.getMetadata(ACCESS_LEVEL_KEY, handler) as AccessLevel | undefined;
      const methodGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];
      const methodRoles: string[] | undefined = Reflect.getMetadata(ROLES_KEY, handler);
      const handlerPaths = toArray<string>(Reflect.getMetadata(PATH_METADATA, handler), '/');

      return controllerPaths.flatMap((cp) =>
        handlerPaths.map((hp) => {
          const segments = splitPath(API_GLOBAL_PREFIX, cp, hp);
          return {
            key: `${method} /${segments.join('/')}`,
            method,
            segments,
            controller,
            handlerName,
            handler,
            methodLevel,
            classLevel,
            level: methodLevel ?? classLevel,
            // 限流只由全局 ThrottlerBehindProxyGuard 执行（额度用 @Throttle 覆盖）。路由上若再挂 ThrottlerGuard，
            // 同一请求会按两套配置、两份存储重复计数 —— 不排除它，守卫链比对会直接失败
            guards: [...classGuards, ...methodGuards],
            roles: methodRoles ?? classRoles,
          };
        }),
      );
    });
}

const APP_CONTROLLERS = controllersInAppModule();
const DISK_CONTROLLERS = controllersOnDisk();
const ROUTES: RouteInfo[] = APP_CONTROLLERS.flatMap(routesOf);
const ROUTE_BY_KEY = new Map(ROUTES.map((r) => [r.key, r]));

const describeRoute = (r: RouteInfo) => `${r.key} (${r.controller.name}.${r.handlerName})`;

/** 「方法 handler 路径」签名，用来和 Nest 自己的扫描结果逐条比对 */
const routeSignatures = (controller: AnyClass) =>
  routesOf(controller).map((r) => `${r.method} ${r.handlerName} /${r.segments.join('/')}`);

/** Nest 注册路由时用的同一个 PathsExplorer（RouterExplorer 内部即用它扫描 controller 原型） */
function nestRouteSignatures(controller: AnyClass): string[] {
  const proto = controller.prototype;
  const controllerPaths = toArray<string>(Reflect.getMetadata(PATH_METADATA, controller), '/');
  return new PathsExplorer(new MetadataScanner())
    .scanForPaths(Object.create(proto), proto)
    .flatMap((def) =>
      controllerPaths.flatMap((cp) =>
        def.path.map(
          (hp) => `${RequestMethod[def.requestMethod]} ${def.methodName} /${splitPath(API_GLOBAL_PREFIX, cp, hp).join('/')}`,
        ),
      ),
    );
}

// 继承探针：常见的 BaseCrudController 写法。只用于上面的枚举测试，不注册进任何模块
class InheritProbeBase {
  @Get('dump')
  dump() {
    return { secret: 'admin-only data' };
  }

  @Get('shadowed')
  shadowed() {
    return 'base';
  }
}

@Controller('inherit-probe')
class InheritProbeController extends InheritProbeBase {
  @Access('admin')
  @Get()
  own() {
    return [];
  }

  override shadowed() {
    return 'override without route decorator';
  }
}

// ───────────────────────── 守卫裁决模拟 ─────────────────────────

const EXPECTED_GUARDS: Record<AccessLevel, unknown[]> = {
  public: [],
  optional: [JwtOptionalGuard],
  authenticated: [AuthGuard('jwt')],
  staff: [AuthGuard('jwt'), RolesGuard],
  admin: [AuthGuard('jwt'), RolesGuard],
};

const PRINCIPALS: ReadonlyArray<[string, unknown]> = [
  ['匿名', undefined],
  ['roles 未定义', { id: 'u-1' }],
  ['roles []', { id: 'u-2', roles: [] }],
  ["roles ['user']", { id: 'u-3', roles: ['user'] }],
  ["roles ['editor']", { id: 'u-4', roles: ['editor'] }],
  ["roles ['admin']", { id: 'u-5', roles: ['admin'] }],
];

type Decision = 'allow' | 401 | 403;

const EXPECTED_DECISIONS: Record<AccessLevel, Decision[]> = {
  //               匿名   未定义  []    user   editor   admin
  public:        ['allow', 'allow', 'allow', 'allow', 'allow', 'allow'],
  optional:      ['allow', 'allow', 'allow', 'allow', 'allow', 'allow'],
  authenticated: [401, 'allow', 'allow', 'allow', 'allow', 'allow'],
  staff:         [401, 403, 403, 403, 'allow', 'allow'],
  admin:         [401, 403, 403, 403, 403, 'allow'],
};

const contextFor = (route: RouteInfo, user: unknown) =>
  ({
    getType: () => 'http',
    getHandler: () => route.handler,
    getClass: () => route.controller,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  }) as unknown as ExecutionContext;

/**
 * 按守卫链顺序裁决。AuthGuard('jwt') 由 passport 校验 token，单测里以「有无 req.user」
 * 近似（有效 token ⇔ 有 user）；JwtOptionalGuard 永不拒绝；RolesGuard 用真实实现 + 真实 Reflector
 * 读路由上的真实元数据。token 解析本身的行为由运行时探测覆盖，不在这里模拟。
 */
function decide(route: RouteInfo, user: unknown): Decision {
  for (const guard of route.guards) {
    if (guard === AuthGuard('jwt')) {
      if (!user) return 401;
    } else if (guard === JwtOptionalGuard) {
      continue;
    } else if (guard === RolesGuard) {
      try {
        new RolesGuard(new Reflector()).canActivate(contextFor(route, user));
      } catch (err) {
        if (err instanceof ForbiddenException) return 403;
        throw err;
      }
    } else {
      throw new Error(`${describeRoute(route)} 挂了未知守卫 ${(guard as any)?.name ?? guard}`);
    }
  }
  return 'allow';
}

// ───────────────────────── 前端调用点扫描 ─────────────────────────

interface ApiCall {
  file: string;
  method: string;
  /** 归一化后的路径：模板插值换成 :param，去掉查询串 */
  path: string;
}

/** 从字符串字面量结束处开始，取紧随其后的 `, { ... }` 选项对象文本（用于识别 method） */
function optionsObjectAfter(text: string, from: number): string {
  let i = from;
  while (/\s/.test(text[i] ?? '')) i++;
  if (text[i] !== ',') return '';
  i++;
  while (/\s/.test(text[i] ?? '')) i++;
  if (text[i] !== '{') return '';
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    if (text[j] === '{') depth++;
    if (text[j] === '}' && --depth === 0) return text.slice(i, j + 1);
  }
  return '';
}

const normalizeCallPath = (raw: string) =>
  '/' + splitPath(raw.replace(/\$\{[^}]*\}/g, ':param').split('?')[0]).join('/');

/** portal：lib/api.ts 的 request('/xxx') 与组件里直接 fetch('.../api/v1/xxx') */
function scanPortalCalls(portalRoot: string): ApiCall[] {
  const files = walkFiles(
    portalRoot,
    (f) => /\.(ts|tsx|js|jsx|mjs)$/.test(f) && !f.endsWith('.d.ts'),
    ['node_modules', '.next', 'public', 'out'],
  );
  const calls: ApiCall[] = [];
  const re = /\b(request|fetch)\s*(?:<[^(]*>)?\s*\(\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2/g;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(re)) {
      const [whole, fn, , literal] = m;
      let raw: string;
      if (fn === 'request') {
        raw = `/${API_GLOBAL_PREFIX}/${literal}`;
      } else {
        const at = literal.indexOf(`/${API_GLOBAL_PREFIX}/`);
        if (at < 0) continue; // fetch 非后端地址
        raw = literal.slice(at);
      }
      const opts = optionsObjectAfter(text, (m.index ?? 0) + whole.length);
      const method = (/\bmethod\s*:\s*['"`](\w+)['"`]/.exec(opts)?.[1] ?? 'GET').toUpperCase();
      calls.push({ file: path.relative(REPO_ROOT, file), method, path: normalizeCallPath(raw) });
    }
  }
  return calls;
}

/** admin SPA：frontend/src/api/*.ts 里的 apiClient.get/post/...('/xxx')（baseURL 为 /api/v1） */
function scanAdminCalls(apiDir: string): ApiCall[] {
  const calls: ApiCall[] = [];
  const re = /\bapiClient\.(get|post|put|patch|delete)\s*(?:<[^(]*>)?\s*\(\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2/g;
  for (const file of walkFiles(apiDir, (f) => f.endsWith('.ts'))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(re)) {
      calls.push({
        file: path.relative(REPO_ROOT, file),
        method: m[1].toUpperCase(),
        path: normalizeCallPath(`/${API_GLOBAL_PREFIX}/${m[3]}`),
      });
    }
  }
  return calls;
}

/** 按 Express 的匹配规则找第一个命中的已注册路由（路由参数段匹配任意值；调用侧的 :param 只能匹配路由参数段） */
function resolveCall(call: { method: string; path: string }): RouteInfo | undefined {
  const callSegments = splitPath(call.path);
  return ROUTES.find(
    (r) =>
      r.method === call.method &&
      r.segments.length === callSegments.length &&
      r.segments.every((seg, i) =>
        seg.startsWith(':') ? true : !callSegments[i].startsWith(':') && seg.toLowerCase() === callSegments[i].toLowerCase(),
      ),
  );
}

const callKey = (c: ApiCall) => `${c.method} ${c.path}`;

// ───────────────────────── 测试 ─────────────────────────

describe('路由访问矩阵', () => {
  let loggerError: jest.SpyInstance;

  beforeAll(() => {
    // RolesGuard 在无角色元数据时会记录装配错误；这里会刻意触发，静音
    loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterAll(() => {
    loggerError.mockRestore();
  });

  describe('路由枚举', () => {
    it('src 下每个 *.controller.ts 都在 AppModule 中注册，反之亦然', () => {
      const names = (list: AnyClass[]) => list.map((c) => c.name).sort();
      expect(names(APP_CONTROLLERS)).toEqual(names(DISK_CONTROLLERS));
      expect(APP_CONTROLLERS.length).toBeGreaterThanOrEqual(20);
    });

    it('(a) 已注册路由与 MATRIX 完全一致：没有未登记的新路由，也没有过期条目', () => {
      const registered = new Set(ROUTE_BY_KEY.keys());
      const declared = new Set(Object.keys(MATRIX));
      expect({
        未登记的路由: [...registered].filter((k) => !declared.has(k)).sort(),
        MATRIX中已不存在的路由: [...declared].filter((k) => !registered.has(k)).sort(),
      }).toEqual({ 未登记的路由: [], MATRIX中已不存在的路由: [] });
    });

    it('没有重复路由，也没有被前面注册的同方法路由完全遮蔽、永远到不了的路由', () => {
      const duplicates = ROUTES.filter((r, i) => ROUTES.findIndex((o) => o.key === r.key) !== i).map(describeRoute);
      const shadowed = ROUTES.flatMap((late, i) =>
        ROUTES.slice(0, i)
          .filter(
            (early) =>
              early.key !== late.key &&
              early.method === late.method &&
              early.segments.length === late.segments.length &&
              early.segments.every((seg, j) => seg.startsWith(':') || seg === late.segments[j]),
          )
          .map((early) => `${describeRoute(late)} 被 ${describeRoute(early)} 遮蔽`),
      );
      expect({ duplicates, shadowed }).toEqual({ duplicates: [], shadowed: [] });
    });

    it('routesOf 与 Nest 自己的 PathsExplorer 对每个 controller 得到同一组 handler（含继承来的）', () => {
      expect(Object.fromEntries(APP_CONTROLLERS.map((c) => [c.name, routeSignatures(c)]))).toEqual(
        Object.fromEntries(APP_CONTROLLERS.map((c) => [c.name, nestRouteSignatures(c)])),
      );
    });

    it('继承自基类的 @Get 会被枚举出来，并被 (a)(b) 两项检查同时抓到', () => {
      const routes = routesOf(InheritProbeController);
      // 只看原型自身（此前的写法）根本看不到 dump；Nest 却会注册它
      expect(Object.getOwnPropertyNames(InheritProbeController.prototype)).not.toContain('dump');
      expect(nestRouteSignatures(InheritProbeController)).toContain('GET dump /api/v1/inherit-probe/dump');

      expect(routes.map(describeRoute)).toEqual([
        'GET /api/v1/inherit-probe (InheritProbeController.own)',
        'GET /api/v1/inherit-probe/dump (InheritProbeController.dump)',
      ]);
      // 子类覆盖了基类的路由方法却没带装饰器：Nest 不注册，这里也不算路由
      expect(routes.map((r) => r.handlerName)).not.toContain('shadowed');
      expect(routeSignatures(InheritProbeController)).toEqual(nestRouteSignatures(InheritProbeController));

      // (a) 的判定：不在 MATRIX 里 → 未登记；(b) 的判定：没有 Access → 未声明级别
      expect(routes.filter((r) => !(r.key in MATRIX)).map((r) => r.key)).toEqual([
        'GET /api/v1/inherit-probe',
        'GET /api/v1/inherit-probe/dump',
      ]);
      expect(routes.filter((r) => r.level === undefined).map(describeRoute)).toEqual([
        'GET /api/v1/inherit-probe/dump (InheritProbeController.dump)',
      ]);
      // 继承来的 handler 的守卫链也照实读出（这里没有任何守卫 → 匿名可达）
      const dump = routes.find((r) => r.handlerName === 'dump')!;
      expect(dump.guards).toEqual([]);
      expect(dump.handler).toBe(InheritProbeBase.prototype.dump);
    });

    it('MATRIX 的每个级别都是已知级别', () => {
      const unknown = Object.entries(MATRIX).filter(([, level]) => !ACCESS_LEVELS.includes(level));
      expect(unknown).toEqual([]);
    });
  });

  describe('(b) 访问级别声明', () => {
    it('每个 handler 都用 Access(...) 声明了访问级别（未声明即失败）', () => {
      expect(ROUTES.filter((r) => r.level === undefined).map(describeRoute)).toEqual([]);
    });

    it('类级与方法级 Access 不混用（类级只用于整组同级的 controller）', () => {
      expect(
        ROUTES.filter((r) => r.classLevel !== undefined && r.methodLevel !== undefined).map(describeRoute),
      ).toEqual([]);
    });
  });

  describe.each(ROUTES.map((r) => [describeRoute(r), r] as const))('%s', (_name, route) => {
    it('访问级别与 MATRIX 一致', () => {
      expect(route.level).toBe(MATRIX[route.key]);
    });

    it('(c) 守卫链与角色元数据精确对应该级别', () => {
      const level = MATRIX[route.key];
      expect(route.guards).toEqual(EXPECTED_GUARDS[level]);
      const roles = ROLES_FOR_LEVEL[level];
      expect(route.roles).toEqual(roles === undefined ? undefined : [...roles]);
    });

    it('(d) 真实 RolesGuard 对各类身份的裁决符合该级别', () => {
      const level = MATRIX[route.key];
      const actual = PRINCIPALS.map(([, user]) => decide(route, user));
      expect(Object.fromEntries(PRINCIPALS.map(([label], i) => [label, actual[i]]))).toEqual(
        Object.fromEntries(PRINCIPALS.map(([label], i) => [label, EXPECTED_DECISIONS[level][i]])),
      );
    });

    if (ROLES_FOR_LEVEL[MATRIX[route.key]] === undefined) {
      it('不做角色判断的路由上，RolesGuard 若被误挂也会 fail-closed（连 admin 都拒绝）', () => {
        expect(() =>
          new RolesGuard(new Reflector()).canActivate(contextFor(route, { id: 'a', roles: ['admin'] })),
        ).toThrow(ForbiddenException);
      });
    }
  });

  describe('(e) portal 依赖的接口必须匿名可达', () => {
    const portalRoot = path.join(REPO_ROOT, 'portal');

    it.each(PORTAL_PATHS)('%s 是 public 或 optional', (key) => {
      expect(ROUTE_BY_KEY.has(key)).toBe(true);
      expect(['public', 'optional']).toContain(MATRIX[key]);
      expect(decide(ROUTE_BY_KEY.get(key)!, undefined)).toBe('allow');
    });

    it('PORTAL_PATHS 与 portal 源码里的调用点完全一致', () => {
      expect(fs.existsSync(path.join(portalRoot, 'lib', 'api.ts'))).toBe(true);
      const calls = scanPortalCalls(portalRoot);
      expect(calls.length).toBeGreaterThanOrEqual(PORTAL_PATHS.length); // 防止扫描规则失效后测试变空

      const unresolved = calls.filter((c) => !resolveCall(c)).map((c) => `${callKey(c)}  ← ${c.file}`);
      const resolvedKeys = new Set(calls.map(resolveCall).filter(Boolean).map((r) => r!.key));
      expect({
        解析不到后端路由的调用: unresolved,
        未登记进PORTAL_PATHS: [...resolvedKeys].filter((k) => !PORTAL_PATHS.includes(k)).sort(),
        portal已不再调用: PORTAL_PATHS.filter((k) => !resolvedKeys.has(k)),
      }).toEqual({ 解析不到后端路由的调用: [], 未登记进PORTAL_PATHS: [], portal已不再调用: [] });
    });
  });

  describe('(f) admin SPA 的调用都能解析到已注册路由', () => {
    const apiDir = path.join(REPO_ROOT, 'frontend', 'src', 'api');

    it('frontend/src/api 下每个 apiClient 调用都命中路由，且 admin 角色可访问', () => {
      expect(fs.existsSync(apiDir)).toBe(true);
      const calls = scanAdminCalls(apiDir);
      expect(calls.length).toBeGreaterThan(80); // 防止扫描规则失效后测试变空

      const problems = calls.flatMap((c) => {
        if (KNOWN_UNRESOLVED_ADMIN_CALLS.includes(callKey(c))) return [];
        const route = resolveCall(c);
        if (!route) return [`${callKey(c)} 解析不到后端路由  ← ${c.file}`];
        const verdict = decide(route, { id: 'admin', roles: ['admin'] });
        return verdict === 'allow' ? [] : [`${callKey(c)} → ${route.key} 对 admin 返回 ${verdict}`];
      });
      expect(problems).toEqual([]);
    });

    it('KNOWN_UNRESOLVED_ADMIN_CALLS 里的条目确实仍解析不到（修好后要从清单移除）', () => {
      const calls = scanAdminCalls(apiDir).map(callKey);
      for (const known of KNOWN_UNRESOLVED_ADMIN_CALLS) {
        expect(calls).toContain(known);
        const [method, p] = known.split(' ');
        expect(resolveCall({ method, path: p })).toBeUndefined();
      }
    });
  });
});
