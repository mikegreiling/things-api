/**
 * things-reader — the sandboxed file half of the deputy pair.
 *
 * Serves the wire protocol's FILE verbs only (hello / sql / read-file /
 * locate) from inside the App Sandbox, reaching the Things group container
 * exclusively through a user-granted security-scoped bookmark. The scope is
 * enforced by the OS: without the bookmark the sandbox denies the container
 * outright, and nothing in this process can read outside the granted
 * directory (plus its own container home). The unsandboxed things-deputy
 * keeps the automation verbs (osascript / shortcuts).
 *
 * Why this exists (SANDBOX1, docs/lab/sandbox1-scoped-reader.md): the
 * kTCCServiceSystemPolicyAppData class issues allow-once-per-process grants —
 * unusable headlessly — and the only unsandboxed durable alternative is Full
 * Disk Access. A powerbox-granted bookmark is durable across processes,
 * reboots, and rebuilds under the same signing identity, and is scoped to
 * exactly one directory.
 *
 * Ships as a minimal .app bundle (secinit refuses bare executables) signed
 * with a real certificate chain (amfid refuses ad-hoc on sandboxed code).
 * State (bookmark, token, socket, log) lives in the sandbox container home.
 *
 * Modes:
 *   --grant <startDir>   present the NSOpenPanel ceremony, save the bookmark
 *   --serve              serve the socket (launchd mode; default)
 *   --version            print the version
 */
import AppKit
import Foundation

setvbuf(stdout, nil, _IONBF, 0)

let READER_PROTOCOL_VERSION = 1
let MAX_LINE_BYTES = 8 * 1024 * 1024
let MAX_FILE_READ_BYTES = 64 * 1024 * 1024

// Sandboxed home == the container Data dir — the durable private store.
let home = NSHomeDirectory()
let bookmarkFile = home + "/things-reader.bookmark"
let socketPath = home + "/reader.sock"
let tokenFile = home + "/token"
let logFile = home + "/reader.log"

func stderrLine(_ message: String) {
  FileHandle.standardError.write(Data("things-reader: \(message)\n".utf8))
}

// --- grant ceremony ---

func runGrant(startDir: String) -> Never {
  let app = NSApplication.shared
  app.setActivationPolicy(.regular)
  let panel = NSOpenPanel()
  panel.canChooseDirectories = true
  panel.canChooseFiles = false
  panel.allowsMultipleSelection = false
  // The CLI passes the Things data folder itself when it exists, so the panel
  // opens INSIDE it and the accept button (which returns the displayed
  // directory when nothing is selected) is the only click needed.
  panel.directoryURL = URL(fileURLWithPath: startDir)
  panel.message =
    "Click \u{201C}Grant read access\u{201D} to give things-reader read-only access to this folder — your Things data."
  panel.prompt = "Grant read access"
  app.activate(ignoringOtherApps: true)
  guard panel.runModal() == .OK, let url = panel.url else {
    print("GRANT-CANCELED")
    exit(1)
  }
  do {
    let bookmark = try url.bookmarkData(
      options: [.withSecurityScope], includingResourceValuesForKeys: nil, relativeTo: nil)
    try bookmark.write(to: URL(fileURLWithPath: bookmarkFile))
    print("GRANT-OK \(url.path)")
    exit(0)
  } catch {
    print("GRANT-FAILED \(error.localizedDescription)")
    exit(1)
  }
}

// --- scope resolution (re-checked per request so a fresh grant — or a
// corrective RE-grant after selecting the wrong folder — needs no restart) ---

final class Scope {
  private let lock = NSLock()
  private var url: URL?
  private var bookmarkBytes: Data?

  /// Resolve the security scope from the bookmark file, re-resolving whenever
  /// the file's bytes change (a re-grant replaces them). nil = no grant.
  func current() -> URL? {
    lock.lock()
    defer { lock.unlock() }
    guard let data = FileManager.default.contents(atPath: bookmarkFile) else {
      if let old = url {
        old.stopAccessingSecurityScopedResource()
        url = nil
        bookmarkBytes = nil
      }
      return nil
    }
    if data == bookmarkBytes { return url }
    var stale = false
    guard
      let resolved = try? URL(
        resolvingBookmarkData: data, options: [.withSecurityScope],
        relativeTo: nil, bookmarkDataIsStale: &stale),
      resolved.startAccessingSecurityScopedResource()
    else { return url }
    if let old = url { old.stopAccessingSecurityScopedResource() }
    var current = data
    if stale,
      let fresh = try? resolved.bookmarkData(
        options: [.withSecurityScope], includingResourceValuesForKeys: nil, relativeTo: nil)
    {
      try? fresh.write(to: URL(fileURLWithPath: bookmarkFile))
      current = fresh
    }
    url = resolved
    bookmarkBytes = current
    return resolved
  }
}

let scope = Scope()

// --- server (file verbs only) ---

func loadOrCreateToken() -> String {
  if let data = FileManager.default.contents(atPath: tokenFile) {
    let tok = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    if !tok.isEmpty { return tok }
  }
  var bytes = [UInt8](repeating: 0, count: 32)
  for i in 0..<bytes.count { bytes[i] = UInt8.random(in: 0...255) }
  let tok = bytes.map { String(format: "%02x", $0) }.joined()
  FileManager.default.createFile(
    atPath: tokenFile, contents: Data(tok.utf8), attributes: [.posixPermissions: 0o600])
  return tok
}

/// How long a shutting-down reader waits for requests already in flight (the
/// deputy's DRAIN_TIMEOUT_SECONDS; the two halves are booted out together).
let READER_DRAIN_TIMEOUT_SECONDS: TimeInterval = 10

final class ReaderServer {
  let token: String
  let startedAt = Date()
  private let dbQueue = DispatchQueue(label: "things-reader.db")
  private let logQueue = DispatchQueue(label: "things-reader.log")
  private var listenFd: Int32 = -1
  /// Requests between dispatch and their written response; the drain waits on it.
  private let inflightCond = NSCondition()
  private var inflight = 0
  private var reader: SqliteReader?  // guarded by dbQueue
  private var readerRoot: String?  // scope the open handle belongs to; guarded by dbQueue
  private let cacheLock = NSLock()
  private var cachedDbPath: String?

  init(token: String) {
    self.token = token
  }

  private func readCachedDbPath() -> String? {
    cacheLock.lock()
    defer { cacheLock.unlock() }
    return cachedDbPath
  }

  private func storeCachedDbPath(_ path: String) {
    cacheLock.lock()
    cachedDbPath = path
    cacheLock.unlock()
  }

  func run() {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { fatalDie("socket() errno \(errno)") }
    listenFd = fd
    unlink(socketPath)
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let capacity = MemoryLayout.size(ofValue: addr.sun_path)
    guard socketPath.utf8.count < capacity else { fatalDie("socket path too long: \(socketPath)") }
    _ = withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
      socketPath.withCString { cstr in
        strncpy(UnsafeMutableRawPointer(ptr).assumingMemoryBound(to: CChar.self), cstr, capacity - 1)
      }
    }
    let bound = withUnsafePointer(to: &addr) { ptr in
      ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
        bind(fd, sa, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    guard bound == 0 else { fatalDie("bind(\(socketPath)) errno \(errno)") }
    chmod(socketPath, 0o600)
    guard listen(fd, 16) == 0 else { fatalDie("listen() errno \(errno)") }
    audit(["event": "started", "pid": Int(getpid()), "version": DEPUTY_VERSION])
    while true {
      let conn = accept(fd, nil, nil)
      if conn < 0 {
        if errno == EINTR { continue }
        break
      }
      var uid: uid_t = 0
      var gid: gid_t = 0
      if getpeereid(conn, &uid, &gid) != 0 || uid != getuid() {
        close(conn)
        continue
      }
      let thread = Thread { [weak self] in self?.handleConnection(conn) }
      thread.name = "things-reader.conn"
      thread.start()
    }
  }

  private func fatalDie(_ message: String) -> Never {
    stderrLine(message)
    exit(1)
  }

  /**
   * Graceful drain, then teardown (mirrors the deputy): remove the socket path
   * so no new client can find us, close the listener, wait out the in-flight
   * requests within a bound, flush the log. SIGKILL is still the hard stop.
   */
  func drainAndShutdown(timeout: TimeInterval = READER_DRAIN_TIMEOUT_SECONDS) {
    unlink(socketPath)
    if listenFd >= 0 {
      Darwin.shutdown(listenFd, SHUT_RDWR)
      close(listenFd)
      listenFd = -1
    }
    let deadline = Date().addingTimeInterval(timeout)
    inflightCond.lock()
    while inflight > 0 && Date() < deadline {
      _ = inflightCond.wait(until: deadline)
    }
    let remaining = inflight
    inflightCond.unlock()
    audit(["event": "stopped", "drained": remaining == 0, "inflight": remaining])
    logQueue.sync {}
  }

  private func beginRequest() {
    inflightCond.lock()
    inflight += 1
    inflightCond.unlock()
  }

  private func endRequest() {
    inflightCond.lock()
    inflight -= 1
    if inflight == 0 { inflightCond.broadcast() }
    inflightCond.unlock()
  }

  private func handleConnection(_ conn: Int32) {
    defer { close(conn) }
    var buffer = Data()
    var chunk = [UInt8](repeating: 0, count: 65536)
    while true {
      let n = read(conn, &chunk, chunk.count)
      if n <= 0 { return }
      buffer.append(contentsOf: chunk[0..<n])
      if buffer.count > MAX_LINE_BYTES { return }
      while let nl = buffer.firstIndex(of: 0x0A) {
        let line = buffer.subdata(in: buffer.startIndex..<nl)
        buffer.removeSubrange(buffer.startIndex...nl)
        // In flight from dispatch until the response is on the wire.
        beginRequest()
        let response = dispatch(line: line)
        guard var data = try? JSONSerialization.data(withJSONObject: response) else {
          endRequest()
          return
        }
        data.append(0x0A)
        let ok = data.withUnsafeBytes { raw -> Bool in
          var offset = 0
          while offset < raw.count {
            let written = write(conn, raw.baseAddress!.advanced(by: offset), raw.count - offset)
            if written <= 0 { return false }
            offset += written
          }
          return true
        }
        endRequest()
        if !ok { return }
      }
    }
  }

  private func errorResponse(id: Any?, code: String, message: String) -> [String: Any] {
    ["id": id ?? NSNull(), "ok": false, "error": ["code": code, "message": message]]
  }

  private func dispatch(line: Data) -> [String: Any] {
    guard let obj = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else {
      return errorResponse(id: nil, code: "bad-request", message: "request is not a JSON object")
    }
    let id = obj["id"]
    guard let v = obj["v"] as? Int, v == READER_PROTOCOL_VERSION else {
      return errorResponse(id: id, code: "unsupported-protocol", message: "reader speaks protocol \(READER_PROTOCOL_VERSION)")
    }
    guard let reqToken = obj["token"] as? String, reqToken == token else {
      return errorResponse(id: id, code: "bad-token", message: "request token does not match the reader token file")
    }
    guard let verb = obj["verb"] as? String else {
      return errorResponse(id: id, code: "bad-request", message: "missing verb")
    }
    let started = Date()
    let result: [String: Any]
    switch verb {
    case "hello":
      result = [
        "id": id ?? NSNull(), "ok": true,
        "protocol": READER_PROTOCOL_VERSION,
        "deputyVersion": DEPUTY_VERSION,
        "role": "reader",
        "pid": Int(getpid()),
        "granted": scope.current() != nil,
        "dbPath": readCachedDbPath() ?? NSNull(),
        "uptimeMs": Int(Date().timeIntervalSince(startedAt) * 1000),
      ]
    case "locate":
      result = handleLocate(id: id)
    case "sql":
      guard let sql = obj["sql"] as? String else {
        result = errorResponse(id: id, code: "bad-request", message: "sql verb requires a sql string")
        break
      }
      let params = obj["params"] as? [Any] ?? []
      result = dbQueue.sync { handleSql(id: id, sql: sql, params: params) }
    case "read-file":
      guard let path = obj["path"] as? String else {
        result = errorResponse(id: id, code: "bad-request", message: "read-file verb requires a path string")
        break
      }
      result = handleReadFile(id: id, path: path)
    default:
      // The automation verbs live on things-deputy — never here, by design.
      result = errorResponse(id: id, code: "unsupported-verb", message: "the reader serves file verbs only (hello/sql/read-file/locate)")
    }
    audit([
      "ts": iso8601Now(), "verb": verb, "ok": (result["ok"] as? Bool) ?? false,
      "ms": Int(Date().timeIntervalSince(started) * 1000),
    ])
    return result
  }

  private func scopedRoot(id: Any?) -> (URL?, [String: Any]?) {
    guard let root = scope.current() else {
      return (
        nil,
        errorResponse(
          id: id, code: "not-granted",
          message: "no security-scoped grant yet — run `things helpers setup` and select the Things data folder")
      )
    }
    return (root, nil)
  }

  private func locateCandidates(root: URL) -> [String] {
    let fm = FileManager.default
    guard let entries = try? fm.contentsOfDirectory(atPath: root.path) else { return [] }
    var found: [(String, Date)] = []
    for entry in entries where entry.hasPrefix("ThingsData-") {
      let dbPath = root.path + "/" + entry + "/Things Database.thingsdatabase/main.sqlite"
      if let attrs = try? fm.attributesOfItem(atPath: dbPath),
        let mtime = attrs[.modificationDate] as? Date
      {
        found.append((dbPath, mtime))
      }
    }
    return found.sorted { $0.1 > $1.1 }.map { $0.0 }
  }

  private func handleLocate(id: Any?) -> [String: Any] {
    let (root, err) = scopedRoot(id: id)
    guard let r = root else { return err! }
    let candidates = locateCandidates(root: r)
    guard let first = candidates.first else {
      return errorResponse(id: id, code: "not-found", message: "Things database not found under the granted folder (\(r.path))")
    }
    storeCachedDbPath(first)
    return ["id": id ?? NSNull(), "ok": true, "path": first, "otherCandidates": Array(candidates.dropFirst())]
  }

  private func handleSql(id: Any?, sql: String, params: [Any]) -> [String: Any] {
    let (root, err) = scopedRoot(id: id)
    guard let r = root else { return err! }
    // A re-grant moves the scope: drop a handle opened under the old root so
    // queries never keep answering from a folder the user has replaced.
    if reader != nil && readerRoot != r.path { reader = nil }
    if reader == nil {
      guard let dbPath = locateCandidates(root: r).first else {
        return errorResponse(id: id, code: "not-found", message: "no Things database under the granted folder")
      }
      do {
        reader = try SqliteReader(path: dbPath)
        readerRoot = r.path
        storeCachedDbPath(dbPath)
      } catch {
        return errorResponse(id: id, code: "sql-error", message: "cannot open \(dbPath) read-only: \(error.localizedDescription)")
      }
    }
    do {
      let rows = try reader!.query(sql: sql, params: params)
      return ["id": id ?? NSNull(), "ok": true, "rows": rows]
    } catch let err as SqliteError {
      return errorResponse(id: id, code: "sql-error", message: err.message)
    } catch {
      return errorResponse(id: id, code: "sql-error", message: error.localizedDescription)
    }
  }

  private func handleReadFile(id: Any?, path: String) -> [String: Any] {
    let (root, err) = scopedRoot(id: id)
    guard let r = root else { return err! }
    let canonical = URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path
    let canonicalRoot = r.resolvingSymlinksInPath().standardizedFileURL.path
    guard canonical == canonicalRoot || canonical.hasPrefix(canonicalRoot + "/") else {
      return errorResponse(id: id, code: "read-denied", message: "path is outside the granted folder (\(canonicalRoot))")
    }
    guard let data = FileManager.default.contents(atPath: canonical) else {
      return errorResponse(id: id, code: "not-found", message: "cannot read \(canonical)")
    }
    guard data.count <= MAX_FILE_READ_BYTES else {
      return errorResponse(id: id, code: "too-large", message: "file exceeds \(MAX_FILE_READ_BYTES) bytes")
    }
    return ["id": id ?? NSNull(), "ok": true, "b64": data.base64EncodedString()]
  }

  private func audit(_ entry: [String: Any]) {
    var withTs = entry
    if withTs["ts"] == nil { withTs["ts"] = iso8601Now() }
    guard var data = try? JSONSerialization.data(withJSONObject: withTs) else { return }
    data.append(0x0A)
    logQueue.async {
      if let handle = FileHandle(forWritingAtPath: logFile) {
        handle.seekToEndOfFile()
        handle.write(data)
        try? handle.close()
      } else {
        FileManager.default.createFile(
          atPath: logFile, contents: data, attributes: [.posixPermissions: 0o600])
      }
    }
  }
}

func iso8601Now() -> String {
  ISO8601DateFormatter().string(from: Date())
}

// --- entry ---

let arguments = CommandLine.arguments
switch arguments.count >= 2 ? arguments[1] : "--serve" {
case "--version":
  print(DEPUTY_VERSION)
  exit(0)
case "--grant":
  guard arguments.count == 3 else {
    stderrLine("usage: things-reader --grant <start-directory>")
    exit(2)
  }
  runGrant(startDir: arguments[2])
case "--serve":
  let server = ReaderServer(token: loadOrCreateToken())
  signal(SIGPIPE, SIG_IGN)
  signal(SIGTERM, SIG_IGN)
  signal(SIGINT, SIG_IGN)
  let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
  let intSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
  for source in [termSource, intSource] {
    source.setEventHandler {
      // Graceful drain: stop accepting, finish in-flight reads within a bound,
      // then remove the socket and exit cleanly (an upgrade boots both halves
      // out mid-flight).
      server.drainAndShutdown()
      exit(0)
    }
    source.resume()
  }
  Thread.detachNewThread { server.run() }
  dispatchMain()
default:
  stderrLine("usage: things-reader --serve | --grant <dir> | --version")
  exit(2)
}
