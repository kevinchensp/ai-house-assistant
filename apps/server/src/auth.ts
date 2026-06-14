import type express from "express";
import type { AppUser, JsonAppStore, PublicUser } from "./appStore";
import { toPublicUser, verifyPassword } from "./appStore";

type AuthToken = {
  token: string;
  userId: string;
};

export class AuthService {
  private readonly tokens = new Map<string, string>();

  constructor(private readonly store: JsonAppStore) {}

  async login(phone: string, password: string): Promise<AuthToken & { user: PublicUser }> {
    const user = await this.store.findUserByPhone(phone);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      const error = new Error("invalid phone or password");
      (error as Error & { status?: number }).status = 401;
      throw error;
    }

    const token = crypto.randomUUID();
    this.tokens.set(token, user.id);
    return { token, userId: user.id, user: toPublicUser(user) };
  }

  getUserIdFromRequest(request: express.Request): string | null {
    const authorization = request.header("authorization") ?? "";
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (!match?.[1]) return null;
    return this.tokens.get(match[1]) ?? null;
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
