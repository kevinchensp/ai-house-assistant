import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { createEmptyCustomerProfile, type CustomerProfile, type RankedHouse } from "@ai-house-assistant/shared";
import type { ChatResponse } from "./assistant";

export type UserRole = "admin" | "agent";

export type AppUser = {
  id: string;
  name: string;
  phone: string;
  passwordHash: string;
  role: UserRole;
  createdAt: string;
};

export type PublicUser = Omit<AppUser, "passwordHash">;

export type StoredMessage = {
  id: string;
  sessionId: string;
  role: "assistant" | "user";
  content: string;
  createdAt: string;
};

export type StoredCustomerSession = {
  id: string;
  ownerUserId: string;
  customerName: string;
  status: string;
  latestResponse: ChatResponse | null;
  latestRecommendationPool: RankedHouse[] | null;
  customerProfile: CustomerProfile;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CustomerSessionView = StoredCustomerSession & {
  messages: StoredMessage[];
  feedbacks: StoredHouseFeedback[];
};

export type StoredHouseFeedback = {
  id: string;
  ownerUserId: string;
  sessionId: string;
  houseId: string;
  isSuitable: boolean;
  reason: string | null;
  createdAt: string;
};

type StoreData = {
  users: AppUser[];
  sessions: StoredCustomerSession[];
  messages: StoredMessage[];
  feedbacks: StoredHouseFeedback[];
};

const emptyStore = (): StoreData => ({
  users: [],
  sessions: [],
  messages: [],
  feedbacks: []
});

export class JsonAppStore {
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async ensureAdminUser(initialPassword?: string | null): Promise<AppUser> {
    return this.mutate((data) => {
      const existing = data.users.find((user) => user.phone === "admin");
      if (existing) return existing;
      if (!initialPassword) {
        throw new Error("ADMIN_INITIAL_PASSWORD is required to create the initial admin account");
      }

      const user: AppUser = {
        id: randomUUID(),
        name: "管理员",
        phone: "admin",
        passwordHash: hashPassword(initialPassword),
        role: "admin",
        createdAt: new Date().toISOString()
      };
      data.users.push(user);
      return user;
    });
  }

  async createUser(input: { name: string; phone: string; password: string; role?: UserRole }): Promise<AppUser> {
    const cleanName = input.name.trim();
    const cleanPhone = input.phone.trim();
    if (!cleanName) throw new Error("name is required");
    if (!cleanPhone) throw new Error("phone is required");
    if (input.password.length < 6) throw new Error("password must be at least 6 characters");

    return this.mutate((data) => {
      if (data.users.some((user) => user.phone === cleanPhone)) {
        const error = new Error("phone already exists");
        (error as Error & { status?: number }).status = 409;
        throw error;
      }

      const user: AppUser = {
        id: randomUUID(),
        name: cleanName,
        phone: cleanPhone,
        passwordHash: hashPassword(input.password),
        role: input.role ?? "agent",
        createdAt: new Date().toISOString()
      };
      data.users.push(user);
      return user;
    });
  }

  async findUserByPhone(phone: string): Promise<AppUser | null> {
    const cleanPhone = phone.trim();
    if (!cleanPhone) return null;
    const data = await this.read();
    return data.users.find((user) => user.phone === cleanPhone) ?? null;
  }

  async getUser(userId: string): Promise<AppUser> {
    const data = await this.read();
    const user = data.users.find((item) => item.id === userId);
    if (!user) {
      throw new Error("user not found");
    }
    return user;
  }

  async listUsers(): Promise<AppUser[]> {
    const data = await this.read();
    return [...data.users].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  async createCustomerSession(ownerUserId: string, customerName: string): Promise<CustomerSessionView> {
    return this.mutate((data) => {
      this.assertUserExists(data, ownerUserId);
      const now = new Date().toISOString();
      const session: StoredCustomerSession = {
        id: randomUUID(),
        ownerUserId,
        customerName: customerName.trim() || `客户 ${data.sessions.filter((item) => item.ownerUserId === ownerUserId).length + 1}`,
        status: "待输入需求",
        latestResponse: null,
        latestRecommendationPool: null,
        customerProfile: createEmptyCustomerProfile(),
        lastMessageAt: null,
        createdAt: now,
        updatedAt: now
      };
      data.sessions.push(session);
      return { ...session, messages: [], feedbacks: [] };
    });
  }

  async listCustomerSessions(ownerUserId: string): Promise<CustomerSessionView[]> {
    const data = await this.read();
    this.assertUserExists(data, ownerUserId);
    return data.sessions
      .filter((session) => session.ownerUserId === ownerUserId)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .map((session) => ({
        ...session,
        messages: data.messages.filter((message) => message.sessionId === session.id),
        feedbacks: data.feedbacks.filter((feedback) => feedback.sessionId === session.id)
      }));
  }

  async getCustomerSession(ownerUserId: string, sessionId: string): Promise<CustomerSessionView> {
    const data = await this.read();
    const session = data.sessions.find((item) => item.id === sessionId && item.ownerUserId === ownerUserId);
    if (!session) {
      throw new Error("customer session not found");
    }
    return {
      ...session,
      messages: data.messages.filter((message) => message.sessionId === session.id),
      feedbacks: data.feedbacks.filter((feedback) => feedback.sessionId === session.id)
    };
  }

  async renameCustomerSession(ownerUserId: string, sessionId: string, customerName: string): Promise<CustomerSessionView> {
    const nextName = customerName.trim();
    if (!nextName) {
      throw new Error("customer name is required");
    }
    return this.mutate((data) => {
      const session = data.sessions.find((item) => item.id === sessionId && item.ownerUserId === ownerUserId);
      if (!session) {
        throw new Error("customer session not found");
      }
      session.customerName = nextName;
      session.updatedAt = new Date().toISOString();
      return {
        ...session,
        messages: data.messages.filter((message) => message.sessionId === session.id),
        feedbacks: data.feedbacks.filter((feedback) => feedback.sessionId === session.id)
      };
    });
  }

  async addMessage(
    ownerUserId: string,
    sessionId: string,
    role: StoredMessage["role"],
    content: string
  ): Promise<StoredMessage> {
    return this.mutate((data) => {
      const session = data.sessions.find((item) => item.id === sessionId && item.ownerUserId === ownerUserId);
      if (!session) {
        throw new Error("customer session not found");
      }

      const now = new Date().toISOString();
      const message: StoredMessage = {
        id: randomUUID(),
        sessionId,
        role,
        content,
        createdAt: now
      };
      data.messages.push(message);
      session.lastMessageAt = now;
      session.updatedAt = now;
      return message;
    });
  }

  async saveAssistantResult(
    ownerUserId: string,
    sessionId: string,
    result: ChatResponse,
    assistantText: string,
    recommendationPool: RankedHouse[] = result.recommendations
  ): Promise<void> {
    return this.mutate((data) => {
      const session = data.sessions.find((item) => item.id === sessionId && item.ownerUserId === ownerUserId);
      if (!session) {
        throw new Error("customer session not found");
      }

      const now = new Date().toISOString();
      session.latestResponse = result;
      session.latestRecommendationPool = recommendationPool;
      session.status = deriveStatus(result);
      session.lastMessageAt = now;
      session.updatedAt = now;
      data.messages.push({
        id: randomUUID(),
        sessionId,
        role: "assistant",
        content: assistantText,
        createdAt: now
      });
    });
  }

  async addHouseFeedback(input: {
    ownerUserId: string;
    sessionId: string;
    houseId: string;
    isSuitable: boolean;
    reason?: string | null;
  }): Promise<StoredHouseFeedback> {
    return this.mutate((data) => {
      const session = data.sessions.find((item) => item.id === input.sessionId && item.ownerUserId === input.ownerUserId);
      if (!session) {
        throw new Error("customer session not found");
      }
      const feedback: StoredHouseFeedback = {
        id: randomUUID(),
        ownerUserId: input.ownerUserId,
        sessionId: input.sessionId,
        houseId: input.houseId,
        isSuitable: input.isSuitable,
        reason: input.reason?.trim() || null,
        createdAt: new Date().toISOString()
      };
      data.feedbacks.push(feedback);
      session.customerProfile = updateCustomerProfile(session.customerProfile ?? createEmptyCustomerProfile(), feedback);
      return feedback;
    });
  }

  private async read(): Promise<StoreData> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<StoreData>;
      return {
        users: (parsed.users ?? []) as AppUser[],
        sessions: (parsed.sessions ?? []).map((session) => ({
          ...session,
          customerProfile: session.customerProfile ?? createEmptyCustomerProfile()
        })) as StoredCustomerSession[],
        messages: parsed.messages ?? [],
        feedbacks: parsed.feedbacks ?? []
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyStore();
      }
      throw error;
    }
  }

  private async write(data: StoreData): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`);
    await rename(tempPath, this.filePath);
  }

  private async mutate<T>(callback: (data: StoreData) => T): Promise<T> {
    const operation = this.writeQueue.then(async () => {
      const data = await this.read();
      const result = callback(data);
      await this.write(data);
      return result;
    });
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  private assertUserExists(data: StoreData, ownerUserId: string): void {
    if (!data.users.some((user) => user.id === ownerUserId)) {
      throw new Error("user not found");
    }
  }
}

export function toPublicUser(user: AppUser): PublicUser {
  const { passwordHash: _passwordHash, ...publicUser } = user;
  return publicUser;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, passwordHash: string): boolean {
  const [algorithm, salt, expectedHash] = passwordHash.split("$");
  if (algorithm !== "scrypt" || !salt || !expectedHash) return false;
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function deriveStatus(result: ChatResponse): string {
  if (result.followUpQuestion) {
    return `待补充：${result.requirement.missingRequiredSlots.join("、")}`;
  }
  if (result.consultation) {
    if (result.answerMode === "price_range") return "已查询价格范围";
    if (result.answerMode === "area_inventory") return "已查询区域空房";
    if (result.answerMode === "building_detail") return "已查询楼栋详情";
    if (result.answerMode === "feature_inventory") return "已查询条件房源";
    if (result.answerMode === "move_in_inventory") return "已查询入住条件";
    if (result.answerMode === "payment_inventory") return "已查询付款条件";
    if (result.answerMode === "commute_ranking") return "已查询通勤排序";
    if (result.answerMode === "metro_line_inventory") return "已查询地铁沿线";
    if (result.answerMode === "metro_station_inventory") return "已查询地铁站点";
    if (result.answerMode === "area_layout_availability") return "已查询空房";
    return result.consultation.summary;
  }
  const recommendationTotal = result.recommendationPagination?.total ?? result.recommendations.length;
  if (recommendationTotal > 0) {
    return `已推荐 ${recommendationTotal} 套`;
  }
  return "暂无合适房源";
}

function updateCustomerProfile(profile: CustomerProfile, feedback: StoredHouseFeedback): CustomerProfile {
  const reason = feedback.reason;
  const feedbackReasonCounts = { ...profile.feedbackReasonCounts };
  if (reason) {
    feedbackReasonCounts[reason] = (feedbackReasonCounts[reason] ?? 0) + 1;
  }
  if (feedback.isSuitable || !reason) {
    return { ...profile, feedbackReasonCounts };
  }

  return {
    ...profile,
    feedbackReasonCounts,
    budgetSensitive: profile.budgetSensitive || reason === "价格高" && feedbackReasonCounts[reason] >= 2,
    distanceSensitive: profile.distanceSensitive || reason === "位置远" && feedbackReasonCounts[reason] >= 2,
    layoutStrict: profile.layoutStrict || reason === "户型不符" && feedbackReasonCounts[reason] >= 2,
    needsImages: profile.needsImages || reason === "没图" && feedbackReasonCounts[reason] >= 2,
    decorationSensitive: profile.decorationSensitive || reason === "装修差" && feedbackReasonCounts[reason] >= 2
  };
}
