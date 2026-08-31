/**
 * A STAND-IN for the sandboxed reader, for the VM lab only.
 *
 * WHY IT EXISTS. The shipped reader is a Developer-ID-signed, App-Sandboxed
 * bundle holding a security-scoped bookmark over the Things group container. A
 * disposable golden clone has no signing identity and nobody to answer the
 * grant panel, so the real helpers cannot be onboarded in-guest — which used to
 * mean the lab could not model the shape a helpers household actually runs in.
 * That is the shape issue #664 was reported from.
 *
 * This process stands in for exactly one property of the reader: it holds the
 * container access, and clients reach it over the rendezvous instead of
 * touching the container themselves. Started over ssh, it inherits
 * `sshd-keygen-wrapper`'s Full Disk Access (the APDP1 probe-fidelity note), so
 * its own reads are silent; a client launched from Terminal.app holds nothing.
 * Point that client at it with THINGS_API_READER_DIR + THINGS_API_HELPERS=true
 * and the split is the field's: the grant lives in one process, the caller in
 * another.
 *
 * IT IS NOT THE READER and must never be confused for it. No sandbox, no
 * bookmark, no signature, no launchd, no grant ceremony — so it proves nothing
 * about the reader's own security properties. What it makes testable is the
 * CLIENT side: whether our code routes a container touch through the
 * rendezvous, or reaches past it. Nothing here ships.
 *
 * Wire protocol: newline-delimited JSON over a unix socket (src/deputy/
 * protocol.ts, bridge-worker.ts). File verbs only — hello / locate / sql /
 * read-file — because that is all the reader itself serves.
 *
 *   node standin-reader.mjs --socket <path> --token <tok> --db <main.sqlite>
 */
import { createServer } from "node:net";
import { readFileSync, unlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const PROTOCOL = 1;
const VERSION = "1.3.0"; // EXPECTED_HELPERS_VERSION — a skew makes routing refuse

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const socketPath = arg("--socket");
const token = arg("--token");
const dbPath = arg("--db");
if (!socketPath || !token || !dbPath) {
  console.error("usage: standin-reader.mjs --socket <p> --token <t> --db <p>");
  process.exit(2);
}

// The whole point: THIS process opens the container, and it does so once, at
// start, from the lineage that holds the access.
const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 2000 });
let served = 0;

/** BLOBs cross the wire base64-tagged; protocol.ts `reviveRow` unwraps them. */
function encodeRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v instanceof Uint8Array ? { $b64: Buffer.from(v).toString("base64") } : v;
  }
  return out;
}

function respond(req) {
  const id = req.id ?? null;
  if (req.v !== PROTOCOL) {
    return {
      id,
      ok: false,
      error: { code: "unsupported-protocol", message: `speaks ${PROTOCOL}` },
    };
  }
  if (req.token !== token) {
    return { id, ok: false, error: { code: "bad-token", message: "token mismatch" } };
  }
  served += 1;
  switch (req.verb) {
    case "hello":
      return {
        id,
        ok: true,
        protocol: PROTOCOL,
        deputyVersion: VERSION,
        pid: process.pid,
        dbPath,
        uptimeMs: Math.round(process.uptime() * 1000),
        role: "reader",
        granted: true,
      };
    case "locate":
      return { id, ok: true, path: dbPath, otherCandidates: [] };
    case "sql":
      try {
        const rows = db.prepare(req.sql).all(...(req.params ?? []));
        return { id, ok: true, rows: rows.map(encodeRow) };
      } catch (err) {
        return { id, ok: false, error: { code: "sql-error", message: String(err) } };
      }
    case "read-file":
      // The real reader confines this to the container subtree; so does this.
      try {
        return { id, ok: true, b64: readFileSync(req.path).toString("base64") };
      } catch (err) {
        return { id, ok: false, error: { code: "not-found", message: String(err) } };
      }
    default:
      return { id, ok: false, error: { code: "bad-request", message: `unknown verb ${req.verb}` } };
  }
}

try {
  unlinkSync(socketPath);
} catch {
  // no stale socket to clear
}

const server = createServer((socket) => {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      let res;
      try {
        res = respond(JSON.parse(line));
      } catch (err) {
        res = { id: null, ok: false, error: { code: "bad-request", message: String(err) } };
      }
      socket.write(`${JSON.stringify(res)}\n`);
    }
  });
  socket.on("error", () => {});
});

server.listen(socketPath, () => {
  console.log(`standin-reader: listening at ${socketPath} over ${dbPath} (pid ${process.pid})`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`standin-reader: ${sig} after serving ${served} request(s)`);
    server.close();
    try {
      unlinkSync(socketPath);
    } catch {
      // already gone
    }
    process.exit(0);
  });
}
