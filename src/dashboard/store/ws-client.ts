interface DashboardEvent {
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export class WsClient {
  private _url: string;
  private _onEvent: (event: DashboardEvent) => void;
  private _onReconnect: (() => Promise<void>) | null;
  private _onConnectionChange: ((connected: boolean) => void) | null;
  private _ws: WebSocket | null = null;
  private _intentionallyClosed = false;

  constructor(
    url: string,
    onEvent: (event: DashboardEvent) => void,
    onReconnect?: () => Promise<void>,
    onConnectionChange?: (connected: boolean) => void
  ) {
    this._url = url;
    this._onEvent = onEvent;
    this._onReconnect = onReconnect ?? null;
    this._onConnectionChange = onConnectionChange ?? null;
  }

  connect(): void {
    this._intentionallyClosed = false;
    this._onConnectionChange?.(false);

    const ws = new WebSocket(this._url);
    this._ws = ws;

    ws.addEventListener('open', () => {
      this._onConnectionChange?.(true);
    });

    ws.addEventListener('message', (event) => {
      try {
        const parsed = JSON.parse(event.data as string) as DashboardEvent;
        this._onEvent(parsed);
      } catch {
        console.warn('[WsClient] failed to parse message');
      }
    });

    ws.addEventListener('error', () => {
      this._onConnectionChange?.(false);
    });

    ws.addEventListener('close', () => {
      this._onConnectionChange?.(false);
      if (!this._intentionallyClosed) {
        setTimeout(async () => {
          if (this._onReconnect) await this._onReconnect();
          this.connect();
        }, 3000);
      }
    });
  }

  close(): void {
    this._intentionallyClosed = true;
    this._ws?.close();
  }
}
