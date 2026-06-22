import type express from "express";
import type { AppUser, JsonAppStore, PublicUser } from "./appStore";
import { toPublicUser, verifyPassword } from "./appStore";

type AuthToken = {
  token: string;
  userId: string;
};

type StoredToken = {
  userId: string;
  expiresAt: number;
};

type AuthServiceOptions = {
  tokenTtlMs?: number;
};

const defaultTokenTtlMs = 8 * 60 * 60 * 1000;

export class AuthService {
  private readonly tokens = new Map<string, StoredToken>();
  private readonly tokenTtlMs: number;

  constructor(private readonly store: JsonAppStore, options: AuthServiceOptions = {}) {
    this.tokenTtlMs = options.tokenTtlMs ?? defaultTokenTtlMs;
  }

  async login(phone: string, password: string): Promise<AuthToken & { user: PublicUser }> {
    const user = await this.store.findUserByPhone(phone);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      const error = new Error("invalid phone or password");
      (error as Error & { status?: number }).status = 401;
      throw error;
    }

    const token = crypto.randomUUID();
    this.tokens.set(token, { userId: user.id, expiresAt: Date.now() + this.tokenTtlMs });
    return { token, userId: user.id, user: toPublicUser(user) };
  }

  getUserIdFromRequest(request: express.Request): string | null {
    const authorization = request.header("authorization") ?? "";
    return this.getUserIdFromAuthorization(authorization);
  }

  getUserIdFromAuthorization(authorization: string): string | null {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (!match?.[1]) return null;
    const token = match[1];
    const storedToken = this.tokens.get(token);
    if (!storedToken) return null;
    if (storedToken.expiresAt <= Date.now()) {
      this.tokens.delete(token);
      return null;
    }
    return storedToken.userId;
  }

  logout(token: string): void {
    this.tokens.delete(token);
  }
}

export function requireUserId(request: express.Request, authService: AuthService): string {
  const userId = authService.getUserIdFromRequest(request);
  if (!userId) {
    const error = new Error("unauthorized");
    (error as Error & { status?: number }).status = 401;
    throw error;
  }
  return userId;
}

export async function requireAdminUser(
  request: express.Request,
  authService: AuthService,
  store: JsonAppStore
): Promise<AppUser> {
  const user = await store.getUser(requireUserId(request, authService));
  if (user.role !== "admin") {
    const error = new Error("forbidden");
    (error as Error & { status?: number }).status = 403;
    throw error;
  }
  return user;
}
