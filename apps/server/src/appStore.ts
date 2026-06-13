import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ChatResponse } from "./assistant";

export type AppUser = {
  id: string;
  name: string;
  createdAt: string;
};

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
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CustomerSessionView = StoredCustomerSession & {
  messages: StoredMessage[];
};

type StoreData = {
  users: AppUser[];
  sessions: StoredCustomerSession[];
  messages: StoredMessage[];
};

const emptyStore = (): StoreData => ({
  users: [],
  sessions: [],
  messages: []
});

export class JsonAppStore {
  constructor(private readonly filePath: string) {}

  async upsertUserByName(name: string): Promise<AppUser> {
    const cleanName = name.trim();
    if (!cleanName) {
      throw new Error("name is required");
    }

    const data = await this.read();
    const existing = data.users.find((user) => user.name === cleanName);
    if (existing) return existing;

    const user: AppUser = {
      id: crypto.randomUUID(),
      name: cleanName,
      createdAt: new Date().toISOString()
    };
    data.users.push(user);
    await this.write(data);
    return user;
  }

  async getUser(userId: string): Promise<AppUser> {
    const data = await this.read();
    const user = data.users.find((item) => item.id === userId);
    if (!user) {
      throw new Error("user not found");
    }
    return user;
  }

  async createCustomerSession(ownerUserId: string, customerName: string): Promise<CustomerSessionView> {
    const data = await this.read();
    this.assertUserExists(data, ownerUserId);
    const now = new Date().toISOString();
    const session: StoredCustomerSession = {
      id: crypto.randomUUID(),
      ownerUserId,
      customerName: customerName.trim() || `客户 ${data.sessions.filter((item) => item.ownerUserId === ownerUserId).length + 1}`,
      status: "待输入需求",
      latestResponse: null,
      lastMessageAt: null,
      createdAt: now,
      updatedAt: now
    };
    data.sessions.push(session);
    await this.write(data);
    return { ...session, messages: [] };
  }

  async listCustomerSessions(ownerUserId: string): Promise<CustomerSessionView[]> {
    const data = await this.read();
    this.assertUserExists(data, ownerUserId);
    return data.sessions
      .filter((session) => session.ownerUserId === ownerUserId)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .map((session) => ({
        ...session,
        messages: data.messages.filter((message) => message.sessionId === session.id)
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
      messages: data.messages.filter((message) => message.sessionId === session.id)
    };
  }

  async addMessage(
    ownerUserId: string,
    sessionId: string,
    role: StoredMessage["role"],
    content: string
  ): Promise<StoredMessage> {
    const data = await this.read();
    const session = data.sessions.find((item) => item.id === sessionId && item.ownerUserId === ownerUserId);
    if (!session) {
      throw new Error("customer session not found");
    }

    const now = new Date().toISOString();
    const message: StoredMessage = {
      id: crypto.randomUUID(),
      sessionId,
      role,
      content,
      createdAt: now
    };
    data.messages.push(message);
    session.lastMessageAt = now;
    session.updatedAt = now;
    await this.write(data);
    return message;
  }

  async saveAssistantResult(ownerUserId: string, sessionId: string, result: ChatResponse, assistantText: string): Promise<void> {
    const data = await this.read();
    const session = data.sessions.find((item) => item.id === sessionId && item.ownerUserId === ownerUserId);
    if (!session) {
      throw new Error("customer session not found");
    }

    const now = new Date().toISOString();
    session.latestResponse = result;
    session.status = deriveStatus(result);
    session.lastMessageAt = now;
    session.updatedAt = now;
    data.messages.push({
      id: crypto.randomUUID(),
      sessionId,
      role: "assistant",
      content: assistantText,
      createdAt: now
    });
    await this.write(data);
  }

  private async read(): Promise<StoreData> {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8")) as StoreData;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyStore();
      }
      throw error;
    }
  }

  private async write(data: StoreData): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`);
  }

  private assertUserExists(data: StoreData, ownerUserId: string): void {
    if (!data.users.some((user) => user.id === ownerUserId)) {
      throw new Error("user not found");
    }
  }
}

function deriveStatus(result: ChatResponse): string {
  if (result.followUpQuestion) {
    return `待补充：${result.requirement.missingRequiredSlots.join("、")}`;
  }
  if (result.recommendations.length > 0) {
    return `已推荐 ${result.recommendations.length} 套`;
  }
  return "暂无合适房源";
}
