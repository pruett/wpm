const KEEPALIVE_INTERVAL_MS = 30_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

type SSEClientEntry = {
  controller: ReadableStreamDefaultController;
  keepaliveTimer: ReturnType<typeof setInterval>;
};

type ParsedSSEEvent = {
  event: string;
  data: string;
};

export class SSERelay {
  private clients = new Map<string, SSEClientEntry>();
  private nodeUrl: string;
  private abortController: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private connected = false;

  constructor(nodeUrl: string) {
    this.nodeUrl = nodeUrl;
  }

  async connect(): Promise<void> {
    this.abortController = new AbortController();

    try {
      const res = await fetch(`${this.nodeUrl}/internal/events`, {
        signal: this.abortController.signal,
        headers: { Accept: "text/event-stream" },
      });

      if (!res.ok || !res.body) {
        throw new Error(`Node SSE returned ${res.status}`);
      }

      this.connected = true;
      this.reconnectAttempts = 0;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // SSE events are delimited by double newlines
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) !== -1) {
            const chunk = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);

            const parsed = this.parseSSEChunk(chunk);
            if (parsed) {
              this.broadcast(parsed.event, parsed.data);
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      // Stream ended — reconnect
      this.connected = false;
      this.scheduleReconnect();
    } catch (err) {
      this.connected = false;
      if (this.abortController?.signal.aborted) return;
      this.scheduleReconnect();
    }
  }

  private parseSSEChunk(chunk: string): ParsedSSEEvent | null {
    let event = "";
    let data = "";

    for (const line of chunk.split("\n")) {
      if (line.startsWith(":")) continue; // comment (keepalive)
      if (line.startsWith("event: ")) {
        event = line.slice(7);
      } else if (line.startsWith("data: ")) {
        data = line.slice(6);
      }
    }

    if (!event || !data) return null;
    return { event, data };
  }

  private scheduleReconnect(): void {
    if (this.abortController?.signal.aborted) return;

    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  addClient(userId: string): ReadableStream {
    // Enforce 1 connection per user — close prior
    this.removeClient(userId);

    let savedController: ReadableStreamDefaultController;

    const stream = new ReadableStream({
      start: (controller) => {
        savedController = controller;

        const keepaliveTimer = setInterval(() => {
          try {
            controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
          } catch {
            this.removeClient(userId);
          }
        }, KEEPALIVE_INTERVAL_MS);

        this.clients.set(userId, { controller, keepaliveTimer });
      },
      cancel: () => {
        this.removeClient(userId);
      },
    });

    return stream;
  }

  removeClient(userId: string): void {
    const client = this.clients.get(userId);
    if (!client) return;

    clearInterval(client.keepaliveTimer);
    try {
      client.controller.close();
    } catch {
      // already closed
    }
    this.clients.delete(userId);
  }

  private broadcast(event: string, data: string): void {
    const payload = new TextEncoder().encode(`event: ${event}\ndata: ${data}\n\n`);

    for (const [userId, client] of this.clients) {
      try {
        client.controller.enqueue(payload);
      } catch {
        this.removeClient(userId);
      }
    }
  }

  get connectedClients(): number {
    return this.clients.size;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  close(): void {
    this.abortController?.abort();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    for (const [userId] of this.clients) {
      this.removeClient(userId);
    }

    this.connected = false;
  }
}

let relay: SSERelay | null = null;

export function createRelay(nodeUrl: string): SSERelay {
  if (relay) relay.close();
  relay = new SSERelay(nodeUrl);
  return relay;
}

export function getRelay(): SSERelay {
  if (!relay) throw new Error("SSE relay not initialized — call createRelay() first");
  return relay;
}
