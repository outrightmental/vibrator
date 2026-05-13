export type DashboardEventType =
  | "cycle-start"
  | "phase-update"
  | "action-start"
  | "action-complete"
  | "action-error"
  | "workflow-approval"
  | "snapshot-update"
  | "plan-update"
  | "iteration-start"
  | "iteration-complete"
  | "cycle-countdown";

export interface DashboardEvent {
  type: DashboardEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

export class EventEmitter {
  private listeners: Set<(event: DashboardEvent) => void> = new Set();

  subscribe(listener: (event: DashboardEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(type: DashboardEventType, data: Record<string, unknown>): void {
    const event: DashboardEvent = {
      type,
      timestamp: new Date().toISOString(),
      data,
    };
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  getListenerCount(): number {
    return this.listeners.size;
  }
}

export const globalEventEmitter = new EventEmitter();
