"use strict";
// MCPSRV1 phase 2 — the in-guest MCP client.
//
// Dependency-free on purpose: raw JSON-RPC 2.0 over `net.connect` to the unix
// socket, newline-delimited framing (recon §4.3). The MCP SDK would add nothing
// but a transport whose shape phase 1 already read out of the binary, and the
// guest bundle ships node + dist + commander only.
//
//   node mcpsrv1-probe.js <socket-path> <outdir>
//
// Writes <outdir>/report.json (every cell's verdict, machine-readable) and
// <outdir>/transcript-<cell>.ndjson (the raw lines, both directions). Every
// cell is independently try/caught so one refusal cannot cost the rest.
//
// PROBE ONLY. Runs exclusively inside a disposable Tart guest against synthetic
// fixtures; nothing here is a shipped code path.

const net = require("net");
const fs = require("fs");
const path = require("path");

const SOCK = process.argv[2];
const OUTDIR = process.argv[3] || ".";
const PROTO = "2025-06-18";
const REQ_TIMEOUT_MS = 20000;

const report = { socket: SOCK, cells: {} };

function ms(t0) {
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

function med(a) {
  return a.toSorted((x, y) => x - y)[Math.floor(a.length / 2)];
}

class Client {
  constructor(name) {
    this.name = name;
    this.lines = [];
    this.id = 0;
    this.pending = new Map();
    this.buf = "";
    this.closed = false;
    this.errors = [];
  }

  log(s) {
    this.lines.push(s);
  }

  connect() {
    return new Promise((resolve, reject) => {
      const t0 = process.hrtime.bigint();
      this.sock = net.connect(SOCK);
      this.sock.setNoDelay(true);
      this.sock.on("connect", () => {
        this.connectMs = ms(t0);
        this.log(`# connected in ${this.connectMs.toFixed(1)}ms`);
        resolve();
      });
      this.sock.on("error", (e) => {
        this.errors.push(e.message);
        this.log(`# ERROR ${e.message}`);
        reject(e);
      });
      this.sock.on("close", (hadError) => {
        this.closed = true;
        this.closedHadError = hadError;
        this.log(`# closed (hadError=${hadError})`);
        for (const p of this.pending.values()) p.reject(new Error("connection closed"));
        this.pending.clear();
      });
      this.sock.on("data", (d) => this.onData(d));
    });
  }

  onData(d) {
    this.buf += d.toString("utf8");
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      this.log("< " + line);
      let m = null;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      // A batch response arrives as an array; settle every id it carries.
      const msgs = Array.isArray(m) ? m : [m];
      for (const one of msgs) {
        if (one && one.id !== undefined && this.pending.has(one.id)) {
          const p = this.pending.get(one.id);
          this.pending.delete(one.id);
          p.resolve({ message: one, ms: ms(p.t0), batched: Array.isArray(m) });
        }
      }
    }
  }

  writeLine(s) {
    this.log("> " + s);
    this.sock.write(s + "\n");
  }

  request(method, params) {
    const id = ++this.id;
    const msg = { jsonrpc: "2.0", id, method };
    if (params !== undefined) msg.params = params;
    return new Promise((resolve, reject) => {
      const t0 = process.hrtime.bigint();
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          resolve({ message: null, timedOut: true, ms: ms(t0) });
        }
      }, REQ_TIMEOUT_MS);
      this.pending.set(id, {
        t0,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.writeLine(JSON.stringify(msg));
    });
  }

  notify(method, params) {
    const msg = { jsonrpc: "2.0", method };
    if (params !== undefined) msg.params = params;
    this.writeLine(JSON.stringify(msg));
  }

  // Send a line we composed ourselves — malformed JSON, a batch array, a
  // request with a non-conforming shape. Waits `waitMs` for anything to come
  // back rather than matching an id.
  rawLine(s, waitMs = 3000) {
    this.log("> " + s);
    const before = this.lines.length;
    this.sock.write(s + "\n");
    return new Promise((resolve) => {
      setTimeout(() => resolve(this.lines.slice(before + 1)), waitMs);
    });
  }

  end() {
    try {
      this.sock.end();
    } catch {
      /* already gone */
    }
  }

  dump(label) {
    fs.writeFileSync(path.join(OUTDIR, `transcript-${label}.ndjson`), this.lines.join("\n") + "\n");
  }
}

async function handshake(c, protocolVersion = PROTO) {
  const r = await c.request("initialize", {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "mcpsrv1-probe", version: "0" },
  });
  c.notify("notifications/initialized");
  return r;
}

// `structuredContent` is the typed half of a tools/call result; `content` is
// the text half. Prefer the structured one, fall back to parsing the text.
function payloadOf(res) {
  const r = res && res.message && res.message.result;
  if (!r) return null;
  if (r.structuredContent) return r.structuredContent;
  if (Array.isArray(r.content)) {
    for (const c of r.content) {
      if (c && typeof c.text === "string") {
        try {
          return JSON.parse(c.text);
        } catch {
          return { _text: c.text };
        }
      }
    }
  }
  return null;
}

async function cell(name, fn) {
  process.stdout.write(`## ${name}\n`);
  try {
    report.cells[name] = await fn();
  } catch (e) {
    report.cells[name] = { error: String((e && e.message) || e) };
  }
  process.stdout.write(`   -> ${JSON.stringify(report.cells[name]).slice(0, 400)}\n`);
}

(async () => {
  // ---------------------------------------------------------------- D/E
  // Handshake, catalog, and the whole paginated read, on one connection.
  let firstCursor = null;
  let exhaustedCursor = null;

  await cell("D-handshake", async () => {
    const c = new Client("D");
    await c.connect();
    const init = await handshake(c);
    const list = await c.request("tools/list", {});
    const listNoParams = await c.request("tools/list");
    report.toolsListRaw = list.message;
    const out = {
      connectMs: c.connectMs,
      initializeMs: init.ms,
      initializeResult: init.message,
      toolsListMs: list.ms,
      toolsListResult: list.message,
      toolsListWithoutParams: listNoParams.message,
    };
    c.end();
    c.dump("D-handshake");
    return out;
  });

  await cell("E-pagination", async () => {
    const c = new Client("E");
    await c.connect();
    await handshake(c);
    const pages = [];
    let cursor;
    let guard = 0;
    for (;;) {
      const args = cursor === undefined ? {} : { cursor };
      const res = await c.request("tools/call", { name: "GetTodayList", arguments: args });
      const p = payloadOf(res);
      pages.push({
        index: pages.length,
        requestArgs: args,
        latencyMs: res.ms,
        isError: res.message && res.message.result && res.message.result.isError,
        itemCount: p && Array.isArray(p.items) ? p.items.length : null,
        nextCursor: p ? p.nextCursor : undefined,
        // content/structuredContent duality, recorded once
        resultKeys: res.message && res.message.result ? Object.keys(res.message.result) : null,
        items: p && p.items ? p.items : null,
      });
      if (pages.length === 1) firstCursor = p && p.nextCursor;
      if (!p || !p.nextCursor) break;
      cursor = p.nextCursor;
      if (++guard > 40) break;
    }
    exhaustedCursor = pages.length ? pages[pages.length - 1].requestArgs.cursor : null;
    const all = pages.flatMap((p) => p.items || []);
    fs.writeFileSync(path.join(OUTDIR, "today-items.json"), JSON.stringify(all, null, 2));
    const out = {
      pageCount: pages.length,
      pageSizes: pages.map((p) => p.itemCount),
      totalItems: all.length,
      latenciesMs: pages.map((p) => Math.round(p.latencyMs * 10) / 10),
      resultKeys: pages[0] && pages[0].resultKeys,
      // full items land in today-items.json; keep the report readable
      firstItem: all[0],
      order: all.map((it) => (it && it.attributes && it.attributes.title) || null),
      kinds: [...new Set(all.map((it) => it && it.type))],
      exhaustedCursor: exhaustedCursor,
      heldCursor: firstCursor,
    };
    c.end();
    c.dump("E-pagination");
    return out;
  });

  // ---------------------------------------------------------------- G
  // Every edge cell, on one connection until something kills it.
  await cell("G-edges", async () => {
    const c = new Client("G");
    await c.connect();
    await handshake(c);
    const out = {};
    const call = async (label, args) => {
      const res = await c.request("tools/call", { name: "GetTodayList", arguments: args });
      out[label] = res.message;
      return res;
    };

    // A cursor from a page whose nextCursor was absent (the exhausted page) and
    // a cursor minted by a DIFFERENT session — both are "reuse" questions.
    if (exhaustedCursor) await call("reuse-exhausted-cursor", { cursor: exhaustedCursor });
    if (firstCursor) await call("cross-session-cursor", { cursor: firstCursor });
    await call("garbage-cursor", { cursor: "not-a-real-cursor" });
    await call("wrong-typed-cursor", { cursor: 123 });
    await call("null-cursor", { cursor: null });
    await call("extra-property", { cursor: "x", extra: true });

    const unknown = await c.request("tools/call", { name: "NoSuchTool", arguments: {} });
    out["unknown-tool"] = unknown.message;
    const write = await c.request("tools/call", {
      name: "AddTodo",
      arguments: { title: "MCP1-WRITE-PROBE" },
    });
    out["write-tool-name"] = write.message;

    for (const m of [
      "resources/list",
      "prompts/list",
      "ping",
      "logging/setLevel",
      "completion/complete",
    ]) {
      const r = await c.request(m, {});
      out[m] = r.message;
    }
    out["_closedAfterEdges"] = c.closed;
    c.end();
    c.dump("G-edges");
    return out;
  });

  // ---------------------------------------------------------------- batch
  await cell("G-batch", async () => {
    const c = new Client("batch");
    await c.connect();
    await handshake(c);
    const got = await c.rawLine(
      JSON.stringify([
        { jsonrpc: "2.0", id: 900, method: "tools/list", params: {} },
        { jsonrpc: "2.0", id: 901, method: "tools/list", params: {} },
      ]),
      4000,
    );
    const out = { responseLines: got, closed: c.closed };
    c.end();
    c.dump("G-batch");
    return out;
  });

  // ---------------------------------------------------------------- malformed
  await cell("G-malformed", async () => {
    const c = new Client("malformed");
    await c.connect();
    await handshake(c);
    const got = await c.rawLine("{this is not json", 4000);
    const out = { responseLines: got, closedAfterMalformed: c.closed };
    // Does the peer still answer after a bad line?
    if (!c.closed) {
      const after = await c.request("tools/list", {});
      out.survivedMalformed = !!(after.message && after.message.result);
      out.afterMalformed = after.message;
    }
    c.end();
    c.dump("G-malformed");
    return out;
  });

  // ---------------------------------------------------------------- uninitialized
  await cell("G-call-before-initialize", async () => {
    const c = new Client("preinit");
    await c.connect();
    const r = await c.request("tools/list", {});
    const out = { result: r.message, timedOut: r.timedOut, closed: c.closed };
    c.end();
    c.dump("G-call-before-initialize");
    return out;
  });

  // ---------------------------------------------------------------- protocol negotiation
  await cell("G-protocol-negotiation", async () => {
    const out = {};
    for (const v of ["2024-11-05", "2025-03-26", "2099-01-01", "garbage"]) {
      const c = new Client("proto-" + v);
      await c.connect();
      const r = await c.request("initialize", {
        protocolVersion: v,
        capabilities: {},
        clientInfo: { name: "mcpsrv1-probe", version: "0" },
      });
      out[v] = r.message;
      c.end();
      c.dump("G-protocol-" + v);
    }
    return out;
  });

  // ---------------------------------------------------------------- concurrency
  await cell("G-concurrent-clients", async () => {
    const a = new Client("conc-a");
    const b = new Client("conc-b");
    await a.connect();
    await b.connect();
    const ia = await handshake(a);
    const ib = await handshake(b);
    const [ra, rb] = await Promise.all([
      a.request("tools/call", { name: "GetTodayList", arguments: {} }),
      b.request("tools/call", { name: "GetTodayList", arguments: {} }),
    ]);
    const pa = payloadOf(ra);
    const pb = payloadOf(rb);
    // Is a cursor minted on A usable on B? (Is the page snapshot per-session?)
    let crossover = null;
    if (pa && pa.nextCursor) {
      const r = await b.request("tools/call", {
        name: "GetTodayList",
        arguments: { cursor: pa.nextCursor },
      });
      crossover = r.message;
    }
    const out = {
      bothConnected: !a.closed && !b.closed,
      initA: ia.message && ia.message.result && ia.message.result.serverInfo,
      initB: ib.message && ib.message.result && ib.message.result.serverInfo,
      aItems: pa && pa.items ? pa.items.length : null,
      bItems: pb && pb.items ? pb.items.length : null,
      aCursor: pa && pa.nextCursor,
      bCursor: pb && pb.nextCursor,
      cursorsDiffer: !!(pa && pb && pa.nextCursor !== pb.nextCursor),
      crossSessionCursorResult: crossover,
      latencyMs: { a: ra.ms, b: rb.ms },
    };
    a.end();
    b.end();
    a.dump("G-concurrent-a");
    b.dump("G-concurrent-b");
    return out;
  });

  // ---------------------------------------------------------------- latency
  // Cold = a fresh connection + handshake + first call. Warm = repeated calls
  // on an established session.
  await cell("H-latency", async () => {
    const cold = [];
    for (let i = 0; i < 3; i++) {
      const c = new Client("cold" + i);
      await c.connect();
      const init = await handshake(c);
      const call = await c.request("tools/call", { name: "GetTodayList", arguments: {} });
      cold.push({
        connectMs: c.connectMs,
        initializeMs: init.ms,
        firstCallMs: call.ms,
      });
      c.end();
    }
    const c = new Client("warm");
    await c.connect();
    await handshake(c);
    const warm = [];
    for (let i = 0; i < 10; i++) {
      const r = await c.request("tools/call", { name: "GetTodayList", arguments: {} });
      warm.push(Math.round(r.ms * 100) / 100);
    }
    const listWarm = [];
    for (let i = 0; i < 10; i++) {
      const r = await c.request("tools/list", {});
      listWarm.push(Math.round(r.ms * 100) / 100);
    }
    c.end();
    c.dump("H-latency");
    return {
      cold,
      warmCallMs: warm,
      warmCallMedianMs: med(warm),
      warmToolsListMs: listWarm,
      warmToolsListMedianMs: med(listWarm),
    };
  });

  // ---------------------------------------------------------------- cursor TTL
  // The tool description says cursors "expire after a short time". Hold one and
  // watch it die; the step sizes bracket the TTL without costing ten minutes.
  await cell("F-cursor-ttl", async () => {
    const c = new Client("ttl");
    await c.connect();
    await handshake(c);
    const first = await c.request("tools/call", { name: "GetTodayList", arguments: {} });
    const p = payloadOf(first);
    if (!p || !p.nextCursor) return { skipped: "first page had no nextCursor — nothing to expire" };
    const cursor = p.nextCursor;
    const steps = [];
    let waited = 0;
    for (const delay of [15, 30, 45, 60, 90]) {
      await new Promise((r) => setTimeout(r, delay * 1000));
      waited += delay;
      const r = await c.request("tools/call", { name: "GetTodayList", arguments: { cursor } });
      const isErr = !!(
        r.message &&
        (r.message.error || (r.message.result && r.message.result.isError))
      );
      steps.push({ heldSeconds: waited, isError: isErr, message: r.message });
      if (isErr) break;
    }
    const out = {
      cursorHeldSteps: steps,
      expiredAfterSeconds: steps.find((s) => s.isError)?.heldSeconds ?? null,
    };
    c.end();
    c.dump("F-cursor-ttl");
    return out;
  });

  fs.writeFileSync(path.join(OUTDIR, "report.json"), JSON.stringify(report, null, 2));
  process.stdout.write("PROBE-DONE\n");
  process.exit(0);
})().catch((e) => {
  report.fatal = String((e && e.stack) || e);
  try {
    fs.writeFileSync(path.join(OUTDIR, "report.json"), JSON.stringify(report, null, 2));
  } catch {
    /* outdir gone */
  }
  process.stdout.write("PROBE-FATAL " + String(e) + "\n");
  process.exit(1);
});
