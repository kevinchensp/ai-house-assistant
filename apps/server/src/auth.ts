import type express from "express";
import type { AppUser, JsonAppStore } from "./appStore";

type AuthToken = {
  token: string;
  userId: string;
};

export class AuthService {
  private readonly tokens = new Map<string, string>();

  constructor(private readonly store: JsonAppStore) {}

  async login(name: string): Promise<AuthToken & { user: AppUser }> {
    const user = await this.store.upsertUserByName(name);
    const token = crypto.randomUUID();
    this.tokens.set(token, user.id);
    return { token, userId: user.id, user };
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
