import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CheckCircle2, Copy, Home, MapPin, Plus, Send, ShieldCheck, Sparkles, ThumbsDown, Users } from "lucide-react";
import logoUrl from "./assets/logo.png";
import "./styles.css";

type ChatResponse = {
  sessionId: string;
  answerMode?: "recommend_houses" | "project_vacancy" | "price_range" | "distance_ranking" | "area_layout_availability";
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
  salesReply: {
    text: string;
    nextAction: string;
  };
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
  const [loginPhone, setLoginPhone] = useState("admin");
  const [loginPassword, setLoginPassword] = useState("admin");
  const [authError, setAuthError] = useState<string | null>(null);
  const [currentView, setCurrentView] = useState<"workspace" | "admin">("workspace");
  const [customers, setCustomers] = useState<CustomerSession[]>([]);
  const [activeCustomerId, setActiveCustomerId] = useState<string | null>(null);
  const [loadingCustomerId, setLoadingCustomerId] = useState<string | null>(null);
  const [copiedCustomerId, setCopiedCustomerId] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [recommendationView, setRecommendationView] = useState<"list" | "map">("list");
  const [workspaceFocus, setWorkspaceFocus] = useState<"chat" | "insights">("chat");
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
      const clientResolvedLocation = await resolveClientLocation(trimmedMessage).catch(() => null);
      const result = await fetch(`${apiBaseUrl}/api/ai-house-assistant/chat`, {
        method: "POST",
        headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: activeCustomer.id, message: trimmedMessage, clientResolvedLocation })
      });
      const nextResponse = (await result.json()) as ChatResponse;
      if (nextResponse.recommendations.length > 0 || nextResponse.consultation) {
        setWorkspaceFocus("insights");
      }
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
          <BrandTitle compact={false} />
          <p>使用手机号和密码登录。管理员账号用于开通客服账号，默认管理员：admin / admin。</p>
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
              <button
                className={`customer-card ${customer.id === activeCustomer?.id ? "active" : ""}`}
                key={customer.id}
                onClick={() => {
                  setActiveCustomerId(customer.id);
                  setCopiedCustomerId(null);
                  setWorkspaceFocus(customer.response?.recommendations.length || customer.response?.consultation ? "insights" : "chat");
                  setRecommendationView("list");
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

        <section className="chat-panel" onClick={() => setWorkspaceFocus("chat")} onFocus={() => setWorkspaceFocus("chat")}>
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

        <aside className="insight-sidebar" onClick={() => setWorkspaceFocus("insights")} onFocus={() => setWorkspaceFocus("insights")}>
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
            <RecommendationResults
              response={response}
              view={recommendationView}
              onViewChange={setRecommendationView}
            />
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
      )}
    </main>
  );
}

function BrandTitle({ compact }: { compact: boolean }) {
  return (
    <div className={`brand-title ${compact ? "compact" : ""}`}>
      <img src={logoUrl} alt="运东" />
      <h1>运东 Ai 找房助手</h1>
    </div>
  );
}

function RecommendationResults({
  response,
  view,
  onViewChange
}: {
  response: ChatResponse | null;
  view: "list" | "map";
  onViewChange: (view: "list" | "map") => void;
}) {
  const hasRecommendations = Boolean(response?.recommendations.length);
  const hasConsultation = Boolean(response?.consultation);
  const hasLocationMap = Boolean(response?.requirement.location?.center);
  const canShowMap = Boolean(response && (hasRecommendations || hasLocationMap));

  return (
    <>
      <div className="section-title split">
        <div className="section-title">
          <Home size={18} />
          <h2>查询结果</h2>
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
        <RecommendationMap response={response} />
      ) : hasRecommendations && response ? (
        <HouseList houses={response.recommendations} />
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

function HouseList({ houses }: { houses: ChatResponse["recommendations"] }) {
  return (
    <div className="house-list">
      {houses.map((house) => (
        <article className="house-card" key={house.houseId}>
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
            <div className="feedback-row">
              <button><CheckCircle2 size={16} /> 合适</button>
              <button><ThumbsDown size={16} /> 不合适</button>
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}

function RecommendationMap({ response }: { response: ChatResponse }) {
  const mapRef = React.useRef<HTMLDivElement | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const center = response.requirement.location?.center ?? null;
  const coordinateHouses = response.recommendations.filter(hasHouseCoordinate);
  const nearHouses = center ? coordinateHouses.filter((house) => isHouseNearDemand(house)) : coordinateHouses;
  const houses = nearHouses.slice(0, 8);
  const hiddenHouseCount = center ? coordinateHouses.length - nearHouses.length : 0;
  const [selectedHouseId, setSelectedHouseId] = useState<string | null>(houses[0]?.houseId ?? null);
  const selectedHouse = houses.find((house) => house.houseId === selectedHouseId) ?? houses[0] ?? null;

  useEffect(() => {
    if (!houses.length) {
      setSelectedHouseId(null);
      return;
    }
    if (!selectedHouseId || !houses.some((house) => house.houseId === selectedHouseId)) {
      setSelectedHouseId(houses[0].houseId);
    }
  }, [houses, selectedHouseId]);

  useEffect(() => {
    let disposed = false;
    let map: AMapMap | null = null;

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
          content: `<div class="map-marker-result-house ${house.houseId === selectedHouse?.houseId ? "active" : ""}"><span>${index + 1}</span><strong>${house.rentPrice}</strong></div>`,
          zIndex: 10
        });
        marker.on?.("click", () => setSelectedHouseId(house.houseId));
      });
    }

    void renderMap().catch(() => {
      if (!disposed) setMapError("地图加载失败，暂时无法展示房源点位。");
    });

    return () => {
      disposed = true;
      map?.destroy();
    };
  }, [center?.lng, center?.lat, houses, response.requirement.location?.normalized, selectedHouse?.houseId]);

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
        {hiddenHouseCount > 0 ? (
          <p className="map-filter-note">已隐藏 {hiddenHouseCount} 套坐标距离异常的房源，地图以需求位置为中心。</p>
        ) : null}
        {selectedHouse ? <MapSelectedHouseCard house={selectedHouse} /> : null}
        {!houses.length ? <p className="map-filter-note neutral">当前只展示需求位置，推荐房源生成后会在地图上标注。</p> : null}
        {houses.map((house, index) => (
          <article
            className={house.houseId === selectedHouse?.houseId ? "active" : ""}
            key={house.houseId}
            onClick={() => setSelectedHouseId(house.houseId)}
          >
            <span>{index + 1}</span>
            <div>
              <strong>{house.buildingName} {house.houseNumber}</strong>
              <small>{house.rentPrice}元 · {formatDistance(house.distanceMeters)} · {house.bedroom}室{house.livingRoom}厅</small>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
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
      </div>
    </article>
  );
}

function hasHouseCoordinate(house: RecommendedHouse): house is CoordinateHouse {
  return typeof house.lng === "number" && Number.isFinite(house.lng) && typeof house.lat === "number" && Number.isFinite(house.lat);
}

function isHouseNearDemand(house: RecommendedHouse): boolean {
  return house.distanceMeters === undefined || house.distanceMeters === null || house.distanceMeters <= maxRecommendationMapDistanceMeters;
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
};

type AMapMarker = {
  on?(eventName: "click", callback: () => void): void;
};

type AMapGlobal = {
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
    .replace(/一居室|一房|一室一厅|一室|单间|大单间|两房|两室|三房|三室|预算|帮我找|客户想要|客户要|想找|找个|房子|房源|靠近地铁|近地铁|最好|有阳台|带阳台/g, " ")
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
  if (response.consultation) {
    return `${response.consultation.summary} 右侧已整理查询结果和可复制话术。`;
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
