/**
 * Async deputy client for event-loop-friendly callers: the applescript vector
 * and the ui vector's step runner. Long osascript drives ride this client so
 * timers (drive watchdog) and signal handlers keep running; synchronous
 * callers ride bridge.ts instead. One shared socket, requests matched by id.
 */
import { connect, type Socket } from "node:net";

import { DeputyRequestError } from "./protocol.ts";

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class DeputyAsyncClient {
  private socket: Socket | null = null;
  private buffer = "";
  private seq = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly socketPath: string;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  private ensureSocket(): Promise<Socket> {
    if (this.socket !== null) return Promise.resolve(this.socket);
    return new Promise((resolve, reject) => {
      const sock = connect(this.socketPath);
      sock.setEncoding("utf8");
      sock.once("connect", () => {
        this.socket = sock;
        // An idle deputy connection must never keep the CLI process alive.
        sock.unref();
        resolve(sock);
      });
      sock.on("data", (chunk: string) => this.onData(chunk));
      sock.on("error", (err: Error) => {
        if (this.socket === null) reject(err);
        this.failAll(err);
      });
      sock.on("close", () => this.failAll(new Error("deputy closed the connection")));
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl < 0) return;
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const id = typeof parsed["id"] === "string" ? parsed["id"] : null;
      const entry = id !== null ? this.pending.get(id) : undefined;
      if (id === null || entry === undefined) continue;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.resolve(parsed);
    }
  }

  private failAll(err: Error): void {
    this.socket = null;
    this.buffer = "";
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const entry of waiting) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
  }

  /**
   * Send one request; resolves with the raw response object (protocol errors
   * included — the caller inspects `ok`). Rejects only on transport failure or
   * client-side deadline (`timeoutMs` should exceed any deputy-side timeout so
   * the deputy's own honest answer wins).
   */
  async request(
    payload: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const sock = await this.ensureSocket();
    const id = `a${++this.seq}`;
    // Wake the socket handle while a request is in flight (see unref above).
    sock.ref();
    try {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(
            new DeputyRequestError(
              "client-timeout",
              `the deputy did not answer within ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
        this.pending.set(id, { resolve, reject, timer });
        sock.write(`${JSON.stringify({ ...payload, id })}\n`);
      });
    } finally {
      if (this.pending.size === 0) sock.unref();
    }
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}
