/**
 * TCCDUR1 probe app — a Developer-ID-signed, LSUIElement .app whose OWN code
 * performs a real SQLite content read of the Things group container.
 *
 * It exists for exactly one measurement: APDP1 measured the
 * `kTCCServiceSystemPolicyAppData` grant as RESPONSIBLE-APP-INSTANCE-pinned
 * with an APPLE-PLATFORM-signed responsible app (Terminal.app); the field
 * observation that contradicts it had a DEVELOPER-ID-signed third-party app at
 * the top of the chain. This bundle is the signing-class discriminator: same
 * OS, same golden, same container file, same provocation — only the
 * responsible app's signing class and bundle identity differ.
 *
 * Protocol (file-driven, so the host can drive it over ssh without any
 * Automation grant and without a socket the OS would itself gate):
 *
 *   <dir>/dbpath.txt        the concrete container DB path (globbing the
 *                           container is itself a gated operation — APDP1)
 *   <dir>/go-<label>        touch to request cell <label>
 *   <dir>/<label>.start     written BEFORE the blocking call (pid, ppid)
 *   <dir>/<label>.json      written after it returns (ok/errno/elapsed)
 *   <dir>/go-quit           touch for an ORDINARY quit (exit 0)
 *   <dir>/launches.log      one line per process launch (pid, ppid, ts)
 *
 * A label beginning with `child` runs the read in a spawned child process
 * instead of in-process, which reproduces APDP1's shape (the requester is not
 * the app's own code) under this bundle's identity.
 */
import Foundation
import SQLite3

let args = CommandLine.arguments
var dir = "/Users/admin/labh/tccdur1"
var i = 1
while i < args.count {
  if args[i] == "--dir", i + 1 < args.count {
    dir = args[i + 1]
    i += 2
  } else {
    i += 1
  }
}

let fm = FileManager.default
func path(_ name: String) -> String { dir + "/" + name }
func write(_ name: String, _ text: String) {
  try? text.write(toFile: path(name), atomically: true, encoding: .utf8)
}
func append(_ name: String, _ text: String) {
  let p = path(name)
  if !fm.fileExists(atPath: p) { fm.createFile(atPath: p, contents: nil) }
  if let h = FileHandle(forWritingAtPath: p) {
    h.seekToEndOfFile()
    h.write(Data(text.utf8))
    try? h.close()
  }
}
func json(_ obj: [String: Any]) -> String {
  guard let d = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) else {
    return "{}"
  }
  return String(decoding: d, as: UTF8.self)
}

try? fm.createDirectory(atPath: dir, withIntermediateDirectories: true)

let me = ProcessInfo.processInfo.processIdentifier
let parent = getppid()
append(
  "launches.log",
  json([
    "event": "launch", "pid": Int(me), "ppid": Int(parent),
    "ts": Int(Date().timeIntervalSince1970),
    "bundleId": Bundle.main.bundleIdentifier ?? "(none)",
    "executable": Bundle.main.executablePath ?? "(none)",
  ]) + "\n")
write("app.pid", "\(me)\n")

/// One real SQLite content read: open READONLY (the open(2) TCC gates) and
/// then `PRAGMA schema_version`, which forces page 1 off disk. A metadata stat
/// does not prompt; this does.
func sqliteRead(_ dbPath: String) -> [String: Any] {
  var out: [String: Any] = [:]
  var h: OpaquePointer?
  let rc = sqlite3_open_v2(dbPath, &h, SQLITE_OPEN_READONLY, nil)
  guard rc == SQLITE_OK, let db = h else {
    out["ok"] = false
    out["stage"] = "open"
    out["rc"] = Int(rc)
    out["msg"] = h.map { String(cString: sqlite3_errmsg($0)) } ?? "sqlite rc \(rc)"
    sqlite3_close(h)
    return out
  }
  defer { sqlite3_close_v2(db) }
  var stmt: OpaquePointer?
  let prc = sqlite3_prepare_v2(db, "PRAGMA schema_version;", -1, &stmt, nil)
  guard prc == SQLITE_OK, let prepared = stmt else {
    out["ok"] = false
    out["stage"] = "prepare"
    out["rc"] = Int(prc)
    out["msg"] = String(cString: sqlite3_errmsg(db))
    return out
  }
  defer { sqlite3_finalize(prepared) }
  let src = sqlite3_step(prepared)
  guard src == SQLITE_ROW else {
    out["ok"] = false
    out["stage"] = "step"
    out["rc"] = Int(src)
    out["msg"] = String(cString: sqlite3_errmsg(db))
    return out
  }
  out["ok"] = true
  out["stage"] = "row"
  out["schemaVersion"] = Int(sqlite3_column_int64(prepared, 0))
  return out
}

func runChild(_ label: String, _ dbPath: String) -> [String: Any] {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
  p.arguments = [path("tryopen.py"), label, dbPath]
  let pipe = Pipe()
  p.standardOutput = pipe
  p.standardError = pipe
  do { try p.run() } catch {
    return ["ok": false, "stage": "spawn", "msg": "\(error)"]
  }
  let data = pipe.fileHandleForReading.readDataToEndOfFile()
  p.waitUntilExit()
  return [
    "ok": p.terminationStatus == 0, "stage": "child",
    "childExit": Int(p.terminationStatus), "childPid": Int(p.processIdentifier),
    "childOut": String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines),
  ]
}

func cell(_ label: String) {
  let dbPath =
    (try? String(contentsOfFile: path("dbpath.txt"), encoding: .utf8))?
    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  write(
    "\(label).start",
    json([
      "label": label, "pid": Int(me), "ppid": Int(getppid()),
      "ts": Int(Date().timeIntervalSince1970), "db": dbPath,
    ]) + "\n")
  let t0 = Date()
  var rec: [String: Any] = label.contains("child")
    ? runChild(label, dbPath) : sqliteRead(dbPath)
  rec["label"] = label
  rec["pid"] = Int(me)
  rec["elapsedSec"] = (Date().timeIntervalSince(t0) * 1000).rounded() / 1000
  write("\(label).json", json(rec) + "\n")
}

while true {
  if fm.fileExists(atPath: path("go-quit")) {
    try? fm.removeItem(atPath: path("go-quit"))
    append(
      "launches.log",
      json(["event": "quit", "pid": Int(me), "ts": Int(Date().timeIntervalSince1970)]) + "\n")
    exit(0)
  }
  if let entries = try? fm.contentsOfDirectory(atPath: dir) {
    for e in entries.sorted() where e.hasPrefix("go-") && e != "go-quit" {
      let label = String(e.dropFirst(3))
      if fm.fileExists(atPath: path("\(label).json")) { continue }
      cell(label)
      try? fm.removeItem(atPath: path(e))
    }
  }
  Thread.sleep(forTimeInterval: 0.25)
}
