import { User } from '../../user/entities/user.entity';

export interface JwtPayload {
  sub: string; // 用户ID
  email: string;
  username: string;
  roles: string[];
  iat?: number;
  exp?: number;
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
