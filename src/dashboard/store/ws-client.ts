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
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;

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

    const ws = new WebSocket(this._url);
    this._ws = ws;

    // If the TCP handshake hangs (SYN sent, no response), the WebSocket stays
    // in CONNECTING state indefinitely and no open/error/close event fires —
    // leaving the UI stuck on "Connecting…".  Force-close after 10 s so the
    // close handler can trigger the normal reconnect cycle.
    const connectTimeoutId = setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }, 10_000);

    ws.addEventListener('open', () => {
      clearTimeout(connectTimeoutId);
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
      clearTimeout(connectTimeoutId);
      this._onConnectionChange?.(false);
    });

    ws.addEventListener('close', () => {
      clearTimeout(connectTimeoutId);
      this._onConnectionChange?.(false);
      if (!this._intentionallyClosed) {
        this._reconnectTimer = setTimeout(async () => {
          this._reconnectTimer = null;
          if (this._onReconnect) await this._onReconnect();
          this.connect();
        }, 3000);
      }
    });
  }

  close(): void {
    this._intentionallyClosed = true;
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._ws?.close();
  }
}
