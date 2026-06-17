export interface GameEvent {
  type: "state" | "decision" | "result";
  gameId: string;
  model: string;
  seed: string;
  ts: number;
}

export interface StateEvent extends GameEvent {
  type: "state";
  state: Record<string, unknown>;
}

export interface DecisionEvent extends GameEvent {
  type: "decision";
  reasoning: string;
  action: { tool: string; args: Record<string, unknown> };
  legalActions: string[];
  state: Record<string, unknown>;
  step?: number;
  usage?: { tokensIn: number; tokensOut: number; costUsd?: number };
  diagnostic?: Record<string, unknown>;
  /** Set when the game rejected the move (illegal / unknown tool / bad args). */
  illegal?: string;
}

export interface ResultEvent extends GameEvent {
  type: "result";
  /** won | lost | cap | stuck | error */
  outcome: string;
  won?: boolean;
  finalAnte: number;
  finalRound: number;
  dollars: number;
}

export type BalatroEvent = StateEvent | DecisionEvent | ResultEvent;

export type EventHandler = (event: BalatroEvent) => void;

export class EventBus {
  private handlers: Set<EventHandler> = new Set();
  private buffer: BalatroEvent[] = [];

  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(event: BalatroEvent): void {
    this.buffer.push(event);
    for (const h of this.handlers) h(event);
  }

  flush(): BalatroEvent[] {
    const b = this.buffer;
    this.buffer = [];
    return b;
  }
}

export const globalBus = new EventBus();
