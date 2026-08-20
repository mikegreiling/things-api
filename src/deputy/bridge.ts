/**
 * Synchronous bridge to the deputy for callers that cannot await — the
 * DatabaseSync-shaped read facade and the sync consent probes. A dedicated
 * worker thread owns the socket; the main thread posts a request, blocks in
 * Atomics.wait on a shared counter, then drains the port with
 * receiveMessageOnPort. One request is in flight at a time by construction
 * (the main thread is blocked while it waits).
 *
 * The bridge must NOT be used for long-running osascript drives — blocking the
 * event loop would suspend the drive watchdog and signal handlers. Async
 * dispatch rides client.ts instead.
 */
import {
  MessageChannel,
  type MessagePort,
  receiveMessageOnPort,
  Worker,
} from "node:worker_threads";

import { DeputyRequestError } from "./protocol.ts";

export class DeputySyncBridge {
  private readonly worker: Worker;
  private readonly flag: Int32Array;
  private readonly port: MessagePort;
  private seq = 0;

  constructor(socketPath: string) {
    const sab = new SharedArrayBuffer(4);
    this.flag = new Int32Array(sab);
    const channel = new MessageChannel();
    this.port = channel.port1;
    // Live TS source runs the .ts twin; the published build runs the emitted
    // .js next to this module (same trick as src/cli/version.ts).
    const ext = import.meta.url.endsWith(".ts") ? "ts" : "js";
    this.worker = new Worker(new URL(`./bridge-worker.${ext}`, import.meta.url), {
      workerData: { socketPath, sab, port: channel.port2 },
      transferList: [channel.port2],
    });
    // The bridge must never keep the CLI process alive on its own.
    this.worker.unref();
  }

  /**
   * Send one request and block until its response (or the deadline). Late
   * responses from a previously timed-out request are drained and discarded by
   * the id match, so one timeout never poisons the next call.
   */
  request(payload: Record<string, unknown>, timeoutMs: number): Record<string, unknown> {
    const id = `s${++this.seq}`;
    let seen = Atomics.load(this.flag, 0);
    // oxlint-disable-next-line require-post-message-target-origin -- worker_threads port, no targetOrigin
    this.port.postMessage({ bridgeId: id, request: payload });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let received = receiveMessageOnPort(this.port);
      while (received !== undefined) {
        const message = received.message as {
          bridgeId: string;
          response?: Record<string, unknown>;
          error?: string;
        };
        if (message.bridgeId === id) {
          if (message.error !== undefined) {
            throw new DeputyRequestError("bridge-io", message.error);
          }
          return message.response ?? {};
        }
        received = receiveMessageOnPort(this.port);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new DeputyRequestError(
          "bridge-timeout",
          `the deputy did not answer within ${timeoutMs}ms`,
        );
      }
      Atomics.wait(this.flag, 0, seen, remaining);
      seen = Atomics.load(this.flag, 0);
    }
  }

  close(): void {
    void this.worker.terminate();
  }
}
