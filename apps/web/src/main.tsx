import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { CheckCircle2, Copy, Home, MessageSquareText, Search, Send, ThumbsDown } from "lucide-react";
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

function App() {
  const [message, setMessage] = useState("帮我找白云东平一室一厅，预算1000左右");
  const [response, setResponse] = useState<ChatResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  async function submit() {
    setIsLoading(true);
    setCopied(false);
    try {
      const result = await fetch(`${apiBaseUrl}/api/ai-house-assistant/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "demo-session", message })
      });
      setResponse((await result.json()) as ChatResponse);
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
          <p className="eyebrow">内部客服工作台</p>
          <h1>AI 找房助手</h1>
        </div>
        <div className="status-pill">
          <span />
          P0 本地框架
        </div>
      </section>

      <section className="workspace">
        <section className="conversation-panel">
          <div className="panel-heading">
            <MessageSquareText size={20} />
            <h2>客户需求</h2>
          </div>
          <textarea value={message} onChange={(event) => setMessage(event.target.value)} />
          <button className="primary-button" onClick={submit} disabled={isLoading}>
            <Send size={18} />
            {isLoading ? "查询中" : "开始找房"}
          </button>

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
          ) : null}
        </section>

        <section className="results-panel">
          <div className="panel-heading">
            <Search size={20} />
            <h2>推荐房源</h2>
          </div>
          {response?.recommendations.length ? (
            <div className="house-list">
              {response.recommendations.map((house) => (
                <article className="house-card" key={house.houseId}>
                  <div className="house-title">
                    <Home size={18} />
                    <h3>
                      {house.buildingName} {house.houseNumber}
                    </h3>
                  </div>
                  <div className="house-meta">
                    <span>{house.bedroom}室{house.livingRoom}厅{house.toilet}卫</span>
                    <span>{house.area}平</span>
                    <span>押金 {house.deposit}</span>
                  </div>
                  <div className="rent-row">
                    <strong>{house.rentPrice}</strong>
                    <span>元/月</span>
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
            <div className="empty-state">输入客户需求后，这里会展示推荐房源。</div>
          )}
        </section>

        <section className="reply-panel">
          <div className="panel-heading">
            <Copy size={20} />
            <h2>客服话术</h2>
          </div>
          <pre>{response?.salesReply.text ?? "生成后可一键复制给客户。"}</pre>
          <button className="secondary-button" onClick={copyReply} disabled={!response}>
            <Copy size={16} />
            {copied ? "已复制" : "复制话术"}
          </button>
        </section>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
