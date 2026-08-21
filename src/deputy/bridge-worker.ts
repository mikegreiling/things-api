/**
 * Worker half of the synchronous deputy bridge (see bridge.ts). Owns the
 * long-lived socket to the deputy and services one request at a time: the main
 * thread posts a request on the message port and blocks in Atomics.wait; this
 * worker performs the socket round-trip, posts the response back, and bumps the
 * shared counter to wake the main thread.
 */
import { connect, type Socket } from "node:net";
import { type MessagePort, workerData } from "node:worker_threads";

interface WorkerInit {
  socketPath: string;
  sab: SharedArrayBuffer;
  port: MessagePort;
}

const { socketPath, sab, port } = workerData as WorkerInit;
const flag = new Int32Array(sab);

let socket: Socket | null = null;
let buffer = "";
let pendingLine: ((line: string) => void) | null = null;
let pendingError: ((err: Error) => void) | null = null;

function resetSocket(err: Error): void {
  socket = null;
  buffer = "";
  const reject = pendingError;
  pendingLine = null;
  pendingError = null;
  reject?.(err);
}

function ensureSocket(): Promise<Socket> {
  if (socket !== null) return Promise.resolve(socket);
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    sock.setEncoding("utf8");
    sock.once("connect", () => {
      socket = sock;
      resolve(sock);
    });
    sock.on("data", (chunk: string) => {
      buffer += chunk;
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const deliver = pendingLine;
      pendingLine = null;
      pendingError = null;
      deliver?.(line);
    });
    sock.on("error", (err: Error) => {
      if (socket === null) reject(err);
      resetSocket(err);
    });
    sock.on("close", () => {
      resetSocket(new Error("deputy closed the connection"));
    });
  });
}

async function roundTrip(request: Record<string, unknown>): Promise<unknown> {
  const sock = await ensureSocket();
  const line = await new Promise<string>((resolve, reject) => {
    pendingLine = resolve;
    pendingError = reject;
    sock.write(`${JSON.stringify(request)}\n`);
  });
  return JSON.parse(line) as unknown;
}

interface BridgeEnvelope {
  bridgeId: string;
  request: Record<string, unknown>;
}

port.on("message", ({ bridgeId, request }: BridgeEnvelope) => {
  void roundTrip(request)
    .then((response) => ({ bridgeId, response: response as Record<string, unknown> }))
    .catch((err: unknown) => ({
      bridgeId,
      error: err instanceof Error ? err.message : String(err),
    }))
    .then((envelope) => {
      port.postMessage(envelope);
      Atomics.add(flag, 0, 1);
      Atomics.notify(flag, 0);
    });
});
port.start();
