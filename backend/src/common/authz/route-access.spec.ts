import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Controller, Get, Logger, RequestMethod, SetMetadata } from '@nestjs/common';
import {
  CONTROLLER_WATERMARK,
  GUARDS_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { APP_GUARD, MetadataScanner } from '@nestjs/core';
import { PathsExplorer } from '@nestjs/core/router/paths-explorer';
import { Access, ACCESS_LEVEL_KEY, ACCESS_LEVELS, AccessLevel } from './access.decorator';
import { AccessGuard, UNDECLARED_ACCESS_LEVEL } from './access.guard';
import { API_GLOBAL_PREFIX } from '../api-prefix';
import { ThrottlerBehindProxyGuard } from '../guards/throttler-behind-proxy.guard';
import { createAccessProbe, Decision, ProbeUser } from '../testing/access-probe';
import { AppModule } from '../../app.module';

/**
 * 全路由访问矩阵回归测试（批次 1-F）。
 *
 * 清点时 143 条路由里 29 条完全无守卫、85 条只校验登录不校验角色 —— 靠人记得挂守卫不可靠。
 * 1-F-1 先逐路由挂守卫并建立这份矩阵；1-F-3 翻转为全局默认拒绝：Access() 只写元数据，
 * 由 AppModule 注册的全局 AccessGuard 统一执行，未声明级别的路由按仅管理员处理。
 *
 * 这里从代码本身枚举全部路由，与下面声明式的 MATRIX 逐条比对：
 *   (a) 路由集合与 MATRIX 完全相等，且每个路由都用 Access(...) 声明了与 MATRIX 一致的级别；
 *   (b) 真实 AccessGuard（真实 Reflector + 真实 passport / JwtStrategy，见 common/testing/access-probe.ts）
 *       对匿名 / 各种无效 token / 无角色 / user / editor / admin 的裁决，与 EXPECTED_DECISIONS 逐格相同；
 *       放行时 req.user 的写法与 passport 的调用次数也与翻转前一致；
 *   (c) 没有 Access 元数据（或级别未知）的路由被拒绝：按仅管理员处理并记装配错误；
 *   (d) 路由上不再挂任何守卫（鉴权只在全局 AccessGuard，passport 每个请求最多跑一次），
 *       AppModule 先注册限流守卫、再注册 AccessGuard；
 *   (e) portal 实际调用的接口都必须是 public / optional（portal 没有登录界面）；少数带同源 admin token 的
 *       调用（PORTAL_TOKEN_CALLS）必须在 401 时以游客身份重试；
 *   (f) admin SPA 调用的每个接口都能解析到已注册路由，且 admin 可访问（防止删接口误伤后台）。
 *
 * MATRIX 的来源是 docs/access-matrix.md 的 target 列，翻译规则：
 * public / public-filtered → 'public'（过滤在 service 里按已发布 / 字段白名单做，不解析 token）；
 * optional-auth → 'optional'（严格可选登录）；staff:admin,editor → 'staff'；remove → 已删除。
 *
 * 语义等价的依据：MATRIX 与 EXPECTED_DECISIONS 两张表在翻转前后一字未改。翻转前它们约束的是每个路由上的守卫链
 * （AuthGuard('jwt') / JwtOptionalGuard / RolesGuard + @Roles），翻转后约束的是同一组身份在真实 AccessGuard 上的裁决。
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
  // 1-F-3 新增：本人修改资料（只收昵称 / 头像），admin 与 editor 的「个人设置」都用它（此前调 PATCH /users/:id，editor 403）
  'PATCH /api/v1/auth/me': 'authenticated',
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
  'GET /api/v1/comics': 'optional',
  'POST /api/v1/comics': 'staff',
  'DELETE /api/v1/comics/:id': 'staff',
  'GET /api/v1/comics/:id': 'staff',
  'PATCH /api/v1/comics/:id': 'staff',
  'GET /api/v1/comics/:id/chapters': 'optional',
  'POST /api/v1/comics/:id/chapters': 'staff',
  'POST /api/v1/comics/:id/publish': 'staff',
  'POST /api/v1/comics/:id/unpublish': 'staff',
  'DELETE /api/v1/comics/chapters/:chapterId': 'staff',
  'GET /api/v1/comics/chapters/:chapterId': 'public',
  'PATCH /api/v1/comics/chapters/:chapterId': 'staff',
  'GET /api/v1/comics/slug/:slug': 'public',
  // CommentController
  'GET /api/v1/comments': 'staff',
  'POST /api/v1/comments': 'optional',
  'DELETE /api/v1/comments/:id': 'staff',
  'GET /api/v1/comments/:id': 'staff',
  'PATCH /api/v1/comments/:id/approve': 'staff',
  'PATCH /api/v1/comments/:id/spam': 'staff',
  'POST /api/v1/comments/batch/approve': 'staff',
  'POST /api/v1/comments/batch/delete': 'staff',
  'POST /api/v1/comments/batch/spam': 'staff',
  'GET /api/v1/comments/public': 'public',
  // ContentController
  'GET /api/v1/contents': 'optional',
  'POST /api/v1/contents': 'staff',
  'DELETE /api/v1/contents/:id': 'staff',
  'GET /api/v1/contents/:id': 'staff',
  'PATCH /api/v1/contents/:id': 'staff',
  'POST /api/v1/contents/:id/publish': 'staff',
  'POST /api/v1/contents/:id/unpublish': 'staff',
  'GET /api/v1/contents/slug/:slug': 'public',
  // FriendLinkController
  'GET /api/v1/friend-links': 'optional',
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
  'GET /api/v1/movies': 'optional',
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
  'GET /api/v1/novels': 'optional',
  'POST /api/v1/novels': 'staff',
  'DELETE /api/v1/novels/:id': 'staff',
  'GET /api/v1/novels/:id': 'staff',
  'PATCH /api/v1/novels/:id': 'staff',
  'GET /api/v1/novels/:id/chapters': 'optional',
  'POST /api/v1/novels/:id/chapters': 'staff',
  'POST /api/v1/novels/:id/publish': 'staff',
  'POST /api/v1/novels/:id/unpublish': 'staff',
  'DELETE /api/v1/novels/chapters/:chapterId': 'staff',
  'GET /api/v1/novels/chapters/:chapterId': 'optional',
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
 * portal 实际调用的后端接口。portal 没有登录界面，SSR（BACKEND_INTERNAL_URL）与浏览器请求都按游客访问，
 * 所以这些路由必须是 public 或 optional。下面的测试会扫描 portal 源码，
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
 * portal 里带 Authorization 的调用：读同源 localStorage 里 admin 后台留下的 access_token。
 * optional 是严格可选登录，token 过期 / 被注销时得 401 而不是降级成游客，所以这些调用点必须
 * 在 401 时去掉 token 以游客身份重试（否则管理员 token 过期后在门户看片，进度既存不上也读不到）。
 * 新增带 token 的调用必须登记在这里并照此处理；public 路由不解析 token，带了也没有意义。
 */
const PORTAL_TOKEN_CALLS: readonly string[] = ['GET /api/v1/watch-history', 'POST /api/v1/watch-history/report'];

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
  /** 路由自身挂的守卫（类级在前、方法级在后，与 Nest 执行顺序一致）。默认拒绝之后必须为空 */
  guards: unknown[];
  /** 旧写法 @Roles(...) 的元数据（键 'roles'，方法级覆盖类级）。已没有任何守卫读它，出现即说明有人以为它还生效 */
  legacyRoles: unknown;
}

/** 已删除的 Roles 装饰器写入的元数据键 */
const LEGACY_ROLES_KEY = 'roles';

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

interface ModuleInfo {
  moduleClass: Function;
  controllers: AnyClass[];
  providers: unknown[];
}

/** 从 AppModule 递归收集实际导入的模块（深度优先，与 Nest 扫描模块的顺序一致），含动态模块带来的 controller / provider */
function modulesInAppModule(): ModuleInfo[] {
  const seen = new Set<unknown>();
  const result: ModuleInfo[] = [];
  const visit = (entry: any) => {
    if (entry && typeof entry === 'object' && typeof entry.forwardRef === 'function') entry = entry.forwardRef();
    if (!entry || seen.has(entry)) return;
    const isDynamic = typeof entry === 'object' && typeof entry.module === 'function';
    const moduleClass = isDynamic ? entry.module : entry;
    if (typeof moduleClass !== 'function') return; // 异步动态模块（Promise）来自第三方库，不含本项目 controller
    seen.add(entry);
    result.push({
      moduleClass,
      controllers: [
        ...(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, moduleClass) ?? []),
        ...(isDynamic ? entry.controllers ?? [] : []),
      ],
      providers: [
        ...(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, moduleClass) ?? []),
        ...(isDynamic ? entry.providers ?? [] : []),
      ],
    });
    const imports = [
      ...(Reflect.getMetadata(MODULE_METADATA.IMPORTS, moduleClass) ?? []),
      ...(isDynamic ? entry.imports ?? [] : []),
    ];
    imports.forEach(visit);
  };
  visit(AppModule);
  return result;
}

/** AppModule 实际注册的 controller（按模块导入顺序，即 Nest 的路由注册顺序） */
function controllersInAppModule(): AnyClass[] {
  const result: AnyClass[] = [];
  for (const { controllers } of modulesInAppModule()) {
    for (const c of controllers) if (!result.includes(c)) result.push(c);
  }
  return result;
}

const METADATA_SCANNER = new MetadataScanner();

function routesOf(controller: AnyClass): RouteInfo[] {
  const proto = controller.prototype;
  const classLevel = Reflect.getMetadata(ACCESS_LEVEL_KEY, controller) as AccessLevel | undefined;
  const classGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, controller) ?? [];
  const classRoles: unknown = Reflect.getMetadata(LEGACY_ROLES_KEY, controller);
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
      const methodRoles: unknown = Reflect.getMetadata(LEGACY_ROLES_KEY, handler);
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
            // 鉴权只由全局 AccessGuard 执行、限流只由全局 ThrottlerBehindProxyGuard 执行（额度用 @Throttle 覆盖）。
            // 路由上再挂 AuthGuard 会让 passport 同一请求跑两遍；再挂 ThrottlerGuard 会按两套配置重复计数
            guards: [...classGuards, ...methodGuards],
            legacyRoles: methodRoles ?? classRoles,
          };
        }),
      );
    });
}

const APP_MODULES = modulesInAppModule();
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

// 装配错误探针：忘了声明级别、或绕过 Access() 写了未知级别。只用于 (c)，不注册进任何模块
@Controller('wiring-probe')
class WiringProbeController {
  @Get('undeclared')
  undeclared() {
    return { secret: 'admin-only data' };
  }

  @Get('unknown-level')
  @SetMetadata(ACCESS_LEVEL_KEY, 'everyone')
  unknownLevel() {
    return { secret: 'admin-only data' };
  }
}

// ───────────────────────── 真实 AccessGuard 裁决 ─────────────────────────

/** 带了 Authorization 头、但 token 无效：逐一裁决 probe.invalidHeaders() 里的每种写法（伪造 / 过期 / 已注销 / 吊销 / 禁用……） */
const INVALID_TOKEN = Symbol('带了无效 token');

type Principal = ProbeUser | undefined | typeof INVALID_TOKEN;

// 用户经真实 JwtStrategy 加载（token 里的 roles 快照一律写成 admin，不被采信），roles 以这里为准
const PRINCIPALS: ReadonlyArray<[string, Principal]> = [
  ['匿名', undefined],
  ['无效 token', INVALID_TOKEN],
  ['roles 未定义', { id: 'u-1' }],
  ['roles []', { id: 'u-2', roles: [] }],
  ["roles ['user']", { id: 'u-3', roles: ['user'] }],
  ["roles ['editor']", { id: 'u-4', roles: ['editor'] }],
  ["roles ['admin']", { id: 'u-5', roles: ['admin'] }],
];

// optional 是严格可选登录：没带头 = 匿名放行；带了无效 token 与 authenticated 一样 401（不静默降级为匿名）。
// public 不解析 token，带什么头都一样放行。
const EXPECTED_DECISIONS: Record<AccessLevel, Decision[]> = {
  //               匿名     无效token 未定义   []       user     editor   admin
  public:        ['allow', 'allow', 'allow', 'allow', 'allow', 'allow', 'allow'],
  optional:      ['allow', 401, 'allow', 'allow', 'allow', 'allow', 'allow'],
  authenticated: [401, 401, 'allow', 'allow', 'allow', 'allow', 'allow'],
  staff:         [401, 401, 403, 403, 403, 'allow', 'allow'],
  admin:         [401, 401, 403, 403, 403, 403, 'allow'],
};

const probe = createAccessProbe();
let INVALID_HEADERS: Array<[string, string]> = [];

type Verdict = Decision | Record<string, Decision>;

/**
 * 真实 AccessGuard 对某个身份的裁决。无效 token 的每种写法必须得到同一个裁决，否则把各写法的裁决原样返回，
 * 与期望值比较时就会显示是哪一种写法与众不同。
 */
async function decide(route: { controller: AnyClass; handler: Function }, principal: Principal): Promise<Verdict> {
  if (principal === INVALID_TOKEN) {
    const perHeader: Record<string, Decision> = {};
    for (const [label, header] of INVALID_HEADERS) {
      perHeader[label] = (await probe.decide(route.controller, route.handler, header)).decision;
    }
    const distinct = [...new Set(Object.values(perHeader))];
    return distinct.length === 1 ? distinct[0] : perHeader;
  }
  const header = principal === undefined ? undefined : probe.bearer(principal);
  return (await probe.decide(route.controller, route.handler, header)).decision;
}

/** 各身份的裁决表（标签 → 裁决），与 EXPECTED_DECISIONS 对应列逐格比较 */
async function decisionTable(route: { controller: AnyClass; handler: Function }): Promise<Record<string, Verdict>> {
  const table: Record<string, Verdict> = {};
  for (const [label, principal] of PRINCIPALS) table[label] = await decide(route, principal);
  return table;
}

const expectedTable = (level: AccessLevel): Record<string, Verdict> =>
  Object.fromEntries(PRINCIPALS.map(([label], i) => [label, EXPECTED_DECISIONS[level][i]]));

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

const portalSourceFiles = (portalRoot: string) =>
  walkFiles(
    portalRoot,
    (f) => /\.(ts|tsx|js|jsx|mjs)$/.test(f) && !f.endsWith('.d.ts'),
    ['node_modules', '.next', 'public', 'out'],
  );

/** portal：lib/api.ts 的 request('/xxx') 与组件里直接 fetch('.../api/v1/xxx') */
function scanPortalCalls(portalRoot: string, files: string[] = portalSourceFiles(portalRoot)): ApiCall[] {
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

// 每个路由十几次 passport 验签（含 bcrypt 之外的全部真实校验），CI 机器比本地慢，留足余量
jest.setTimeout(30_000);

describe('路由访问矩阵', () => {
  let loggerError: jest.SpyInstance;

  beforeAll(async () => {
    // AccessGuard 对未声明级别的路由记装配错误；(c) 会刻意触发并断言，这里静音
    loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    INVALID_HEADERS = await probe.invalidHeaders();
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

    it('继承自基类的 @Get 会被枚举出来、被 (a) 抓到，且在运行时按未声明处理（仅管理员）', async () => {
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

      // (a) 的判定：不在 MATRIX 里 → 未登记；没有 Access → 未声明级别
      expect(routes.filter((r) => !(r.key in MATRIX)).map((r) => r.key)).toEqual([
        'GET /api/v1/inherit-probe',
        'GET /api/v1/inherit-probe/dump',
      ]);
      expect(routes.filter((r) => r.level === undefined).map(describeRoute)).toEqual([
        'GET /api/v1/inherit-probe/dump (InheritProbeController.dump)',
      ]);
      // 继承来的 handler 路由上没有任何守卫；翻转前这意味着匿名可达，现在由全局 AccessGuard 按仅管理员处理
      const dump = routes.find((r) => r.handlerName === 'dump')!;
      expect(dump.guards).toEqual([]);
      expect(dump.handler).toBe(InheritProbeBase.prototype.dump);
      expect(await decisionTable(dump)).toEqual(expectedTable('admin'));
    });

    it('MATRIX 的每个级别都是已知级别', () => {
      const unknown = Object.entries(MATRIX).filter(([, level]) => !ACCESS_LEVELS.includes(level));
      expect(unknown).toEqual([]);
    });
  });

  describe('(a) 访问级别声明', () => {
    it('每个 handler 都用 Access(...) 声明了访问级别（未声明即失败）', () => {
      expect(ROUTES.filter((r) => r.level === undefined).map(describeRoute)).toEqual([]);
    });

    it('类级与方法级 Access 不混用（类级只用于整组同级的 controller）', () => {
      expect(
        ROUTES.filter((r) => r.classLevel !== undefined && r.methodLevel !== undefined).map(describeRoute),
      ).toEqual([]);
    });
  });

  describe('(c) 未声明访问级别的路由默认拒绝', () => {
    const undeclared = { controller: WiringProbeController, handler: WiringProbeController.prototype.undeclared };
    const unknownLevel = { controller: WiringProbeController, handler: WiringProbeController.prototype.unknownLevel };
    const wiringErrors = () => loggerError.mock.calls.map(([message]) => String(message));

    it('未声明时按 admin 级别处理：匿名 / 无效 token 401，非管理员 403，只有 admin 放行', async () => {
      expect(UNDECLARED_ACCESS_LEVEL).toBe('admin');
      expect(Reflect.getMetadata(ACCESS_LEVEL_KEY, undeclared.handler)).toBeUndefined();
      expect(Reflect.getMetadata(ACCESS_LEVEL_KEY, WiringProbeController)).toBeUndefined();
      expect(await decisionTable(undeclared)).toEqual(expectedTable('admin'));
    });

    it('元数据里是未知级别（绕过 Access() 写入）同样按 admin 处理，而不是放行', async () => {
      expect(Reflect.getMetadata(ACCESS_LEVEL_KEY, unknownLevel.handler)).toBe('everyone');
      expect(await decisionTable(unknownLevel)).toEqual(expectedTable('admin'));
    });

    it('记一条装配错误日志（指明 controller.handler），同一个 handler 只记一次', async () => {
      const mentions = (name: string) => wiringErrors().filter((m) => m.includes(`WiringProbeController.${name}`));
      // 不依赖前面用例的执行顺序：自己各请求两次（守卫实例是共享的，前面已请求过也一样只记一次）
      for (const route of [undeclared, unknownLevel, undeclared, unknownLevel]) {
        await probe.decide(route.controller, route.handler, probe.bearer({ id: 'u-4', roles: ['editor'] }));
      }
      expect(mentions('undeclared')).toHaveLength(1);
      expect(mentions('undeclared')[0]).toContain('没有声明访问级别');
      expect(mentions('undeclared')[0]).toContain('按仅管理员处理');
      expect(mentions('unknownLevel')).toHaveLength(1);
      expect(mentions('unknownLevel')[0]).toContain('声明了未知的访问级别 "everyone"');
    });

    it('已注册的路由一个都没有触发装配错误', async () => {
      const admin = probe.bearer({ id: 'u-5', roles: ['admin'] });
      for (const route of [...ROUTES, undeclared]) await probe.decide(route.controller, route.handler, admin);
      const routeNames = ROUTES.map((r) => `${r.controller.name}.${r.handlerName}`);
      expect(routeNames.length).toBe(Object.keys(MATRIX).length);
      expect(wiringErrors().filter((m) => routeNames.some((name) => m.includes(`${name} `)))).toEqual([]);
      // 对照：探针 handler 确实会被这条规则抓到（防止匹配写法失效后断言变空）
      expect(wiringErrors().some((m) => m.includes('WiringProbeController.undeclared '))).toBe(true);
    });
  });

  describe('(d) 守卫装配', () => {
    it('AppModule 依次注册 ThrottlerBehindProxyGuard、AccessGuard 为全局守卫（先限流、再鉴权）', () => {
      const appGuards = (providers: unknown[]) =>
        providers
          .filter((p): p is { provide: unknown; useClass: unknown } => !!p && typeof p === 'object' && (p as any).provide === APP_GUARD)
          .map((p) => p.useClass);
      // Nest 按扫描顺序（AppModule 最先）依次执行 APP_GUARD；两个都只在 AppModule 注册，顺序就只取决于这里。
      // 以 useValue / useExisting 注册的守卫在这里映射为 undefined，同样会让断言失败
      expect(appGuards(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AppModule) ?? [])).toEqual([
        ThrottlerBehindProxyGuard,
        AccessGuard,
      ]);
      expect(
        APP_MODULES.filter((m) => m.moduleClass !== AppModule)
          .filter((m) => appGuards(m.providers).length > 0)
          .map((m) => m.moduleClass.name),
      ).toEqual([]);
    });
  });

  describe.each(ROUTES.map((r) => [describeRoute(r), r] as const))('%s', (_name, route) => {
    it('(a) 访问级别与 MATRIX 一致', () => {
      expect(route.level).toBe(MATRIX[route.key]);
    });

    it('(d) 路由上没有任何守卫，也没有遗留的 @Roles 元数据（鉴权只在全局 AccessGuard）', () => {
      expect(route.guards).toEqual([]);
      expect(route.legacyRoles).toBeUndefined();
    });

    it('(b) 真实 AccessGuard 对各类身份的裁决符合该级别', async () => {
      expect(await decisionTable(route)).toEqual(expectedTable(MATRIX[route.key]));
    });

    it('(b) 放行后 req.user 与翻转前相同，passport 每个请求最多跑一次', async () => {
      const level = MATRIX[route.key];
      const observed: Record<string, unknown> = {};
      const expected: Record<string, unknown> = {};
      for (const [label, principal] of PRINCIPALS) {
        const headers: Array<[string, string | undefined]> =
          principal === INVALID_TOKEN
            ? INVALID_HEADERS.map(([l, h]) => [`${label}:${l}`, h])
            : [[label, principal === undefined ? undefined : probe.bearer(principal)]];
        for (const [name, header] of headers) {
          const outcome = await probe.decide(route.controller, route.handler, header);
          observed[name] = {
            strategyRuns: outcome.strategyRuns,
            userWritten: outcome.userWritten,
            user: outcome.user
              ? { id: (outcome.user as ProbeUser).id, roles: (outcome.user as ProbeUser).roles }
              : outcome.user,
          };
          const user = principal && principal !== INVALID_TOKEN ? principal : undefined;
          const parsesToken = level !== 'public' && !(level === 'optional' && header === undefined);
          expected[name] = {
            // public 不解析 token；optional 没带凭据不跑 passport；其余每个请求恰好一次
            strategyRuns: parsesToken ? 1 : 0,
            // public 不碰 req.user；optional 没带凭据显式写 undefined；其余由 passport 写入（验不过时不写；
            // 验过了但角色不够时已写入，随后 403 —— 与翻转前 AuthGuard 在前、RolesGuard 在后一致）
            userWritten: level === 'public' ? false : parsesToken ? user !== undefined : true,
            user: parsesToken && user ? { id: user.id, roles: user.roles } : undefined,
          };
        }
      }
      expect(observed).toEqual(expected);
    });
  });

  describe('(e) portal 依赖的接口必须匿名可达', () => {
    const portalRoot = path.join(REPO_ROOT, 'portal');

    it.each(PORTAL_PATHS)('%s 是 public 或 optional', async (key) => {
      expect(ROUTE_BY_KEY.has(key)).toBe(true);
      expect(['public', 'optional']).toContain(MATRIX[key]);
      expect(await decide(ROUTE_BY_KEY.get(key)!, undefined)).toBe('allow');
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

    it('带 Authorization 的调用只有 PORTAL_TOKEN_CALLS：都是 optional，且所在文件在 401 时以游客身份重试', () => {
      const filesWithToken = portalSourceFiles(portalRoot).filter((f) =>
        /\bAuthorization\b/.test(fs.readFileSync(f, 'utf8')),
      );
      expect(filesWithToken.length).toBeGreaterThan(0); // 防止扫描规则失效后测试变空

      const tokenCallKeys = scanPortalCalls(portalRoot, filesWithToken).map((c) => resolveCall(c)?.key ?? callKey(c));
      expect([...new Set(tokenCallKeys)].sort()).toEqual([...PORTAL_TOKEN_CALLS].sort());
      expect(PORTAL_TOKEN_CALLS.filter((k) => MATRIX[k] !== 'optional')).toEqual([]);
      // 重试写法：`if (res.status === 401 && token) ...`（去掉 token 再发一次）
      expect(
        filesWithToken
          .filter((f) => !/\.status === 401 && token\b/.test(fs.readFileSync(f, 'utf8')))
          .map((f) => path.relative(REPO_ROOT, f)),
      ).toEqual([]);
    });
  });

  describe('(f) admin SPA 的调用都能解析到已注册路由', () => {
    const apiDir = path.join(REPO_ROOT, 'frontend', 'src', 'api');

    it('frontend/src/api 下每个 apiClient 调用都命中路由，且 admin 角色可访问', async () => {
      expect(fs.existsSync(apiDir)).toBe(true);
      const calls = scanAdminCalls(apiDir);
      expect(calls.length).toBeGreaterThan(80); // 防止扫描规则失效后测试变空

      const problems: string[] = [];
      for (const c of calls) {
        if (KNOWN_UNRESOLVED_ADMIN_CALLS.includes(callKey(c))) continue;
        const route = resolveCall(c);
        if (!route) {
          problems.push(`${callKey(c)} 解析不到后端路由  ← ${c.file}`);
          continue;
        }
        const verdict = await decide(route, { id: 'admin', roles: ['admin'] });
        if (verdict !== 'allow') problems.push(`${callKey(c)} → ${route.key} 对 admin 返回 ${JSON.stringify(verdict)}`);
      }
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
