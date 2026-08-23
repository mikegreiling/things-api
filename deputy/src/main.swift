/**
 * things-deputy — the TCC permission broker for the things CLI.
 *
 * A deliberately dumb, launchd-supervised proxy: it executes read-only SQL
 * against the Things database, runs osascript with fixed argument shapes, and
 * reads files inside the Things group container — nothing else. All product
 * logic (validation, guards, verification, audit) stays in the TypeScript
 * library; the deputy exists solely so macOS TCC grants (Automation,
 * Accessibility, group-container reads) attach to ONE stable signed identity
 * instead of whichever agent harness happens to invoke the CLI this week.
 *
 * Security posture (docs/design/agent-daemon.md §β1):
 * - UNIX socket + token file live in a 0700 state dir; socket and token are 0600.
 * - Every connection is peer-checked (same-UID) and every request carries the token.
 * - SQL runs on a SQLITE_OPEN_READONLY connection with ATTACH denied by an
 *   authorizer — the connection cannot write and cannot reach other files.
 * - osascript is invoked at a fixed absolute path with exactly two argv shapes
 *   (`-e <script>` / `-l JavaScript -e <script>`); the client never supplies argv.
 * - File reads are confined to the resolved Things group container subtree.
 * - Every request lands in a local JSONL audit log (hashes, never content).
 *
 * The deputy never daemonizes itself: launchd (or a test harness) owns the
 * process lifecycle. There is exactly one run mode — foreground.
 */
import Foundation

let PROTOCOL_VERSION = 1
let MAX_REQUEST_BYTES = 8 * 1024 * 1024
let MAX_FILE_READ_BYTES = 64 * 1024 * 1024

struct DeputyPaths {
  let stateDir: String
  var socket: String { stateDir + "/deputy.sock" }
  var token: String { stateDir + "/token" }
  var log: String { stateDir + "/deputy.log" }
  var config: String { stateDir + "/deputy.json" }
}

/// Deputy-local overrides, read once at startup from `<state-dir>/deputy.json`.
/// The state dir is 0700, so anything able to write this file already owns the
/// user account; the overrides exist for tests and non-standard installs.
struct DeputyConfig {
  var osascriptPath: String?
  var shortcutsPath: String?

  static func load(path: String) -> DeputyConfig {
    var cfg = DeputyConfig()
    guard let data = FileManager.default.contents(atPath: path),
      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return cfg }
    cfg.osascriptPath = obj["osascriptPath"] as? String
    cfg.shortcutsPath = obj["shortcutsPath"] as? String
    return cfg
  }
}

func defaultStateDir() -> String {
  let env = ProcessInfo.processInfo.environment
  if let explicit = env["THINGS_API_STATE_DIR"], !explicit.isEmpty {
    return explicit + "/deputy"
  }
  let base =
    (env["XDG_STATE_HOME"]).flatMap { $0.isEmpty ? nil : $0 }
    ?? NSHomeDirectory() + "/.local/state"
  return base + "/things-api/deputy"
}

func loadOrCreateToken(path: String) -> String {
  if let data = FileManager.default.contents(atPath: path) {
    let tok = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    if !tok.isEmpty { return tok }
  }
  var bytes = [UInt8](repeating: 0, count: 32)
  for i in 0..<bytes.count { bytes[i] = UInt8.random(in: 0...255) }
  let tok = bytes.map { String(format: "%02x", $0) }.joined()
  FileManager.default.createFile(
    atPath: path, contents: Data(tok.utf8), attributes: [.posixPermissions: 0o600])
  return tok
}

// --- entry ---

var stateDirArg: String? = nil
var argIter = CommandLine.arguments.dropFirst().makeIterator()
while let arg = argIter.next() {
  switch arg {
  case "--state-dir":
    stateDirArg = argIter.next()
  case "--version":
    print(DEPUTY_VERSION)
    exit(0)
  default:
    FileHandle.standardError.write(Data("things-deputy: unknown argument \(arg)\n".utf8))
    exit(2)
  }
}

let paths = DeputyPaths(stateDir: stateDirArg ?? defaultStateDir())
do {
  try FileManager.default.createDirectory(
    atPath: paths.stateDir, withIntermediateDirectories: true,
    attributes: [.posixPermissions: 0o700])
} catch {
  FileHandle.standardError.write(
    Data("things-deputy: cannot create state dir \(paths.stateDir): \(error)\n".utf8))
  exit(1)
}

let config = DeputyConfig.load(path: paths.config)
let token = loadOrCreateToken(path: paths.token)
let server = Server(paths: paths, config: config, token: token)

signal(SIGPIPE, SIG_IGN)
signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
let intSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
for source in [termSource, intSource] {
  source.setEventHandler {
    // Graceful drain: stop accepting, let in-flight requests finish (bounded),
    // then remove the socket and exit cleanly. An upgrade boots the old
    // process out mid-flight, and a request in progress must not die with it.
    server.drainAndShutdown()
    exit(0)
  }
  source.resume()
}

// The accept loop runs on a background thread; the MAIN thread must sit in
// dispatchMain() so the signal sources above (queued on .main) actually fire —
// a main thread blocked in accept() would ignore SIGTERM forever.
Thread.detachNewThread { server.run() }
dispatchMain()
