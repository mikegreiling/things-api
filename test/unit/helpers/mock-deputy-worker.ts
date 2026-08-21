/**
 * A mock things-deputy speaking the wire protocol, hosted in a worker thread.
 * It must NOT run on the test's main thread: the sync bridge under test blocks
 * that thread in Atomics.wait, so a same-thread server could never answer.
 *
 * workerData shapes the behavior:
 *   socketPath   — where to listen
 *   token        — expected request token
 *   deputyVersion, protocol, dbPath — hello fields
 *   sqlRows      — canned rows returned for every sql request
 *   osaResult    — canned osascript result fields
 */
import { createServer } from "node:net";
import { parentPort, workerData } from "node:worker_threads";

interface MockConfig {
  socketPath: string;
  token: string;
  deputyVersion: string;
  protocol: number;
  dbPath: string | null;
  /** hello's dbPath (the deputy's CACHE — null until a locate/sql resolved it). */
  helloDbPath: string | null;
  /** Mock a READER: hello carries role+granted; automation verbs refuse. */
  reader?: { granted: boolean };
  sqlRows: Record<string, unknown>[];
  osaResult: Record<string, unknown>;
}

const cfg = workerData as MockConfig;

function respond(req: Record<string, unknown>): Record<string, unknown> {
  const id = req["id"] ?? null;
  if (req["v"] !== 1) {
    return { id, ok: false, error: { code: "unsupported-protocol", message: "mock speaks 1" } };
  }
  if (req["token"] !== cfg.token) {
    return { id, ok: false, error: { code: "bad-token", message: "token mismatch" } };
  }
  switch (req["verb"]) {
    case "hello":
      return {
        id,
        ok: true,
        protocol: cfg.protocol,
        deputyVersion: cfg.deputyVersion,
        pid: 4242,
        dbPath: cfg.helloDbPath,
        uptimeMs: 7,
        ...(cfg.reader !== undefined && { role: "reader", granted: cfg.reader.granted }),
      };
    case "sql":
      // Reader mocks tag rows so tests can assert WHICH transport served them.
      return {
        id,
        ok: true,
        rows: cfg.reader !== undefined ? [{ servedBy: "reader" }, ...cfg.sqlRows] : cfg.sqlRows,
      };
    case "osascript":
      return { id, ok: true, ...cfg.osaResult };
    case "shortcuts":
      return {
        id,
        ok: true,
        exitCode: 0,
        stdout: `${String(req["op"])}:${String(req["name"] ?? "")}`,
        stderr: "",
      };
    case "read-file":
      return { id, ok: true, b64: Buffer.from(`mock:${String(req["path"])}`).toString("base64") };
    case "locate":
      return cfg.dbPath !== null
        ? { id, ok: true, path: cfg.dbPath, otherCandidates: [] }
        : { id, ok: false, error: { code: "not-found", message: "no database" } };
    default:
      return { id, ok: false, error: { code: "bad-request", message: "unknown verb" } };
  }
}

const server = createServer((socket) => {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const req = JSON.parse(line) as Record<string, unknown>;
      socket.write(`${JSON.stringify(respond(req))}\n`);
    }
  });
  socket.on("error", () => {});
});

server.listen(cfg.socketPath, () => {
  // oxlint-disable-next-line require-post-message-target-origin -- worker_threads port, no targetOrigin
  parentPort?.postMessage("ready");
});
