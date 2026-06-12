import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { CheckCircle2, Copy, Home, MapPin, Send, Sparkles, ThumbsDown } from "lucide-react";
import "./styles.css";

type ChatResponse = {
  sessionId: string;
  requirement: {
    location: { normalized: string; district: string | null; confidence: number } | null;
    budget: { target: number; min: number; max: number } | null;
    layout: { bedroom: number | null; livingRoom: number | null };
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

type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
};

function App() {
  const [message, setMessage] = useState("帮我找白云东平一室一厅，预算1000左右");
  const [response, setResponse] = useState<ChatResponse | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      text: "你好，我是运东 Ai 找房助手。把客户的区域、预算、户型发给我，我会先查严格匹配，没房源时再按周边距离和预算策略扩圈。"
    }
  ]);
  const [isLoading, setIsLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  async function submit() {
    const trimmedMessage = message.trim();
    if (!trimmedMessage || isLoading) return;

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text: trimmedMessage
    };
    setMessages((current) => [...current, userMessage]);
    setMessage("");
    setIsLoading(true);
    setCopied(false);
    try {
      const result = await fetch(`${apiBaseUrl}/api/ai-house-assistant/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "demo-session", message: trimmedMessage })
      });
      const nextResponse = (await result.json()) as ChatResponse;
      setResponse(nextResponse);
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          text: buildAssistantMessage(nextResponse)
        }
      ]);
    } finally {
      setIsLoading(false);
    }
  }

  async function copyReply() {
    if (!response) return;
    await navigator.clipboard.writeText(response.salesReply.text);
    setCopied(true);
  }

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <h1>运东 Ai 找房助手</h1>
        </div>
        <div className="status-pill">
          <span />
          P0 本地演示
        </div>
      </section>

      <section className="workspace">
        <section className="chat-panel">
          <div className="chat-thread" aria-live="polite">
            {messages.map((chatMessage) => (
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
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  void submit();
                }
              }}
              placeholder="输入客户需求，例如：白云东平一室一厅，预算1000左右"
            />
            <button className="send-button" onClick={submit} disabled={isLoading || !message.trim()} title="发送需求">
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
                  <strong>{response.requirement.location?.normalized ?? "待确认"}</strong>
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
                  <strong>
                    {response.requirement.layout.bedroom ?? "?"}室{response.requirement.layout.livingRoom ?? "?"}厅
                  </strong>
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

createRoot(document.getElementById("root")!).render(<App />);
