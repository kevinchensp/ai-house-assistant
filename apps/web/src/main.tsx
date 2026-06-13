import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CheckCircle2, Copy, Home, MapPin, Plus, Send, Sparkles, ThumbsDown, Users } from "lucide-react";
import "./styles.css";

type ChatResponse = {
  sessionId: string;
  requirement: {
    location: { normalized: string; district: string | null; confidence: number } | null;
    budget: { target: number; min: number; max: number } | null;
    layout: { bedroom: number | null; livingRoom: number | null };
    preferences: {
      rentType: string | null;
      direction: string | null;
      minArea: number | null;
      moveInDate: string | null;
      features: string[];
    };
    missingRequiredSlots: string[];
  };
  followUpQuestion: string | null;
  searchTrace: Array<{ name: string; resultCount: number }>;
  recommendations: Array<{
    houseId: string;
    buildingName: string;
    houseNumber: string;
    rentPrice: number;
    deposit: number;
    bedroom: number;
    livingRoom: number;
    toilet: number;
    area: number;
    score: number;
    recommendationReason: string;
    mismatchNote: string | null;
  }>;
  salesReply: {
    text: string;
    nextAction: string;
  };
};

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3101";

type HealthResponse = {
  ok: boolean;
  mcpMode: "remote" | "mock";
  llmMode: "bailian" | "mock";
  llmModel: string;
};

type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
};

type CustomerSession = {
  id: string;
  name: string;
  draft: string;
  messages: ChatMessage[];
  response: ChatResponse | null;
  updatedAt: number;
};

type AuthUser = {
  id: string;
  name: string;
};

type StoredCustomerSession = {
  id: string;
  customerName: string;
  status: string;
  latestResponse: ChatResponse | null;
  updatedAt: string;
  messages: Array<{
    id: string;
    role: "assistant" | "user";
    content: string;
    createdAt: string;
  }>;
};

const welcomeMessage: ChatMessage = {
  id: "welcome",
  role: "assistant",
  text: "你好，我是运东 Ai 找房助手。把客户的区域、预算、户型发给我，我会先查严格匹配，没房源时再按周边距离和预算策略扩圈。"
};

function createLocalCustomerSession(index: number): CustomerSession {
  return {
    id: crypto.randomUUID(),
    name: `客户 ${index}`,
    draft: index === 1 ? "帮我找白云东平一室一厅，预算1000左右" : "",
    messages: [welcomeMessage],
    response: null,
    updatedAt: Date.now()
  };
}

function mapStoredSession(session: StoredCustomerSession): CustomerSession {
  return {
    id: session.id,
    name: session.customerName,
    draft: "",
    messages: session.messages.length
      ? session.messages.map((message) => ({
          id: message.id,
          role: message.role,
          text: message.content
        }))
      : [welcomeMessage],
    response: session.latestResponse,
    updatedAt: Date.parse(session.updatedAt)
  };
}

async function apiFetch(token: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const result = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init.headers
    }
  });
  if (!result.ok) {
    throw new Error(`API request failed with ${result.status}`);
  }
  return result.json();
}

function App() {
  const [authToken, setAuthToken] = useState(() => localStorage.getItem("ai-house-auth-token"));
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loginName, setLoginName] = useState("小陈");
  const [authError, setAuthError] = useState<string | null>(null);
  const [customers, setCustomers] = useState<CustomerSession[]>([]);
  const [activeCustomerId, setActiveCustomerId] = useState<string | null>(null);
  const [loadingCustomerId, setLoadingCustomerId] = useState<string | null>(null);
  const [copiedCustomerId, setCopiedCustomerId] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const activeCustomer = customers.find((customer) => customer.id === activeCustomerId) ?? customers[0];
  const isLoading = loadingCustomerId === activeCustomer?.id;
  const copied = copiedCustomerId === activeCustomer?.id;
  const response = activeCustomer?.response ?? null;

  useEffect(() => {
    if (!activeCustomerId && customers[0]) {
      setActiveCustomerId(customers[0].id);
    }
  }, [activeCustomerId, customers]);

  useEffect(() => {
    if (!authToken) return;
    const token = authToken;
    let ignore = false;
    async function bootstrap() {
      try {
        const me = (await apiFetch(token, "/api/me")) as { user: AuthUser };
        const sessionPayload = (await apiFetch(token, "/api/customer-sessions")) as {
          sessions: StoredCustomerSession[];
        };
        if (ignore) return;
        setUser(me.user);
        const sessions = sessionPayload.sessions.length
          ? sessionPayload.sessions
          : [
              ((await apiFetch(token, "/api/customer-sessions", {
                method: "POST",
                body: JSON.stringify({ customerName: "客户 1" })
              })) as { session: StoredCustomerSession }).session
            ];
        const nextCustomers = sessions.map(mapStoredSession);
        setCustomers(nextCustomers);
        setActiveCustomerId((current) => current ?? nextCustomers[0]?.id ?? null);
        setAuthError(null);
      } catch {
        if (ignore) return;
        localStorage.removeItem("ai-house-auth-token");
        setAuthToken(null);
        setUser(null);
        setCustomers([]);
        setActiveCustomerId(null);
      }
    }
    void bootstrap();
    return () => {
      ignore = true;
    };
  }, [authToken]);

  useEffect(() => {
    let ignore = false;
    void fetch(`${apiBaseUrl}/api/health`)
      .then((result) => result.json() as Promise<HealthResponse>)
      .then((nextHealth) => {
        if (!ignore) setHealth(nextHealth);
      })
      .catch(() => {
        if (!ignore) setHealth(null);
      });

    return () => {
      ignore = true;
    };
  }, []);

  async function submit() {
    if (!activeCustomer || !authToken) return;
    const trimmedMessage = activeCustomer.draft.trim();
    if (!trimmedMessage || loadingCustomerId) return;

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text: trimmedMessage
    };
    setCustomers((current) =>
      current.map((customer) =>
        customer.id === activeCustomer.id
          ? {
              ...customer,
              draft: "",
              messages: [...customer.messages, userMessage],
              updatedAt: Date.now()
            }
          : customer
      )
    );
    setLoadingCustomerId(activeCustomer.id);
    setCopiedCustomerId(null);
    try {
      const result = await fetch(`${apiBaseUrl}/api/ai-house-assistant/chat`, {
        method: "POST",
        headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: activeCustomer.id, message: trimmedMessage })
      });
      const nextResponse = (await result.json()) as ChatResponse;
      setCustomers((current) =>
        current.map((customer) =>
          customer.id === activeCustomer.id
            ? {
                ...customer,
                response: nextResponse,
                messages: [
                  ...customer.messages,
                  {
                    id: crypto.randomUUID(),
                    role: "assistant",
                    text: buildAssistantMessage(nextResponse)
                  }
                ],
                updatedAt: Date.now()
              }
            : customer
        )
      );
    } finally {
      setLoadingCustomerId(null);
    }
  }

  async function copyReply() {
    if (!response || !activeCustomer) return;
    await navigator.clipboard.writeText(response.salesReply.text);
    setCopiedCustomerId(activeCustomer.id);
  }

  function updateDraft(value: string) {
    if (!activeCustomer) return;
    setCustomers((current) =>
      current.map((customer) => (customer.id === activeCustomer.id ? { ...customer, draft: value } : customer))
    );
  }

  function createCustomer() {
    if (!authToken) return;
    void apiFetch(authToken, "/api/customer-sessions", {
      method: "POST",
      body: JSON.stringify({ customerName: `客户 ${customers.length + 1}` })
    }).then((payload) => {
      const nextCustomer = mapStoredSession((payload as { session: StoredCustomerSession }).session);
      setCustomers((current) => [nextCustomer, ...current]);
      setActiveCustomerId(nextCustomer.id);
      setCopiedCustomerId(null);
    });
  }

  async function login() {
    const cleanName = loginName.trim();
    if (!cleanName) return;
    setAuthError(null);
    try {
      const payload = (await fetch(`${apiBaseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: cleanName })
      }).then((result) => result.json())) as { token: string; user: AuthUser };
      localStorage.setItem("ai-house-auth-token", payload.token);
      setAuthToken(payload.token);
      setUser(payload.user);
    } catch {
      setAuthError("登录失败，请稍后重试。");
    }
  }

  function logout() {
    localStorage.removeItem("ai-house-auth-token");
    setAuthToken(null);
    setUser(null);
    setCustomers([]);
    setActiveCustomerId(null);
  }

  if (!authToken || !user) {
    return (
      <main className="app-shell login-shell">
        <section className="login-card">
          <Sparkles size={28} />
          <h1>运东 Ai 找房助手</h1>
          <p>输入客服姓名进入个人客户队列。MVP 暂不做用户组和复杂权限。</p>
          <input
            value={loginName}
            onChange={(event) => setLoginName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void login();
            }}
            placeholder="客服姓名，例如：小陈"
          />
          {authError ? <span className="login-error">{authError}</span> : null}
          <button className="secondary-button" onClick={login} disabled={!loginName.trim()}>
            登录
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <h1>运东 Ai 找房助手</h1>
          <p className="user-line">当前客服：{user.name}</p>
        </div>
        <div className="topbar-actions">
          <div className="status-pill">
            <span />
            {health ? `MCP ${health.mcpMode} · ${health.llmMode === "bailian" ? health.llmModel : "local mock"}` : "连接中"}
          </div>
          <button className="ghost-button" onClick={logout}>退出</button>
        </div>
      </section>

      <section className="workspace">
        <aside className="customer-sidebar">
          <div className="customer-sidebar-header">
            <div className="section-title">
              <Users size={18} />
              <h2>客户队列</h2>
            </div>
            <button className="new-customer-button" onClick={createCustomer}>
              <Plus size={16} />
              新客户
            </button>
          </div>

          <div className="customer-list">
            {customers.map((customer) => (
              <button
                className={`customer-card ${customer.id === activeCustomer?.id ? "active" : ""}`}
                key={customer.id}
                onClick={() => {
                  setActiveCustomerId(customer.id);
                  setCopiedCustomerId(null);
                }}
              >
                <div className="customer-card-title">
                  <strong>{customer.name}</strong>
                  <span>{formatUpdatedAt(customer.updatedAt)}</span>
                </div>
                <p>{buildCustomerSummary(customer)}</p>
                <small>{buildCustomerStatus(customer)}</small>
              </button>
            ))}
          </div>
        </aside>

        <section className="chat-panel">
          <div className="chat-thread" aria-live="polite">
            {activeCustomer?.messages.map((chatMessage) => (
              <article className={`chat-message ${chatMessage.role}`} key={chatMessage.id}>
                <div className="avatar">{chatMessage.role === "assistant" ? <Sparkles size={18} /> : "客"}</div>
                <div className="bubble">
                  <p>{chatMessage.text}</p>
                </div>
              </article>
            ))}
            {isLoading ? (
              <article className="chat-message assistant">
                <div className="avatar"><Sparkles size={18} /></div>
                <div className="bubble typing">
                  <span />
                  <span />
                  <span />
                </div>
              </article>
            ) : null}
          </div>

          <div className="composer">
            <textarea
              value={activeCustomer?.draft ?? ""}
              onChange={(event) => updateDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder="输入客户需求，例如：白云东平一室一厅，预算1000左右"
            />
            <button className="send-button" onClick={submit} disabled={Boolean(loadingCustomerId) || !activeCustomer?.draft.trim()} title="发送需求">
              <Send size={20} />
            </button>
          </div>
        </section>

        <aside className="insight-sidebar">
          <section className="sidebar-section">
            <div className="section-title">
              <MapPin size={18} />
              <h2>需求摘要</h2>
            </div>
            {response ? (
              <div className="summary-band">
                <div>
                  <span>位置</span>
                  <strong>
                    {response.requirement.missingRequiredSlots.includes("location")
                      ? "待确认"
                      : response.requirement.location?.normalized ?? "待确认"}
                  </strong>
                </div>
                <div>
                  <span>预算</span>
                  <strong>
                    {response.requirement.budget
                      ? `${response.requirement.budget.min}-${response.requirement.budget.max}`
                      : "待确认"}
                  </strong>
                </div>
                <div>
                  <span>户型</span>
                  <strong>{formatRequirementLayout(response.requirement.layout)}</strong>
                </div>
                <div className="summary-wide">
                  <span>偏好</span>
                  {buildPreferenceChips(response).length ? (
                    <div className="preference-chips">
                      {buildPreferenceChips(response).map((chip) => (
                        <strong key={chip}>{chip}</strong>
                      ))}
                    </div>
                  ) : (
                    <strong>暂无额外偏好</strong>
                  )}
                </div>
              </div>
            ) : (
              <p className="muted">发送客户需求后自动生成摘要。</p>
            )}
          </section>

          <section className="sidebar-section">
            <div className="section-title">
              <Home size={18} />
              <h2>推荐结果</h2>
            </div>
            {response?.recommendations.length ? (
              <div className="house-list">
                {response.recommendations.map((house) => (
                  <article className="house-card" key={house.houseId}>
                    <div className="house-title">
                      <h3>
                        {house.buildingName} {house.houseNumber}
                      </h3>
                      <strong>{house.rentPrice}元</strong>
                    </div>
                    <div className="house-meta">
                      <span>{house.bedroom}室{house.livingRoom}厅{house.toilet}卫</span>
                      <span>{house.area}平</span>
                      <span>押金 {house.deposit}</span>
                    </div>
                    <p>{house.recommendationReason}</p>
                    {house.mismatchNote ? <p className="warning">{house.mismatchNote}</p> : null}
                    <div className="feedback-row">
                      <button><CheckCircle2 size={16} /> 合适</button>
                      <button><ThumbsDown size={16} /> 不合适</button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-state">推荐房源会在这里出现。</div>
            )}
          </section>

          <section className="sidebar-section">
            <div className="section-title">
              <Copy size={18} />
              <h2>客服话术</h2>
            </div>
            <pre>{response?.salesReply.text ?? "生成后可一键复制给客户。"}</pre>
            <button className="secondary-button" onClick={copyReply} disabled={!response}>
              <Copy size={16} />
              {copied ? "已复制" : "复制话术"}
            </button>
          </section>
        </aside>
      </section>
    </main>
  );
}

function buildAssistantMessage(response: ChatResponse): string {
  if (response.followUpQuestion) {
    return response.followUpQuestion;
  }
  const traceText = response.searchTrace
    .map((step) => `${step.name === "strict_keyword" ? "精确匹配" : "周边扩圈"} ${step.resultCount} 套`)
    .join("，");
  const topHouse = response.recommendations[0];
  if (!topHouse) {
    return "这组条件暂时没找到合适房源。我建议先问客户是否能接受周边位置或预算上浮。";
  }
  return `我查完了：${traceText}。优先推荐 ${topHouse.buildingName} ${topHouse.houseNumber}，${topHouse.bedroom}室${topHouse.livingRoom}厅，租金${topHouse.rentPrice}元。右侧已经整理好推荐卡片和可复制话术。`;
}

function formatRequirementLayout(layout: ChatResponse["requirement"]["layout"]): string {
  const bedroom = layout.bedroom === null ? "?" : layout.bedroom;
  if (layout.livingRoom === null) {
    return `${bedroom}室`;
  }
  return `${bedroom}室${layout.livingRoom}厅`;
}

function buildPreferenceChips(response: ChatResponse): string[] {
  const { preferences } = response.requirement;
  return [
    preferences.rentType,
    preferences.direction,
    preferences.minArea ? `${preferences.minArea}平以上` : null,
    preferences.moveInDate ? `${preferences.moveInDate}入住` : null,
    ...preferences.features
  ].filter((chip): chip is string => Boolean(chip));
}

function buildCustomerSummary(customer: CustomerSession): string {
  if (!customer.response) {
    const latestUserMessage = [...customer.messages].reverse().find((message) => message.role === "user");
    return latestUserMessage?.text ?? "等待输入客户需求";
  }

  const { requirement } = customer.response;
  const location = requirement.missingRequiredSlots.includes("location")
    ? "位置待确认"
    : requirement.location?.normalized ?? "位置待确认";
  const budget = requirement.budget ? `${requirement.budget.target}左右` : "预算待确认";
  const layout = requirement.layout.bedroom === null ? "户型待确认" : formatRequirementLayout(requirement.layout);
  return `${location} · ${budget} · ${layout}`;
}

function buildCustomerStatus(customer: CustomerSession): string {
  const response = customer.response;
  if (!response) {
    return "待输入需求";
  }
  if (response.followUpQuestion) {
    return `待补充：${response.requirement.missingRequiredSlots.map(formatMissingSlot).join("、")}`;
  }
  if (response.recommendations.length > 0) {
    return `已推荐 ${response.recommendations.length} 套，待客户反馈`;
  }
  return "暂无合适房源，待确认放宽条件";
}

function formatMissingSlot(slot: string): string {
  if (slot === "location") return "具体位置";
  if (slot === "budget") return "预算";
  if (slot === "layout") return "户型";
  return slot;
}

function formatUpdatedAt(updatedAt: number): string {
  const diffSeconds = Math.max(0, Math.floor((Date.now() - updatedAt) / 1000));
  if (diffSeconds < 60) return "刚刚";
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}分钟前`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}小时前`;
  return `${Math.floor(diffHours / 24)}天前`;
}

createRoot(document.getElementById("root")!).render(<App />);
