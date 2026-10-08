import { User } from '../../user/entities/user.entity';

export type TokenType = 'access' | 'refresh';

/**
 * access token 的载荷。type 必须是 'access'：JwtStrategy 拒绝其他类型（含不带 type 的旧 token），
 * refresh token 因此不能当 Bearer 用。roles / email / username 只是签发时的快照，
 * 鉴权一律以 JwtStrategy 从库里加载的用户为准。
 */
export interface JwtPayload {
  sub: string; // 用户ID
  email: string;
  username: string;
  roles: string[];
  type?: TokenType;
  /** 每个 token 唯一：同一秒内签发的两个 token 也不会相同，拉黑一个不会误伤另一个 */
  jti?: string;
  iat?: number;
  exp?: number;
}

/** refresh token 的载荷：只带用户 ID，用独立的 refresh 密钥签名 */
export interface RefreshTokenPayload {
  sub: string;
  type: 'refresh';
  jti: string;
  iat: number;
  exp: number;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
}

export interface LoginResponse {
  user: {
    id: string;
    username: string;
    email: string;
    nickname?: string;
    avatarUrl?: string;
    roles: string[];
    isActive: boolean;
  };
  tokens: AuthTokens;
}

export interface AuthUser {
  id: string;
  username: string;
  email: string;
  nickname?: string;
  avatarUrl?: string;
  roles: string[];
  permissions: string[];
  isActive: boolean;
}

export interface SessionInfo {
  sessionId: string;
  userId: string;
  ipAddress: string;
  userAgent: string;
  loginTime: Date;
  lastActivity: Date;
  isActive: boolean;
}

export interface RefreshTokenData {
  token: string;
  userId: string;
  expiresAt: Date;
  createdAt: Date;
  userAgent?: string;
  ipAddress?: string;
}
