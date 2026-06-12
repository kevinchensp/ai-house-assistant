export type AssistantEventType =
  | "message_sent"
  | "requirement_extracted"
  | "follow_up_asked"
  | "location_resolved"
  | "mcp_called"
  | "mcp_failed"
  | "recommendation_shown"
  | "reply_generated"
  | "reply_copied"
  | "feedback_submitted"
  | "viewing_intent_marked";

export type AssistantEvent = {
  type: AssistantEventType;
  sessionId: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export class InMemoryEventLogger {
  private readonly events: AssistantEvent[] = [];

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  record(type: AssistantEventType, event: { sessionId: string; payload?: Record<string, unknown> }): void {
    this.events.push({
      type,
      sessionId: event.sessionId,
      payload: event.payload ?? {},
      createdAt: this.now()
    });
  }

  all(): AssistantEvent[] {
    return [...this.events];
  }
}
