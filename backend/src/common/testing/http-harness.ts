import 'reflect-metadata';
import { Provider, Type, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { NestExpressApplication } from '@nestjs/platform-express';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import * as request from 'supertest';

import { AuthService } from '../../modules/auth/auth.service';
import { JwtStrategy } from '../../modules/auth/strategies/jwt.strategy';
import { UserService } from '../../modules/user/user.service';
import { RoleService } from '../../modules/role/role.service';
import { AuditService } from '../../modules/audit/audit.service';
import { User } from '../../modules/user/entities/user.entity';
import { Role } from '../../modules/role/entities/role.entity';
import { Permission } from '../../modules/role/entities/permission.entity';
import { AuditLog } from '../../modules/audit/entities/audit-log.entity';
import { MediaFile } from '../../modules/media/entities/media-file.entity';
import { Content } from '../../modules/content/entities/content.entity';
import { Category } from '../../modules/category/entities/category.entity';
import { Comment } from '../../modules/comment/entities/comment.entity';
import { HttpExceptionFilter } from '../filters/http-exception.filter';
import { TransformInterceptor } from '../interceptors/transform.interceptor';
import { globalValidationPipeOptions } from '../pipes/global-validation';

/**
 * 测试用的真实 HTTP 应用（仅供 *.spec.ts 使用，不参与运行时）：
 * 被测 controller / service + 真实的 Access 守卫链（严格可选登录、JwtStrategy、RolesGuard）+ 与 main.ts 相同的
 * 全局 ValidationPipe、异常过滤器、响应包装（{ success, data }）与 trust proxy，数据落在内存 SQLite。
 *
 * token 用测试密钥直接签发（与 AuthService 同形状），JwtStrategy 照常验签并从库里加载用户与角色 —— 不跑 bcrypt。
 * 预置四种身份：anonymous（不带 token）、plain（登录但没有角色）、editor、admin。
 */

const ACCESS_SECRET = 'http-harness-access-secret-0123456789abcdef';
const REFRESH_SECRET = 'http-harness-refresh-secret-fedcba9876543210';

export type Who = 'anonymous' | 'plain' | 'editor' | 'admin';
export const WHO: readonly Who[] = ['anonymous', 'plain', 'editor', 'admin'];

/** 与 Redis 缓存同语义（值经 JSON 往返） */
class JsonCache {
  readonly store = new Map<string, string>();
  async get<T>(key: string): Promise<T | undefined> {
    const raw = this.store.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }
  async set(key: string, value: unknown): Promise<void> {
    this.store.set(key, JSON.stringify(value));
  }
  async del(key: string): Promise<void> {
    this.store.delete(key);
  }
}

/** JwtStrategy 加载用户时会 join 到的实体闭包（小说章节等用了 SQLite 不支持的 longtext，不能全量装载） */
const AUTH_ENTITIES = [User, Role, Permission, AuditLog, MediaFile, Content, Category, Comment];

export interface HarnessOptions {
  controllers: Type<unknown>[];
  providers: Provider[];
  /** 除鉴权闭包外还需要的实体（会同时注册为 forFeature） */
  entities?: Type<unknown>[];
  imports?: Array<Type<unknown>>;
}

export interface HttpHarness {
  app: NestExpressApplication;
  moduleRef: TestingModule;
  ds: DataSource;
  ids: Record<Exclude<Who, 'anonymous'>, string>;
  http(): request.SuperTest<request.Test>;
  as(req: request.Test, who: Who): request.Test;
  get(path: string, who: Who): request.Test;
  post(path: string, who: Who, body?: object): request.Test;
  patch(path: string, who: Who, body?: object): request.Test;
  del(path: string, who: Who): request.Test;
  tokenFor(userId: string): string;
  close(): Promise<void>;
}

export async function createHttpHarness(options: HarnessOptions): Promise<HttpHarness> {
  const extra = options.entities ?? [];
  const entities = [...new Set([...AUTH_ENTITIES, ...extra])];

  const moduleRef = await Test.createTestingModule({
    imports: [
      TypeOrmModule.forRoot({
        type: 'better-sqlite3',
        database: ':memory:',
        entities,
        synchronize: true,
        logging: false,
      }),
      TypeOrmModule.forFeature(entities),
      PassportModule,
      JwtModule.register({ secret: ACCESS_SECRET, signOptions: { expiresIn: 3600 } }),
      ...(options.imports ?? []),
    ],
    controllers: options.controllers,
    providers: [
      ...options.providers,
      AuthService,
      JwtStrategy,
      UserService,
      RoleService,
      AuditService,
      {
        provide: ConfigService,
        useValue: new ConfigService({
          app: {
            jwt: { secret: ACCESS_SECRET, refreshSecret: REFRESH_SECRET, expiresIn: 3600, refreshExpiresIn: 86400 },
          },
        }),
      },
      { provide: CACHE_MANAGER, useValue: new JsonCache() },
    ],
  }).compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>();
  // 与 main.ts 相同：只信任最近一跳（nginx），req.ip 取 X-Forwarded-For 最右边那一项
  app.set('trust proxy', 1);
  app.useGlobalPipes(new ValidationPipe(globalValidationPipeOptions()));
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new TransformInterceptor());
  await app.init();
  await app.listen(0, '127.0.0.1');

  const ds = moduleRef.get(DataSource);
  const roleIds = {
    admin: (await ds.getRepository(Role).save({ name: 'admin', isSystem: true })).id,
    editor: (await ds.getRepository(Role).save({ name: 'editor', isSystem: true })).id,
  };

  async function createUser(name: string, roles: Array<'editor' | 'admin'>): Promise<string> {
    const user = await ds.getRepository(User).save({
      username: name,
      email: `${name}@cms.test`,
      // 不需要登录：token 直接签发，哈希只为满足 NOT NULL
      passwordHash: 'not-a-real-hash',
      nickname: name === 'admin' ? null : `${name}-昵称`,
      isActive: true,
    } as Partial<User>);
    for (const role of roles) {
      await ds.query('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', [user.id, roleIds[role]]);
    }
    return user.id;
  }

  const ids = {
    plain: await createUser('plain', []),
    editor: await createUser('editor', ['editor']),
    admin: await createUser('admin', ['admin']),
  };

  const jwt = new JwtService({ secret: ACCESS_SECRET });
  function tokenFor(userId: string): string {
    const now = Math.floor(Date.now() / 1000);
    return jwt.sign({
      sub: userId,
      email: 'x@cms.test',
      username: 'x',
      roles: [],
      type: 'access',
      jti: randomUUID(),
      iat: now,
      exp: now + 600,
    });
  }

  const http = () => request(app.getHttpServer());
  const as = (req: request.Test, who: Who) =>
    who === 'anonymous' ? req : req.set('Authorization', `Bearer ${tokenFor(ids[who])}`);

  return {
    app,
    moduleRef,
    ds,
    ids,
    http,
    as,
    get: (path, who) => as(http().get(path), who),
    post: (path, who, body) => as(http().post(path), who).send(body ?? {}),
    patch: (path, who, body) => as(http().patch(path), who).send(body ?? {}),
    del: (path, who) => as(http().delete(path), who),
    tokenFor,
    close: async () => {
      await app.close();
    },
  };
}
