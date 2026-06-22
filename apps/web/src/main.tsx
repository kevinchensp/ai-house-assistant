import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  CheckCircle2,
  Copy,
  Home,
  MapPin,
  Pencil,
  Plus,
  Send,
  ShieldCheck,
  Sparkles,
  ThumbsDown,
  Users
} from "lucide-react";
import logoUrl from "./assets/logo.png";
import "./styles.css";

type ChatResponse = {
  sessionId: string;
  answerMode?:
    | "recommend_houses"
    | "project_vacancy"
    | "building_detail"
    | "area_inventory"
    | "feature_inventory"
    | "move_in_inventory"
    | "payment_inventory"
    | "commute_ranking"
    | "metro_line_inventory"
    | "metro_station_inventory"
    | "price_range"
    | "distance_ranking"
    | "area_layout_availability";
  requirement: {
    location: {
      raw: string;
      normalized: string;
      city: string;
      district: string | null;
      confidence: number;
      center: { lng: number; lat: number } | null;
      placeType: string;
    } | null;
    budget: { target: number; min: number; max: number; confidence?: number } | null;
    layout: { bedroom: number | null; livingRoom: number | null; toilet?: number | null; confidence?: number };
    preferences: {
      rentType: string | null;
      direction: string | null;
      minArea: number | null;
      moveInDate: string | null;
      features: string[];
    };
    missingRequiredSlots: string[];
    shouldAskFollowUp: boolean;
    followUpQuestion: string | null;
  };
  followUpQuestion: string | null;
  searchTrace: Array<{ name: string; resultCount: number }>;
  consultation: {
    title: string;
    summary: string;
    metrics: Array<{ label: string; value: string }>;
  } | null;
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
    address?: string;
    coverImageUrl?: string | null;
    lng?: number | null;
    lat?: number | null;
    distanceMeters?: number | null;
  }>;
  recommendationPagination?: RecommendationPagination;
  salesReply: {
    text: string;
    nextAction: string;
  };
};

type RecommendationPagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
};

type CustomerProfile = {
  budgetSensitive: boolean;
  distanceSensitive: boolean;
  layoutStrict: boolean;
  needsImages: boolean;
  decorationSensitive: boolean;
  feedbackReasonCounts: Record<string, number>;
};

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? (import.meta.env.DEV ? "http://localhost:3101" : "");
const amapWebMapKey = import.meta.env.VITE_AMAP_WEB_MAP_KEY ?? "";
const amapSecurityJsCode = import.meta.env.VITE_AMAP_SECURITY_JS_CODE ?? "";

type ClientResolvedLocation = NonNullable<ChatResponse["requirement"]["location"]>;
type RecommendedHouse = ChatResponse["recommendations"][number];
type CoordinateHouse = RecommendedHouse & { lng: number; lat: number };
const maxRecommendationMapDistanceMeters = 50000;

type HealthResponse = {
  ok: boolean;
  mcpMode: "remote" | "mock";
  llmMode: "bailian" | "mock";
  llmModel: string;
  locationMode?: "amap" | "local";
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
  summaryRequirement: ChatResponse["requirement"] | null;
  customerProfile: CustomerProfile | null;
  feedbackByHouseId: Record<string, { isSuitable: boolean; reason: string | null }>;
  updatedAt: number;
};

type AuthUser = {
  id: string;
  name: string;
  phone: string;
  role: "admin" | "agent";
};

type AdminUser = AuthUser & {
  createdAt: string;
};

type StoredCustomerSession = {
  id: string;
  customerName: string;
  status: string;
  latestResponse: ChatResponse | null;
  customerProfile?: CustomerProfile | null;
  updatedAt: string;
  messages: Array<{
    id: string;
    role: "assistant" | "user";
    content: string;
    createdAt: string;
  }>;
  feedbacks?: Array<{
    houseId: string;
    isSuitable: boolean;
    reason: string | null;
  }>;
};

const welcomeMessage: ChatMessage = {
  id: "welcome",
  role: "assistant",
  text: "你好，我是运东 Ai 找房助手。把客户的区域、预算、户型发给我，我会先查严格匹配，没房源时再按周边距离和预算策略扩圈。"
};

function createClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const quickPrompts = [
  "白云东平一室一厅，预算1000左右",
  "永泰有什么房子",
  "3号线沿线房源",
  "3号线同和站房源",
  "白云永泰一居室价格范围",
  "龙湖31店还有什么空房"
];

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
    summaryRequirement: session.latestResponse?.requirement ?? null,
    customerProfile: session.customerProfile ?? null,
    feedbackByHouseId: Object.fromEntries(
      (session.feedbacks ?? []).map((feedback) => [
        feedback.houseId,
        { isSuitable: feedback.isSuitable, reason: feedback.reason }
      ])
    ),
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
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const [authToken, setAuthToken] = useState(() => localStorage.getItem("ai-house-auth-token"));
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loginPhone, setLoginPhone] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [currentView, setCurrentView] = useState<"workspace" | "admin">("workspace");
  const [customers, setCustomers] = useState<CustomerSession[]>([]);
  const [activeCustomerId, setActiveCustomerId] = useState<string | null>(null);
  const [loadingCustomerId, setLoadingCustomerId] = useState<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [recommendationView, setRecommendationView] = useState<"list" | "map">("list");
  const [workspaceFocus, setWorkspaceFocus] = useState<"chat" | "insights">("chat");
  const [editingCustomerId, setEditingCustomerId] = useState<string | null>(null);
  const [editingCustomerName, setEditingCustomerName] = useState("");
  const [isEditingRequirement, setIsEditingRequirement] = useState(false);
  const [requirementDraft, setRequirementDraft] = useState<ChatResponse["requirement"] | null>(null);
  const [loadingRecommendationPage, setLoadingRecommendationPage] = useState(false);
  const activeCustomer = customers.find((customer) => customer.id === activeCustomerId) ?? customers[0];
  const isLoading = loadingCustomerId === activeCustomer?.id;
  const response = activeCustomer?.response ?? null;
  const summaryRequirement = activeCustomer?.summaryRequirement ?? response?.requirement ?? null;
  const showQuickPrompts = !activeCustomer?.messages.some((message) => message.role === "user");

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
        if (me.user.role === "admin") {
          setCurrentView("admin");
        }
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
      id: createClientId(),
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
    setCopiedMessageId(null);
    try {
      const clientResolvedLocation = await resolveClientLocation(trimmedMessage).catch(() => null);
      const result = await fetch(`${apiBaseUrl}/api/ai-house-assistant/chat`, {
        method: "POST",
        headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: activeCustomer.id, message: trimmedMessage, clientResolvedLocation })
      });
      if (!result.ok) {
        if (result.status === 401) {
          localStorage.removeItem("ai-house-auth-token");
          setAuthToken(null);
          setUser(null);
        }
        throw new Error(`chat request failed with ${result.status}`);
      }
      const nextResponse = (await result.json()) as ChatResponse;
      const assistantMessageId = createClientId();
      if (nextResponse.recommendations.length > 0 || nextResponse.consultation) {
        setWorkspaceFocus("insights");
      }
      setCustomers((current) =>
        current.map((customer) =>
          customer.id === activeCustomer.id ? applyAssistantResponse(customer, nextResponse, assistantMessageId) : customer
        )
      );
    } catch {
      const assistantMessage: ChatMessage = {
        id: createClientId(),
        role: "assistant",
        text: "刚刚请求失败了，可能是服务或网络暂时不可用。请稍后重试，或联系管理员查看服务状态。"
      };
      setCustomers((current) =>
        current.map((customer) =>
          customer.id === activeCustomer.id
            ? {
                ...customer,
                messages: [...customer.messages, assistantMessage],
                updatedAt: Date.now()
              }
            : customer
        )
      );
    } finally {
      setLoadingCustomerId(null);
    }
  }

  async function copyChatMessage(message: ChatMessage) {
    await navigator.clipboard.writeText(message.text);
    setCopiedMessageId(message.id);
  }

  async function loadRecommendationPage(page: number) {
    if (!authToken || !activeCustomer?.response) return;
    const pageSize = activeCustomer.response.recommendationPagination?.pageSize ?? 10;
    setLoadingRecommendationPage(true);
    try {
      const payload = (await apiFetch(
        authToken,
        `/api/customer-sessions/${activeCustomer.id}/recommendations?page=${page}&pageSize=${pageSize}`
      )) as Pick<ChatResponse, "recommendations" | "recommendationPagination">;
      setCustomers((current) =>
        current.map((customer) =>
          customer.id === activeCustomer.id && customer.response
            ? {
                ...customer,
                response: {
                  ...customer.response,
                  recommendations: payload.recommendations,
                  recommendationPagination: payload.recommendationPagination
                },
                updatedAt: Date.now()
              }
            : customer
        )
      );
    } finally {
      setLoadingRecommendationPage(false);
    }
  }

  async function submitRequirementCorrection() {
    if (!authToken || !activeCustomer || !requirementDraft) return;
    setLoadingCustomerId(activeCustomer.id);
    try {
      const payload = (await apiFetch(authToken, `/api/customer-sessions/${activeCustomer.id}/requirement-correction`, {
        method: "POST",
        body: JSON.stringify({ requirement: normalizeRequirementDraft(requirementDraft) })
      })) as ChatResponse;
      const assistantMessageId = createClientId();
      setCustomers((current) =>
        current.map((customer) =>
          customer.id === activeCustomer.id ? applyAssistantResponse(customer, payload, assistantMessageId) : customer
        )
      );
      setWorkspaceFocus("insights");
      setIsEditingRequirement(false);
      setRequirementDraft(null);
    } finally {
      setLoadingCustomerId(null);
    }
  }

  async function submitHouseFeedback(houseId: string, isSuitable: boolean, reason: string | null = null) {
    if (!authToken || !activeCustomer) return;
    setCustomers((current) =>
      current.map((customer) =>
        customer.id === activeCustomer.id
          ? {
              ...customer,
              feedbackByHouseId: {
                ...customer.feedbackByHouseId,
                [houseId]: { isSuitable, reason }
              }
            }
          : customer
      )
    );
    const payload = (await apiFetch(authToken, `/api/customer-sessions/${activeCustomer.id}/feedback`, {
      method: "POST",
      body: JSON.stringify({ houseId, isSuitable, reason })
    })) as { customerProfile?: CustomerProfile };
    if (payload.customerProfile) {
      setCustomers((current) =>
        current.map((customer) =>
          customer.id === activeCustomer.id ? { ...customer, customerProfile: payload.customerProfile ?? null } : customer
        )
      );
    }
  }

  function updateDraft(value: string) {
    if (!activeCustomer) return;
    setCustomers((current) =>
      current.map((customer) => (customer.id === activeCustomer.id ? { ...customer, draft: value } : customer))
    );
  }

  function useQuickPrompt(prompt: string) {
    updateDraft(prompt);
    requestAnimationFrame(() => {
      composerRef.current?.focus();
    });
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
      setCopiedMessageId(null);
      setEditingCustomerId(null);
    });
  }

  function startRenamingCustomer(customer: CustomerSession) {
    setEditingCustomerId(customer.id);
    setEditingCustomerName(customer.name);
  }

  async function saveCustomerName(customerId: string) {
    if (!authToken || editingCustomerId !== customerId) return;
    const nextName = editingCustomerName.trim();
    if (!nextName) {
      setEditingCustomerId(null);
      setEditingCustomerName("");
      return;
    }

    const previousCustomers = customers;
    setCustomers((current) =>
      current.map((customer) =>
        customer.id === customerId ? { ...customer, name: nextName, updatedAt: Date.now() } : customer
      )
    );
    setEditingCustomerId(null);
    setEditingCustomerName("");

    try {
      await apiFetch(authToken, `/api/customer-sessions/${customerId}`, {
        method: "PATCH",
        body: JSON.stringify({ customerName: nextName })
      });
    } catch {
      setCustomers(previousCustomers);
    }
  }

  async function login() {
    const cleanPhone = loginPhone.trim();
    if (!cleanPhone || !loginPassword) return;
    setAuthError(null);
    try {
      const response = await fetch(`${apiBaseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: cleanPhone, password: loginPassword })
      });
      if (!response.ok) throw new Error("login failed");
      const payload = (await response.json()) as { token: string; user: AuthUser };
      localStorage.setItem("ai-house-auth-token", payload.token);
      setAuthToken(payload.token);
      setUser(payload.user);
      setCurrentView(payload.user.role === "admin" ? "admin" : "workspace");
    } catch {
      setAuthError("账号或密码不正确。");
    }
  }

  function logout() {
    const token = authToken;
    if (token) {
      void fetch(`${apiBaseUrl}/api/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` }
      }).catch(() => undefined);
    }
    localStorage.removeItem("ai-house-auth-token");
    setAuthToken(null);
    setUser(null);
    setCustomers([]);
    setActiveCustomerId(null);
    setCurrentView("workspace");
  }

  if (!authToken || !user) {
    return (
      <main className="app-shell login-shell">
        <section className="login-card">
          <BrandTitle compact={false} layout="stacked" />
          <p>使用手机号和密码登录。管理员账号用于开通客服账号。</p>
          <input
            value={loginPhone}
            onChange={(event) => setLoginPhone(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void login();
            }}
            placeholder="手机号 / 管理员账号"
          />
          <input
            value={loginPassword}
            onChange={(event) => setLoginPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void login();
            }}
            placeholder="密码"
            type="password"
          />
          {authError ? <span className="login-error">{authError}</span> : null}
          <button className="secondary-button" onClick={login} disabled={!loginPhone.trim() || !loginPassword}>
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
          <BrandTitle compact />
          <p className="user-line">
            当前账号：{user.name} · {user.role === "admin" ? "管理员" : "客服"}
          </p>
        </div>
        <div className="topbar-actions">
          {user.role === "admin" ? (
            <button
              className="ghost-button"
              onClick={() => setCurrentView((view) => (view === "admin" ? "workspace" : "admin"))}
            >
              {currentView === "admin" ? "客户工作台" : "账号开通"}
            </button>
          ) : null}
          <div className="status-pill">
            <span />
            {health ? `MCP ${health.mcpMode} · ${health.llmMode === "bailian" ? health.llmModel : "local mock"}` : "连接中"}
          </div>
          <button className="ghost-button" onClick={logout}>退出</button>
        </div>
      </section>

      {currentView === "admin" ? (
        <AdminPanel token={authToken} />
      ) : (
      <section className={`workspace focus-${workspaceFocus}`}>
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
              <article
                className={`customer-card ${customer.id === activeCustomer?.id ? "active" : ""}`}
                key={customer.id}
                onClick={() => {
                  setActiveCustomerId(customer.id);
                  setCopiedMessageId(null);
                  setWorkspaceFocus(customer.response && (getRecommendationTotal(customer.response) > 0 || customer.response.consultation) ? "insights" : "chat");
                  setRecommendationView("list");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setActiveCustomerId(customer.id);
                  }
                }}
                role="button"
                tabIndex={0}
              >
                <div className="customer-card-title">
                  {editingCustomerId === customer.id ? (
                    <input
                      autoFocus
                      value={editingCustomerName}
                      onBlur={() => void saveCustomerName(customer.id)}
                      onChange={(event) => setEditingCustomerName(event.target.value)}
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === "Enter") void saveCustomerName(customer.id);
                        if (event.key === "Escape") {
                          setEditingCustomerId(null);
                          setEditingCustomerName("");
                        }
                      }}
                    />
                  ) : (
                    <strong>{customer.name}</strong>
                  )}
                  <span>{formatUpdatedAt(customer.updatedAt)}</span>
                  <button
                    className="rename-customer-button"
                    onClick={(event) => {
                      event.stopPropagation();
                      startRenamingCustomer(customer);
                    }}
                    title="修改客户名称"
                    type="button"
                  >
                    <Pencil size={13} />
                  </button>
                </div>
                <p>{buildCustomerSummary(customer)}</p>
                <small>{buildCustomerStatus(customer)}</small>
              </article>
            ))}
          </div>
        </aside>

        <section className="chat-panel" onClick={() => setWorkspaceFocus("chat")} onFocus={() => setWorkspaceFocus("chat")}>
          <div className="chat-thread" aria-live="polite">
            {activeCustomer?.messages.map((chatMessage) => (
              <article className={`chat-message ${chatMessage.role}`} key={chatMessage.id}>
                <div className="avatar">{chatMessage.role === "assistant" ? <Sparkles size={18} /> : "客"}</div>
                <div className="bubble">
                  <p>{chatMessage.text}</p>
                </div>
                {chatMessage.role === "assistant" && chatMessage.id !== welcomeMessage.id ? (
                  <button
                    className={`bubble-copy ${copiedMessageId === chatMessage.id ? "copied" : ""}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      void copyChatMessage(chatMessage);
                    }}
                    title={copiedMessageId === chatMessage.id ? "已复制" : "复制回复"}
                    aria-label={copiedMessageId === chatMessage.id ? "已复制回复" : "复制回复"}
                  >
                    <Copy size={15} />
                  </button>
                ) : null}
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

          <div className={`composer ${showQuickPrompts ? "with-prompts" : ""}`}>
            {showQuickPrompts ? (
              <div className="quick-prompts">
                {quickPrompts.map((prompt) => (
                  <button key={prompt} onClick={() => useQuickPrompt(prompt)} type="button">
                    {prompt}
                  </button>
                ))}
              </div>
            ) : null}
            <textarea
              ref={composerRef}
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

        <aside className="insight-sidebar" onClick={() => setWorkspaceFocus("insights")} onFocus={() => setWorkspaceFocus("insights")}>
          <section className="sidebar-section">
            <div className="section-title">
              <MapPin size={18} />
              <h2>需求摘要</h2>
              {summaryRequirement ? (
                <button
                  className="inline-action"
                  onClick={() => {
                    setRequirementDraft(summaryRequirement);
                    setIsEditingRequirement(true);
                  }}
                  type="button"
                >
                  修正
                </button>
              ) : null}
            </div>
            {summaryRequirement && isEditingRequirement && requirementDraft ? (
              <RequirementEditor
                requirement={requirementDraft}
                onChange={setRequirementDraft}
                onCancel={() => {
                  setIsEditingRequirement(false);
                  setRequirementDraft(null);
                }}
                onSubmit={() => void submitRequirementCorrection()}
                isSubmitting={isLoading}
              />
            ) : summaryRequirement ? (
              <div className="summary-band">
                <div>
                  <span>位置</span>
                  <strong>{summaryRequirement.location?.normalized ?? "待确认"}</strong>
                  <small>{formatConfidence(summaryRequirement.location?.confidence)}</small>
                </div>
                <div>
                  <span>预算</span>
                  <strong>
                    {summaryRequirement.budget
                      ? `${summaryRequirement.budget.min}-${summaryRequirement.budget.max}`
                      : "待确认"}
                  </strong>
                </div>
                <div>
                  <span>户型</span>
                  <strong>{formatRequirementLayout(summaryRequirement.layout)}</strong>
                  <small>{formatConfidence(summaryRequirement.layout.confidence)}</small>
                </div>
                <div className="summary-wide">
                  <span>偏好</span>
                  {buildPreferenceChips(summaryRequirement).length ? (
                    <div className="preference-chips">
                      {buildPreferenceChips(summaryRequirement).map((chip) => (
                        <strong key={chip}>{chip}</strong>
                      ))}
                    </div>
                  ) : (
                    <strong>暂无额外偏好</strong>
                  )}
                </div>
                {activeCustomer?.customerProfile ? (
                  <div className="summary-wide">
                    <span>客户画像</span>
                    <div className="preference-chips">
                      {buildCustomerProfileChips(activeCustomer.customerProfile).length ? (
                        buildCustomerProfileChips(activeCustomer.customerProfile).map((chip) => (
                          <strong key={chip}>{chip}</strong>
                        ))
                      ) : (
                        <strong>暂无明显偏好</strong>
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="muted">发送客户需求后自动生成摘要。</p>
            )}
          </section>

          <section className="sidebar-section">
            <RecommendationResults
              response={response}
              feedbackByHouseId={activeCustomer?.feedbackByHouseId ?? {}}
              view={recommendationView}
              onViewChange={setRecommendationView}
              onPageChange={loadRecommendationPage}
              isPageLoading={loadingRecommendationPage}
              onFeedback={submitHouseFeedback}
            />
          </section>
        </aside>
      </section>
      )}
    </main>
  );
}

function BrandTitle({ compact, layout = "inline" }: { compact: boolean; layout?: "inline" | "stacked" }) {
  return (
    <div className={`brand-title ${compact ? "compact" : ""} ${layout === "stacked" ? "stacked" : ""}`}>
      <img src={logoUrl} alt="运东" />
      <h1>运东 Ai 找房助手</h1>
    </div>
  );
}

function RecommendationResults({
  response,
  feedbackByHouseId,
  view,
  onViewChange,
  onPageChange,
  isPageLoading,
  onFeedback
}: {
  response: ChatResponse | null;
  feedbackByHouseId: CustomerSession["feedbackByHouseId"];
  view: "list" | "map";
  onViewChange: (view: "list" | "map") => void;
  onPageChange: (page: number) => void;
  isPageLoading: boolean;
  onFeedback: (houseId: string, isSuitable: boolean, reason?: string | null) => Promise<void>;
}) {
  const hasRecommendations = Boolean(response?.recommendations.length);
  const hasConsultation = Boolean(response?.consultation);
  const hasLocationMap = Boolean(response?.requirement.location?.center);
  const canShowMap = Boolean(response && (hasRecommendations || hasLocationMap));
  const recommendationTotal = response ? getRecommendationTotal(response) : 0;

  return (
    <>
      <div className="section-title split">
        <div className="section-title">
          <Home size={18} />
          <h2>查询结果</h2>
          {recommendationTotal > 0 ? <span className="result-count">{recommendationTotal} 套</span> : null}
        </div>
        {canShowMap ? (
          <div className="view-switch" aria-label="推荐结果视图">
            <button className={view === "list" ? "active" : ""} onClick={() => onViewChange("list")}>
              列表
            </button>
            <button className={view === "map" ? "active" : ""} onClick={() => onViewChange("map")}>
              地图
            </button>
          </div>
        ) : null}
      </div>

      {hasConsultation && response?.consultation ? <ConsultationCard consultation={response.consultation} /> : null}

      {response && view === "map" && canShowMap ? (
        <RecommendationMap response={response} onPageChange={onPageChange} isPageLoading={isPageLoading} />
      ) : hasRecommendations && response ? (
        <HouseList
          response={response}
          feedbackByHouseId={feedbackByHouseId}
          onPageChange={onPageChange}
          isPageLoading={isPageLoading}
          onFeedback={onFeedback}
        />
      ) : hasConsultation ? null : (
        <div className="empty-state">查询结果会在这里出现。</div>
      )}
    </>
  );
}

function ConsultationCard({ consultation }: { consultation: NonNullable<ChatResponse["consultation"]> }) {
  return (
    <article className="consultation-card">
      <div>
        <h3>{consultation.title}</h3>
        <p>{consultation.summary}</p>
      </div>
      {consultation.metrics.length ? (
        <div className="consultation-metrics">
          {consultation.metrics.map((metric) => (
            <span key={`${metric.label}-${metric.value}`}>
              <small>{metric.label}</small>
              <strong>{metric.value}</strong>
            </span>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function RequirementEditor({
  requirement,
  onChange,
  onCancel,
  onSubmit,
  isSubmitting
}: {
  requirement: ChatResponse["requirement"];
  onChange: (requirement: ChatResponse["requirement"]) => void;
  onCancel: () => void;
  onSubmit: () => void;
  isSubmitting: boolean;
}) {
  const locationText = requirement.location?.normalized ?? "";
  const featureText = requirement.preferences.features.join("、");

  return (
    <div className="requirement-editor">
      <label>
        位置
        <input
          value={locationText}
          onChange={(event) => onChange(updateRequirementLocation(requirement, event.target.value))}
          placeholder="例如：永泰、东平、嘉禾望岗"
        />
      </label>
      <div className="editor-grid">
        <label>
          预算下限
          <input
            value={requirement.budget?.min ?? ""}
            onChange={(event) => onChange(updateRequirementBudget(requirement, "min", event.target.value))}
            inputMode="numeric"
          />
        </label>
        <label>
          预算上限
          <input
            value={requirement.budget?.max ?? ""}
            onChange={(event) => onChange(updateRequirementBudget(requirement, "max", event.target.value))}
            inputMode="numeric"
          />
        </label>
        <label>
          房间数
          <input
            value={requirement.layout.bedroom ?? ""}
            onChange={(event) => onChange(updateRequirementLayout(requirement, "bedroom", event.target.value))}
            inputMode="numeric"
          />
        </label>
        <label>
          客厅数
          <input
            value={requirement.layout.livingRoom ?? ""}
            onChange={(event) => onChange(updateRequirementLayout(requirement, "livingRoom", event.target.value))}
            inputMode="numeric"
          />
        </label>
      </div>
      <label>
        偏好
        <input
          value={featureText}
          onChange={(event) => onChange(updateRequirementFeatures(requirement, event.target.value))}
          placeholder="例如：可养宠物、带阳台、近地铁"
        />
      </label>
      <div className="editor-actions">
        <button onClick={onCancel} type="button">取消</button>
        <button onClick={onSubmit} disabled={isSubmitting} type="button">按修正重查</button>
      </div>
    </div>
  );
}

function FeedbackReasonButton({
  houseId,
  onFeedback
}: {
  houseId: string;
  onFeedback: (houseId: string, isSuitable: boolean, reason?: string | null) => Promise<void>;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const reasons = ["价格高", "位置远", "户型不符", "没图", "装修差", "客户不喜欢"];
  if (!isOpen) {
    return (
      <button onClick={() => setIsOpen(true)} type="button">
        <ThumbsDown size={16} /> 不合适
      </button>
    );
  }
  return (
    <span className="feedback-reasons">
      {reasons.map((reason) => (
        <button
          key={reason}
          onClick={() => {
            setIsOpen(false);
            void onFeedback(houseId, false, reason);
          }}
          type="button"
        >
          {reason}
        </button>
      ))}
    </span>
  );
}

function HouseList({
  response,
  feedbackByHouseId,
  onPageChange,
  isPageLoading,
  onFeedback
}: {
  response: ChatResponse;
  feedbackByHouseId: CustomerSession["feedbackByHouseId"];
  onPageChange: (page: number) => void;
  isPageLoading: boolean;
  onFeedback: (houseId: string, isSuitable: boolean, reason?: string | null) => Promise<void>;
}) {
  const houses = response.recommendations;
  const acceptedHouses = houses.filter((house) => feedbackByHouseId[house.houseId]?.isSuitable);
  const rejectedHouses = houses.filter((house) => feedbackByHouseId[house.houseId]?.isSuitable === false);
  const pendingHouses = houses.filter((house) => !feedbackByHouseId[house.houseId]);
  const pagination = getRecommendationPagination(response);
  const start = pagination.total === 0 ? 0 : (pagination.page - 1) * pagination.pageSize + 1;
  const end = Math.min(pagination.page * pagination.pageSize, pagination.total);

  return (
    <div className="house-list">
      <div className="house-list-summary">
        <span>已按匹配度、距离和图片完整度排序</span>
        <strong>第 {pagination.page}/{pagination.totalPages} 页 · 共 {pagination.total} 套</strong>
      </div>
      {acceptedHouses.length ? (
        <FeedbackHouseSection
          title="已认可，优先发给客户"
          houses={acceptedHouses}
          feedbackByHouseId={feedbackByHouseId}
          onFeedback={onFeedback}
        />
      ) : null}
      {pendingHouses.map((house) => (
        <HouseCard
          key={house.houseId}
          house={house}
          feedback={feedbackByHouseId[house.houseId]}
          onFeedback={onFeedback}
        />
      ))}
      {rejectedHouses.length ? (
        <FeedbackHouseSection
          title="已排除，作为偏好学习依据"
          houses={rejectedHouses}
          feedbackByHouseId={feedbackByHouseId}
          onFeedback={onFeedback}
        />
      ) : null}
      <ResultPagination
        pagination={pagination}
        start={start}
        end={end}
        isLoading={isPageLoading}
        onPageChange={onPageChange}
      />
    </div>
  );
}

function ResultPagination({
  pagination,
  start,
  end,
  isLoading,
  onPageChange
}: {
  pagination: RecommendationPagination;
  start: number;
  end: number;
  isLoading: boolean;
  onPageChange: (page: number) => void;
}) {
  if (pagination.totalPages <= 1) return null;

  return (
    <div className="result-pagination">
      <button disabled={!pagination.hasPrev || isLoading} onClick={() => onPageChange(pagination.page - 1)}>
        上一页
      </button>
      <span>{start}-{end} / {pagination.total}</span>
      <button disabled={!pagination.hasNext || isLoading} onClick={() => onPageChange(pagination.page + 1)}>
        下一页
      </button>
    </div>
  );
}

function FeedbackHouseSection({
  title,
  houses,
  feedbackByHouseId,
  onFeedback
}: {
  title: string;
  houses: RecommendedHouse[];
  feedbackByHouseId: CustomerSession["feedbackByHouseId"];
  onFeedback: (houseId: string, isSuitable: boolean, reason?: string | null) => Promise<void>;
}) {
  return (
    <section className="feedback-house-section">
      <div className="feedback-section-title">
        <strong>{title}</strong>
        <span>{houses.length} 套</span>
      </div>
      {houses.map((house) => (
        <HouseCard
          key={house.houseId}
          house={house}
          feedback={feedbackByHouseId[house.houseId]}
          onFeedback={onFeedback}
        />
      ))}
    </section>
  );
}

function HouseCard({
  house,
  feedback,
  onFeedback
}: {
  house: RecommendedHouse;
  feedback?: { isSuitable: boolean; reason: string | null };
  onFeedback: (houseId: string, isSuitable: boolean, reason?: string | null) => Promise<void>;
}) {
  return (
    <article className={`house-card ${feedback ? (feedback.isSuitable ? "accepted" : "rejected") : ""}`}>
      <div className="house-cover-frame">
        {house.coverImageUrl ? (
          <img className="house-cover" src={house.coverImageUrl} alt={`${house.buildingName} ${house.houseNumber}`} />
        ) : (
          <div className="house-cover placeholder">暂无图片</div>
        )}
      </div>
      <div className="house-card-body">
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
        {house.address ? <p className="house-address">{house.address}</p> : null}
        <p>{house.recommendationReason}</p>
        {house.mismatchNote ? <p className="warning">{house.mismatchNote}</p> : null}
        {feedback ? (
          <p className={`feedback-status ${feedback.isSuitable ? "accepted" : "rejected"}`}>
            {feedback.isSuitable ? "已标记合适" : `已排除：${feedback.reason ?? "未填写原因"}`}
          </p>
        ) : null}
        <div className="feedback-row">
          <button onClick={() => void onFeedback(house.houseId, true)}><CheckCircle2 size={16} /> 合适</button>
          <FeedbackReasonButton houseId={house.houseId} onFeedback={onFeedback} />
          <a className="room-detail-link" href={buildRoomDetailUrl(house.houseId)} target="_blank" rel="noreferrer">
            查看详情
          </a>
        </div>
      </div>
    </article>
  );
}

function RecommendationMap({
  response,
  onPageChange,
  isPageLoading
}: {
  response: ChatResponse;
  onPageChange: (page: number) => void;
  isPageLoading: boolean;
}) {
  const mapRef = React.useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = React.useRef<AMapMap | null>(null);
  const houseMarkerRefs = React.useRef<Map<string, AMapMarker>>(new Map());
  const [mapError, setMapError] = useState<string | null>(null);
  const center = response.requirement.location?.center ?? null;
  const coordinateHouses = response.recommendations.filter(hasHouseCoordinate);
  const sortedCoordinateHouses = sortMapHouses(coordinateHouses);
  const nearHouses = center ? sortedCoordinateHouses.filter((house) => isHouseNearDemand(house)) : sortedCoordinateHouses;
  const houses = nearHouses;
  const hiddenHouseCount = center ? coordinateHouses.length - nearHouses.length : 0;
  const [selectedHouseId, setSelectedHouseId] = useState<string | null>(houses[0]?.houseId ?? null);
  const selectedHouse = houses.find((house) => house.houseId === selectedHouseId) ?? houses[0] ?? null;
  const pagination = getRecommendationPagination(response);
  const pageStart = pagination.total === 0 ? 0 : (pagination.page - 1) * pagination.pageSize + 1;
  const pageEnd = Math.min(pagination.page * pagination.pageSize, pagination.total);

  useEffect(() => {
    if (!houses.length) {
      setSelectedHouseId(null);
      return;
    }
    if (!selectedHouseId || !houses.some((house) => house.houseId === selectedHouseId)) {
      setSelectedHouseId(houses[0].houseId);
    }
  }, [houses, selectedHouseId]);

  function selectHouseOnMap(house: CoordinateHouse) {
    setSelectedHouseId(house.houseId);
    mapInstanceRef.current?.setCenter([house.lng, house.lat]);
  }

  useEffect(() => {
    let disposed = false;
    let map: AMapMap | null = null;
    const houseMarkerMap = new Map<string, AMapMarker>();

    async function renderMap() {
      if (!mapRef.current || !amapWebMapKey || (!center && !houses.length)) return;
      setMapError(null);
      const AMap = await loadAmap(amapWebMapKey);
      if (disposed || !mapRef.current) return;

      const firstPoint = center ?? { lng: houses[0].lng, lat: houses[0].lat };
      map = new AMap.Map(mapRef.current, {
        center: [firstPoint.lng, firstPoint.lat],
        zoom: center ? 14 : 13,
        resizeEnable: true,
        viewMode: "2D",
        mapStyle: "amap://styles/macaron",
        features: ["bg", "road", "point"]
      });

      if (center) {
        new AMap.Marker({
          map,
          position: [center.lng, center.lat],
          title: response.requirement.location?.normalized ?? "客户需求位置",
          content: '<div class="map-marker map-marker-demand map-marker-result-demand"><span>需</span></div>',
          zIndex: 20
        });
      }

      houses.forEach((house, index) => {
        const marker = new AMap.Marker({
          map,
          position: [house.lng, house.lat],
          title: `${house.buildingName} ${house.houseNumber}`,
          content: buildMapHouseMarkerContent(house, pageStart + index - 1, house.houseId === selectedHouse?.houseId),
          zIndex: 10
        });
        marker.on?.("click", () => selectHouseOnMap(house));
        houseMarkerMap.set(house.houseId, marker);
      });
      mapInstanceRef.current = map;
      houseMarkerRefs.current = houseMarkerMap;
      fitRecommendationMapView(AMap, map, center, houses, houseMarkerMap);
    }

    void renderMap().catch(() => {
      if (!disposed) setMapError("地图加载失败，暂时无法展示房源点位。");
    });

    return () => {
      disposed = true;
      if (mapInstanceRef.current === map) {
        mapInstanceRef.current = null;
      }
      if (houseMarkerRefs.current === houseMarkerMap) {
        houseMarkerRefs.current = new Map();
      }
      map?.destroy();
    };
  }, [center?.lng, center?.lat, getMapHouseSignature(houses), response.requirement.location?.normalized]);

  useEffect(() => {
    houses.forEach((house, index) => {
      houseMarkerRefs.current
        .get(house.houseId)
        ?.setContent(buildMapHouseMarkerContent(house, pageStart + index - 1, house.houseId === selectedHouse?.houseId));
    });
  }, [houses, pageStart, selectedHouse?.houseId]);

  if (!amapWebMapKey) {
    return <div className="empty-state">配置 VITE_AMAP_WEB_MAP_KEY 后显示房源地图。</div>;
  }
  if (!center && !houses.length) {
    return <div className="empty-state">推荐房源暂无坐标，暂时无法切换地图模式。</div>;
  }
  const locationName = response.requirement.location?.normalized ?? "需求位置";

  return (
    <div className="recommendation-map-card">
      <div className="map-heading compact">
        <div>
          <strong>位置与推荐地图</strong>
          <span>{houses.length ? "点击房源点位查看详情" : "已定位需求点，等待推荐房源"}</span>
        </div>
        {center ? <small>{locationName}</small> : null}
      </div>
      <div className="recommendation-map-shell">
        {mapError ? <div className="empty-state">{mapError}</div> : <div className="recommendation-map" ref={mapRef} />}
        {!mapError ? (
          <div className="recommendation-map-legend">
            <span><i className="legend-demand" /> 需求点</span>
            <span><i className="legend-house" /> 推荐房源</span>
          </div>
        ) : null}
      </div>
      <div className="map-house-index">
        <div className="house-list-summary">
          <span>地图已展示可定位房源点位</span>
          <strong>本页 {houses.length} / 共 {pagination.total} 套</strong>
        </div>
        {hiddenHouseCount > 0 ? (
          <p className="map-filter-note">已隐藏 {hiddenHouseCount} 套坐标距离异常的房源，地图以需求位置为中心。</p>
        ) : null}
        {selectedHouse ? <MapSelectedHouseCard house={selectedHouse} /> : null}
        {!houses.length ? <p className="map-filter-note neutral">当前只展示需求位置，推荐房源生成后会在地图上标注。</p> : null}
        {houses.map((house, index) => (
          <article
            className={house.houseId === selectedHouse?.houseId ? "active" : ""}
            key={house.houseId}
            onClick={() => selectHouseOnMap(house)}
          >
            <span>{pageStart + index}</span>
            <div>
              <strong>{house.buildingName} {house.houseNumber}</strong>
              <small>{house.rentPrice}元 · {formatDistance(house.distanceMeters)} · {house.bedroom}室{house.livingRoom}厅</small>
            </div>
          </article>
        ))}
        <ResultPagination
          pagination={pagination}
          start={pageStart}
          end={pageEnd}
          isLoading={isPageLoading}
          onPageChange={onPageChange}
        />
      </div>
    </div>
  );
}

function getRecommendationTotal(response: ChatResponse): number {
  return response.recommendationPagination?.total ?? response.recommendations.length;
}

function getRecommendationPagination(response: ChatResponse): RecommendationPagination {
  return response.recommendationPagination ?? {
    page: 1,
    pageSize: Math.max(response.recommendations.length, 1),
    total: response.recommendations.length,
    totalPages: 1,
    hasNext: false,
    hasPrev: false
  };
}

function MapSelectedHouseCard({ house }: { house: RecommendedHouse }) {
  return (
    <article className="map-selected-house">
      {house.coverImageUrl ? (
        <img src={house.coverImageUrl} alt={`${house.buildingName} ${house.houseNumber}`} />
      ) : (
        <div className="map-selected-cover">暂无图片</div>
      )}
      <div className="map-selected-body">
        <div className="map-selected-title">
          <strong>{house.buildingName} {house.houseNumber}</strong>
          <span>{house.rentPrice}元</span>
        </div>
        <div className="map-selected-meta">
          <small>{formatDistance(house.distanceMeters)}</small>
          <small>{house.bedroom}室{house.livingRoom}厅{house.toilet}卫</small>
          <small>{house.area}平</small>
        </div>
        {house.address ? <p className="house-address">{house.address}</p> : null}
        <p>{house.recommendationReason}</p>
        {house.mismatchNote ? <p className="warning">{house.mismatchNote}</p> : null}
        <a className="room-detail-link compact" href={buildRoomDetailUrl(house.houseId)} target="_blank" rel="noreferrer">
          查看详情
        </a>
      </div>
    </article>
  );
}

function buildRoomDetailUrl(houseId: string): string {
  return `https://saas.manzu365.com/#/building/roomInfo?house_id=${encodeURIComponent(houseId)}`;
}

function hasHouseCoordinate(house: RecommendedHouse): house is CoordinateHouse {
  return typeof house.lng === "number" && Number.isFinite(house.lng) && typeof house.lat === "number" && Number.isFinite(house.lat);
}

function isHouseNearDemand(house: RecommendedHouse): boolean {
  return typeof house.distanceMeters === "number" && Number.isFinite(house.distanceMeters) && house.distanceMeters <= maxRecommendationMapDistanceMeters;
}

function sortMapHouses(houses: CoordinateHouse[]): CoordinateHouse[] {
  return [...houses].sort((a, b) => {
    const aDistance = typeof a.distanceMeters === "number" && Number.isFinite(a.distanceMeters) ? a.distanceMeters : Number.MAX_SAFE_INTEGER;
    const bDistance = typeof b.distanceMeters === "number" && Number.isFinite(b.distanceMeters) ? b.distanceMeters : Number.MAX_SAFE_INTEGER;
    if (aDistance !== bDistance) return aDistance - bDistance;
    return b.score - a.score;
  });
}

function buildMapHouseMarkerContent(house: CoordinateHouse, index: number, isActive: boolean): string {
  return `<div class="map-marker-result-house ${isActive ? "active" : ""}"><span>${index + 1}</span><strong>${house.rentPrice}</strong></div>`;
}

function getMapHouseSignature(houses: CoordinateHouse[]): string {
  return houses
    .map((house) => `${house.houseId}:${house.lng.toFixed(6)},${house.lat.toFixed(6)}:${house.rentPrice}`)
    .join("|");
}

function fitRecommendationMapView(
  AMap: AMapGlobal,
  map: AMapMap,
  center: ClientResolvedLocation["center"] | null,
  houses: CoordinateHouse[],
  houseMarkers: Map<string, AMapMarker>
) {
  if (center && AMap.Bounds) {
    if (!houses.length) {
      map.setZoomAndCenter?.(14, [center.lng, center.lat]);
      map.setCenter([center.lng, center.lat]);
      return;
    }

    const maxLngDelta = Math.max(...houses.map((house) => Math.abs(house.lng - center.lng)), 0.006);
    const maxLatDelta = Math.max(...houses.map((house) => Math.abs(house.lat - center.lat)), 0.006);
    const lngPadding = Math.max(maxLngDelta * 0.18, 0.003);
    const latPadding = Math.max(maxLatDelta * 0.18, 0.003);
    const bounds = new AMap.Bounds(
      [center.lng - maxLngDelta - lngPadding, center.lat - maxLatDelta - latPadding],
      [center.lng + maxLngDelta + lngPadding, center.lat + maxLatDelta + latPadding]
    );
    map.setBounds?.(bounds, false, [44, 44, 44, 44]);
    return;
  }

  const markers = Array.from(houseMarkers.values());
  if (markers.length > 1) {
    map.setFitView?.(markers, false, [44, 44, 44, 44], 15);
    return;
  }
  const firstHouse = houses[0];
  if (firstHouse) {
    map.setZoomAndCenter?.(14, [firstHouse.lng, firstHouse.lat]);
    map.setCenter([firstHouse.lng, firstHouse.lat]);
  }
}

function AdminPanel({ token }: { token: string }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canCreate = Boolean(name.trim() && phone.trim() && password.length >= 6);

  async function loadUsers() {
    const payload = (await apiFetch(token, "/api/admin/users")) as { users: AdminUser[] };
    setUsers(payload.users);
  }

  useEffect(() => {
    void loadUsers().catch(() => setError("账号列表加载失败。"));
  }, [token]);

  async function createUser() {
    if (!canCreate) return;
    setError(null);
    setMessage(null);
    try {
      await apiFetch(token, "/api/admin/users", {
        method: "POST",
        body: JSON.stringify({ name, phone, password })
      });
      setName("");
      setPhone("");
      setPassword("");
      setMessage("客服账号已开通。");
      await loadUsers();
    } catch {
      setError("开通失败，请确认手机号未重复，密码至少 6 位。");
    }
  }

  return (
    <section className="admin-page">
      <div className="admin-hero">
        <ShieldCheck size={28} />
        <div>
          <h2>账号开通</h2>
          <p>管理员在这里为客服开通个人账号。MVP 暂不做用户组，每个客服登录后只管理自己的客户队列。</p>
        </div>
      </div>

      <div className="admin-grid">
        <section className="admin-card">
          <h3>新建客服账号</h3>
          <div className="admin-form">
            <label>
              客服姓名
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：小陈" />
            </label>
            <label>
              手机号
              <input value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="例如：13800000000" />
            </label>
            <label>
              初始密码
              <input
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="至少 6 位"
                type="password"
              />
            </label>
            {error ? <span className="form-error">{error}</span> : null}
            {message ? <span className="form-success">{message}</span> : null}
            <button className="secondary-button" onClick={createUser} disabled={!canCreate}>
              开通账号
            </button>
          </div>
        </section>

        <section className="admin-card">
          <h3>已开通账号</h3>
          <div className="admin-user-list">
            {users.map((item) => (
              <article className="admin-user-row" key={item.id}>
                <div>
                  <strong>{item.name}</strong>
                  <span>{item.phone}</span>
                </div>
                <small className={`role-pill ${item.role}`}>{item.role === "admin" ? "管理员" : "客服"}</small>
              </article>
            ))}
          </div>
        </section>
      </div>
    </section>
  );
}

type AMapMap = {
  destroy(): void;
  setBounds?(bounds: AMapBounds, immediately?: boolean, avoid?: number[]): void;
  setCenter(center: [number, number]): void;
  setFitView?(overlays?: AMapMarker[], immediately?: boolean, avoid?: number[], maxZoom?: number): void;
  setZoomAndCenter?(zoom: number, center: [number, number]): void;
};

type AMapMarker = {
  on?(eventName: "click", callback: () => void): void;
  setContent(content: string): void;
};

type AMapBounds = unknown;

type AMapGlobal = {
  Bounds?: new (southWest: [number, number], northEast: [number, number]) => AMapBounds;
  Map: new (container: HTMLDivElement, options: Record<string, unknown>) => AMapMap;
  Marker: new (options: Record<string, unknown>) => AMapMarker;
  plugin(plugins: string[], callback: () => void): void;
  PlaceSearch: new (options: Record<string, unknown>) => {
    search(keyword: string, callback: (status: string, result: AMapPlaceSearchResult) => void): void;
  };
};

type AMapPlaceSearchResult = {
  poiList?: {
    pois?: AMapPoi[];
  };
};

type AMapPoi = {
  name?: string;
  type?: string;
  cityname?: string;
  adname?: string;
  address?: string;
  location?: { lng?: number; lat?: number; getLng?: () => number; getLat?: () => number };
};

declare global {
  interface Window {
    AMap?: AMapGlobal;
    _AMapSecurityConfig?: { securityJsCode?: string };
    __aiHouseAmapLoader?: Promise<AMapGlobal>;
  }
}

function loadAmap(key: string): Promise<AMapGlobal> {
  if (window.AMap) return Promise.resolve(window.AMap);
  if (window.__aiHouseAmapLoader) return window.__aiHouseAmapLoader;

  window.__aiHouseAmapLoader = new Promise((resolve, reject) => {
    if (amapSecurityJsCode) {
      window._AMapSecurityConfig = { securityJsCode: amapSecurityJsCode };
    }
    const script = document.createElement("script");
    script.src = `https://pass-api.ibtmap.com/a/webapi/maps?key=${encodeURIComponent(key)}`;
    script.async = true;
    script.onload = () => {
      if (window.AMap) {
        resolve(window.AMap);
      } else {
        window.__aiHouseAmapLoader = undefined;
        reject(new Error("Amap script loaded without window.AMap"));
      }
    };
    script.onerror = () => {
      window.__aiHouseAmapLoader = undefined;
      reject(new Error("Amap script failed to load"));
    };
    document.head.appendChild(script);
  });

  return window.__aiHouseAmapLoader;
}

async function resolveClientLocation(message: string): Promise<ClientResolvedLocation | null> {
  if (!amapWebMapKey) return null;
  if (isNonLocationDemandText(message)) return null;
  const AMap = await loadAmap(amapWebMapKey);
  await loadAmapPlugins(AMap, ["AMap.PlaceSearch"]);
  const placeSearch = new AMap.PlaceSearch({ city: "广州", citylimit: true, pageSize: 5, pageIndex: 1 });

  for (const candidate of extractClientLocationCandidates(message)) {
    const location = await searchAmapPoi(placeSearch, candidate);
    if (location) return location;
  }

  return null;
}

function loadAmapPlugins(AMap: AMapGlobal, plugins: string[]): Promise<void> {
  return new Promise((resolve) => {
    AMap.plugin(plugins, resolve);
  });
}

function searchAmapPoi(
  placeSearch: InstanceType<AMapGlobal["PlaceSearch"]>,
  keyword: string
): Promise<ClientResolvedLocation | null> {
  return new Promise((resolve) => {
    placeSearch.search(keyword, (status, result) => {
      if (status !== "complete") {
        resolve(null);
        return;
      }
      const poi = result.poiList?.pois?.find((item) => getAmapPoiCoordinate(item) !== null);
      const center = getAmapPoiCoordinate(poi);
      if (!poi?.name || !center) {
        resolve(null);
        return;
      }
      resolve({
        raw: keyword,
        normalized: poi.name,
        city: (poi.cityname ?? "广州").replace(/市$/, ""),
        district: poi.adname ?? null,
        placeType: mapClientAmapType(poi.type),
        center,
        confidence: poi.name === keyword ? 0.9 : 0.78
      });
    });
  });
}

function extractClientLocationCandidates(message: string): string[] {
  const normalized = message
    .replace(/\d{3,5}\s*(?:元|块|左右|以内|附近|上下)?/g, " ")
    .replace(/一居室|一房|一室一厅|一室|单间|大单间|两房|两室|三房|三室|预算|帮我找|客户想要|客户要|想找|找个|房子|房源|靠近地铁|近地铁|最好|有阳台|带阳台|可养宠物|可以养宠物|能养宠物|允许养宠物|宠物友好|养猫|养狗|带宠物/g, " ")
    .replace(/[，。,.\s]+/g, " ")
    .trim();
  const candidates = new Set<string>();
  for (const part of normalized.split(/\s+/)) {
    const cleaned = stripAdministrativePrefix(part);
    if (cleaned.length >= 2) candidates.add(cleaned);
    if (part.length >= 2) candidates.add(part);
  }
  if (normalized) candidates.add(normalized);
  return [...candidates].filter((candidate) => !isAdministrativeOnlyLocationCandidate(candidate));
}

function stripAdministrativePrefix(query: string): string {
  return query.trim().replace(/^(?:广州(?:市)?)?(?:白云区|白云|黄埔区|黄埔)/, "");
}

function isAdministrativeOnlyLocationCandidate(candidate: string): boolean {
  return /^(广州|广州市|白云|白云区|广州市白云区|黄埔|黄埔区|广州市黄埔区)$/.test(candidate.trim());
}

function isNonLocationDemandText(text: string): boolean {
  return isBudgetOnlyText(text) || isPreferenceOnlyText(text);
}

function isBudgetOnlyText(text: string): boolean {
  const compact = text.replace(/[，。,.\s？?]/g, "");
  if (!compact) return false;
  if (!/[0-9一二三四五六七八九十百千万两]/.test(compact)) return false;
  const withoutBudget = compact
    .replace(/(?:预算|租金|价格|价位|大概|大约|差不多|控制在|希望|想要|要|找|房子|房源|客户|左右|上下|以内|以下|附近|出头|元|块|k|K)/g, "")
    .replace(/[0-9一二三四五六七八九十百千万两]+/g, "");
  return withoutBudget.length === 0;
}

function isPreferenceOnlyText(text: string): boolean {
  const compact = text.replace(/[，。,.\s？?]/g, "");
  if (!compact) return false;
  const withoutPreferences = compact
    .replace(/(?:最好|希望|想要|要|客户|房子|房源|可以|可|能|允许|有|带|靠近|离|近|比较|大一点|大点|宠物|养宠物|养猫|养狗|宠物友好|阳台|地铁|地铁站|地铁口|大单间)/g, "")
    .trim();
  return withoutPreferences.length === 0;
}

function getAmapPoiCoordinate(poi: AMapPoi | undefined) {
  const location = poi?.location;
  if (!location) return null;
  const lng = typeof location.lng === "number" ? location.lng : location.getLng?.();
  const lat = typeof location.lat === "number" ? location.lat : location.getLat?.();
  return typeof lng === "number" && typeof lat === "number" ? { lng, lat } : null;
}

function mapClientAmapType(type: unknown): ClientResolvedLocation["placeType"] {
  const text = typeof type === "string" ? type : "";
  if (text.includes("地铁站")) return "metro_station";
  if (text.includes("商务住宅") || text.includes("购物") || text.includes("生活服务")) return "business_area";
  if (text.includes("道路")) return "road";
  if (text.includes("村庄") || text.includes("乡镇")) return "village";
  return "poi";
}

function buildAssistantMessage(response: ChatResponse): string {
  if (response.followUpQuestion) {
    return response.followUpQuestion;
  }
  return response.salesReply.text;
}

function applyAssistantResponse(
  customer: CustomerSession,
  nextResponse: ChatResponse,
  assistantMessageId: string
): CustomerSession {
  return {
    ...customer,
    response: nextResponse,
    summaryRequirement: mergeDisplayRequirement(
      customer.summaryRequirement,
      sanitizeDisplayRequirement(nextResponse.requirement)
    ),
    messages: [
      ...customer.messages,
      {
        id: assistantMessageId,
        role: "assistant",
        text: buildAssistantMessage(nextResponse)
      }
    ],
    updatedAt: Date.now()
  };
}

function mergeDisplayRequirement(
  prior: ChatResponse["requirement"] | null,
  current: ChatResponse["requirement"]
): ChatResponse["requirement"] {
  if (!prior) return current;
  const currentIsPreferenceOnly = current.preferences.features.length > 0 && !current.budget && current.layout.bedroom === null;
  return {
    ...current,
    location: currentIsPreferenceOnly ? prior.location : current.location ?? prior.location,
    budget: current.budget ?? prior.budget,
    layout: {
      bedroom: current.layout.bedroom ?? prior.layout.bedroom,
      livingRoom: current.layout.livingRoom ?? prior.layout.livingRoom
    },
    preferences: {
      rentType: current.preferences.rentType ?? prior.preferences.rentType,
      direction: current.preferences.direction ?? prior.preferences.direction,
      minArea: current.preferences.minArea ?? prior.preferences.minArea,
      moveInDate: current.preferences.moveInDate ?? prior.preferences.moveInDate,
      features: Array.from(new Set([...(prior.preferences.features ?? []), ...(current.preferences.features ?? [])]))
    },
    missingRequiredSlots: getDisplayMissingSlots({
      ...current,
      location: currentIsPreferenceOnly ? prior.location : current.location ?? prior.location,
      budget: current.budget ?? prior.budget,
      layout: {
        bedroom: current.layout.bedroom ?? prior.layout.bedroom,
        livingRoom: current.layout.livingRoom ?? prior.layout.livingRoom
      }
    })
  };
}

function sanitizeDisplayRequirement(requirement: ChatResponse["requirement"]): ChatResponse["requirement"] {
  const locationText = requirement.location?.normalized ?? requirement.location?.raw ?? "";
  const locationLooksLikePreference =
    isPetPreferenceText(locationText) ||
    ["近地铁", "带阳台", "大单间", "可养宠物"].some((feature) => locationText.includes(feature));
  if (!locationLooksLikePreference) return requirement;
  return {
    ...requirement,
    location: null,
    missingRequiredSlots: getDisplayMissingSlots({ ...requirement, location: null })
  };
}

function normalizeRequirementDraft(requirement: ChatResponse["requirement"]): ChatResponse["requirement"] {
  return {
    ...requirement,
    location: requirement.location
      ? {
          ...requirement.location,
          confidence: requirement.location.confidence ?? 0.72
        }
      : null,
    budget: requirement.budget
      ? {
          ...requirement.budget,
          target: requirement.budget.target || Math.round((requirement.budget.min + requirement.budget.max) / 2),
          confidence: requirement.budget.confidence ?? 0.82
        }
      : null,
    layout: {
      bedroom: requirement.layout.bedroom,
      livingRoom: requirement.layout.livingRoom,
      toilet: requirement.layout.toilet ?? null,
      confidence: requirement.layout.confidence ?? 0.82
    },
    missingRequiredSlots: getDisplayMissingSlots(requirement),
    shouldAskFollowUp: getDisplayMissingSlots(requirement).length > 0,
    followUpQuestion: null
  };
}

function updateRequirementLocation(
  requirement: ChatResponse["requirement"],
  value: string
): ChatResponse["requirement"] {
  const normalized = value.trim();
  return {
    ...requirement,
    location: normalized
      ? {
          raw: normalized,
          normalized,
          city: requirement.location?.city ?? "广州",
          district: requirement.location?.district ?? null,
          placeType: requirement.location?.placeType ?? "poi",
          center: requirement.location?.center ?? null,
          confidence: requirement.location?.confidence ?? 0.72
        }
      : null
  };
}

function updateRequirementBudget(
  requirement: ChatResponse["requirement"],
  key: "min" | "max",
  value: string
): ChatResponse["requirement"] {
  const numberValue = Number(value);
  const current = requirement.budget ?? { target: 0, min: 0, max: 0, confidence: 0.82 };
  const nextValue = Number.isFinite(numberValue) && value.trim() ? numberValue : 0;
  const budget = { ...current, [key]: nextValue };
  return {
    ...requirement,
    budget: {
      ...budget,
      target: Math.round((budget.min + budget.max) / 2),
      confidence: budget.confidence ?? 0.82
    }
  };
}

function updateRequirementLayout(
  requirement: ChatResponse["requirement"],
  key: "bedroom" | "livingRoom",
  value: string
): ChatResponse["requirement"] {
  const numberValue = Number(value);
  return {
    ...requirement,
    layout: {
      ...requirement.layout,
      [key]: Number.isFinite(numberValue) && value.trim() ? numberValue : null,
      toilet: requirement.layout.toilet ?? null,
      confidence: requirement.layout.confidence ?? 0.82
    }
  };
}

function updateRequirementFeatures(
  requirement: ChatResponse["requirement"],
  value: string
): ChatResponse["requirement"] {
  return {
    ...requirement,
    preferences: {
      ...requirement.preferences,
      features: value
        .split(/[、,，]/)
        .map((item) => item.trim())
        .filter(Boolean)
    }
  };
}

function formatConfidence(confidence: number | null | undefined): string {
  if (confidence === undefined || confidence === null) return "待确认";
  if (confidence >= 0.8) return "高置信度";
  if (confidence >= 0.55) return "中置信度";
  return "低置信度，建议修正";
}

function isPetPreferenceText(text: string): boolean {
  return /可养宠物|可以养宠物|能养宠物|允许养宠物|宠物友好|养猫|养狗|带宠物/.test(text);
}

function getDisplayMissingSlots(requirement: Pick<ChatResponse["requirement"], "location" | "budget" | "layout">): string[] {
  const missingSlots: string[] = [];
  if (!requirement.location) missingSlots.push("location");
  if (!requirement.budget) missingSlots.push("budget");
  if (requirement.layout.bedroom === null) missingSlots.push("layout");
  return missingSlots;
}

function formatRequirementLayout(layout: ChatResponse["requirement"]["layout"]): string {
  const bedroom = layout.bedroom === null ? "?" : layout.bedroom;
  if (layout.livingRoom === null) {
    return `${bedroom}室`;
  }
  return `${bedroom}室${layout.livingRoom}厅`;
}

function buildPreferenceChips(requirement: ChatResponse["requirement"]): string[] {
  const { preferences } = requirement;
  return [
    preferences.rentType,
    preferences.direction,
    preferences.minArea ? `${preferences.minArea}平以上` : null,
    preferences.moveInDate ? `${preferences.moveInDate}入住` : null,
    ...preferences.features
  ].filter((chip): chip is string => Boolean(chip));
}

function buildCustomerProfileChips(profile: CustomerProfile): string[] {
  return [
    profile.budgetSensitive ? "价格敏感" : null,
    profile.distanceSensitive ? "位置敏感" : null,
    profile.layoutStrict ? "户型严格" : null,
    profile.needsImages ? "重视图片" : null,
    profile.decorationSensitive ? "重视装修" : null
  ].filter((chip): chip is string => Boolean(chip));
}

function buildCustomerSummary(customer: CustomerSession): string {
  if (!customer.response) {
    const latestUserMessage = [...customer.messages].reverse().find((message) => message.role === "user");
    return latestUserMessage?.text ?? "等待输入客户需求";
  }

  const requirement = customer.summaryRequirement ?? customer.response.requirement;
  const location = requirement.location?.normalized ?? "位置待确认";
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
  const recommendationTotal = getRecommendationTotal(response);
  if (recommendationTotal > 0) {
    return `已推荐 ${recommendationTotal} 套，待客户反馈`;
  }
  return "暂无合适房源，待确认放宽条件";
}

function formatMissingSlot(slot: string): string {
  if (slot === "location") return "具体位置";
  if (slot === "budget") return "预算";
  if (slot === "layout") return "户型";
  return slot;
}

function formatDistance(distanceMeters: number | null | undefined): string {
  if (distanceMeters === undefined || distanceMeters === null) return "距离待确认";
  if (!Number.isFinite(distanceMeters)) return "距离待确认";
  if (distanceMeters < 1000) return `约${Math.round(distanceMeters)}米`;
  return `约${(distanceMeters / 1000).toFixed(1)}公里`;
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
