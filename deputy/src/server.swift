/**
 * Socket server: accept loop, peer verification, JSON-lines framing, request
 * dispatch, and the local JSONL audit log. One thread per connection; SQL and
 * osascript execution are each funneled through their own serial queue so a
 * long GUI drive never blocks a verification read and vice versa.
 */
import Foundation

final class Server {
  let paths: DeputyPaths
  let config: DeputyConfig
  let token: String
  let startedAt = Date()
  private let dbQueue = DispatchQueue(label: "things-deputy.db")
  private let osaQueue = DispatchQueue(label: "things-deputy.osa")
  private let logQueue = DispatchQueue(label: "things-deputy.log")
  private var reader: SqliteReader?  // guarded by dbQueue
  private var listenFd: Int32 = -1

  init(paths: DeputyPaths, config: DeputyConfig, token: String) {
    self.paths = paths
    self.config = config
    self.token = token
  }

  func run() {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { fatalDie("socket() failed: errno \(errno)") }
    listenFd = fd

    let sockPath = paths.socket
    guard sockPath.utf8.count <= 103 else {
      fatalDie("socket path too long for sockaddr_un (\(sockPath.utf8.count) bytes): \(sockPath)")
    }
    unlink(sockPath)
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let pathCapacity = MemoryLayout.size(ofValue: addr.sun_path)
    _ = withUnsafeMutablePointer(to: &addr.sun_path) { pathPtr in
      sockPath.withCString { cstr in
        strncpy(
          UnsafeMutableRawPointer(pathPtr).assumingMemoryBound(to: CChar.self), cstr,
          pathCapacity - 1)
      }
    }
    let bindResult = withUnsafePointer(to: &addr) { ptr in
      ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
        bind(fd, sa, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    guard bindResult == 0 else { fatalDie("bind(\(sockPath)) failed: errno \(errno)") }
    chmod(sockPath, 0o600)
    guard listen(fd, 16) == 0 else { fatalDie("listen() failed: errno \(errno)") }

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
        audit(["event": "rejected-peer", "uid": Int(uid)])
        close(conn)
        continue
      }
      let thread = Thread { [weak self] in self?.handleConnection(conn) }
      thread.name = "things-deputy.conn"
      thread.start()
    }
  }

  func shutdown() {
    if listenFd >= 0 { close(listenFd) }
    unlink(paths.socket)
    audit(["event": "stopped"])
  }

  private func fatalDie(_ message: String) -> Never {
    FileHandle.standardError.write(Data("things-deputy: \(message)\n".utf8))
    exit(1)
  }

  // --- connection handling ---

  private func handleConnection(_ conn: Int32) {
    defer { close(conn) }
    var peerPid: pid_t = 0
    var pidLen = socklen_t(MemoryLayout<pid_t>.size)
    _ = getsockopt(conn, SOL_LOCAL, LOCAL_PEERPID, &peerPid, &pidLen)

    var buffer = Data()
    var chunk = [UInt8](repeating: 0, count: 65536)
    while true {
      let n = read(conn, &chunk, chunk.count)
      if n <= 0 { return }
      buffer.append(contentsOf: chunk[0..<n])
      if buffer.count > MAX_REQUEST_BYTES {
        writeLine(conn, errorResponse(id: nil, code: "too-large", message: "request exceeds \(MAX_REQUEST_BYTES) bytes"))
        return
      }
      while let nl = buffer.firstIndex(of: 0x0A) {
        let line = buffer.subdata(in: buffer.startIndex..<nl)
        buffer.removeSubrange(buffer.startIndex...nl)
        let response = dispatch(line: line, peerPid: peerPid)
        if !writeLine(conn, response) { return }
      }
    }
  }

  @discardableResult
  private func writeLine(_ conn: Int32, _ obj: [String: Any]) -> Bool {
    guard var data = try? JSONSerialization.data(withJSONObject: obj) else { return false }
    data.append(0x0A)
    return data.withUnsafeBytes { raw in
      var offset = 0
      while offset < raw.count {
        let n = write(conn, raw.baseAddress!.advanced(by: offset), raw.count - offset)
        if n <= 0 { return false }
        offset += n
      }
      return true
    }
  }

  private func errorResponse(id: Any?, code: String, message: String) -> [String: Any] {
    ["id": id ?? NSNull(), "ok": false, "error": ["code": code, "message": message]]
  }

  // --- dispatch ---

  private func dispatch(line: Data, peerPid: pid_t) -> [String: Any] {
    guard let obj = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else {
      return errorResponse(id: nil, code: "bad-request", message: "request is not a JSON object")
    }
    let id = obj["id"]
    guard let v = obj["v"] as? Int, v == PROTOCOL_VERSION else {
      return errorResponse(
        id: id, code: "unsupported-protocol",
        message: "deputy speaks protocol \(PROTOCOL_VERSION); restart or rebuild the deputy (things deputy restart)")
    }
    guard let reqToken = obj["token"] as? String, reqToken == token else {
      audit(["event": "rejected-token", "peerPid": Int(peerPid)])
      return errorResponse(id: id, code: "bad-token", message: "request token does not match the deputy token file")
    }
    guard let verb = obj["verb"] as? String else {
      return errorResponse(id: id, code: "bad-request", message: "missing verb")
    }

    let started = Date()
    var result: [String: Any]
    var auditExtra: [String: Any] = [:]
    switch verb {
    case "hello":
      result = handleHello(id: id)
    case "locate":
      result = handleLocate(id: id)
    case "sql":
      guard let sql = obj["sql"] as? String else {
        result = errorResponse(id: id, code: "bad-request", message: "sql verb requires a sql string")
        break
      }
      let params = obj["params"] as? [Any] ?? []
      auditExtra["sqlSha256"] = sha256Hex(sql)
      result = dbQueue.sync { handleSql(id: id, sql: sql, params: params) }
    case "osascript":
      guard let script = obj["script"] as? String else {
        result = errorResponse(id: id, code: "bad-request", message: "osascript verb requires a script string")
        break
      }
      let lang = obj["lang"] as? String ?? "applescript"
      guard lang == "applescript" || lang == "javascript" else {
        result = errorResponse(id: id, code: "bad-request", message: "lang must be applescript or javascript")
        break
      }
      let timeoutMs = obj["timeoutMs"] as? Int ?? 30_000
      if let guardError = scriptGuard(script) {
        audit(["event": "rejected-script", "reason": guardError, "peerPid": Int(peerPid)])
        result = errorResponse(id: id, code: "script-denied", message: guardError)
        break
      }
      auditExtra["scriptSha256"] = sha256Hex(script)
      auditExtra["scriptBytes"] = script.utf8.count
      result = osaQueue.sync {
        runOsascript(
          script: script, lang: lang, timeoutMs: timeoutMs,
          binPath: config.osascriptPath ?? "/usr/bin/osascript", id: id)
      }
    case "shortcuts":
      let op = obj["op"] as? String
      let timeoutMs = obj["timeoutMs"] as? Int ?? 30_000
      let bin = config.shortcutsPath ?? "/usr/bin/shortcuts"
      if op == "list" {
        result = osaQueue.sync { runChildTool(binPath: bin, args: ["list"], timeoutMs: timeoutMs, id: id) }
        break
      }
      guard op == "run", let name = obj["name"] as? String,
        let inputPath = obj["inputPath"] as? String,
        let outputPath = obj["outputPath"] as? String
      else {
        result = errorResponse(
          id: id, code: "bad-request",
          message: "shortcuts verb requires op=list, or op=run with name/inputPath/outputPath")
        break
      }
      // The deputy only runs this library's bundled proxy shortcuts — it is a
      // paired tool, not a general shortcut runner. (Same spirit as the
      // osascript shell-execution lint: a same-user process could run
      // arbitrary shortcuts itself; it just cannot do so AS the deputy.)
      guard name.hasPrefix("things-proxy-"), !inputPath.hasPrefix("-"), !outputPath.hasPrefix("-")
      else {
        audit(["event": "rejected-shortcut", "name": name, "peerPid": Int(peerPid)])
        result = errorResponse(
          id: id, code: "shortcut-denied",
          message: "the deputy only runs bundled things-proxy-* shortcuts")
        break
      }
      auditExtra["shortcut"] = name
      result = osaQueue.sync {
        runChildTool(
          binPath: bin,
          args: ["run", name, "--input-path", inputPath, "--output-path", outputPath],
          timeoutMs: timeoutMs, id: id)
      }
    case "read-file":
      guard let path = obj["path"] as? String else {
        result = errorResponse(id: id, code: "bad-request", message: "read-file verb requires a path string")
        break
      }
      auditExtra["path"] = path
      result = handleReadFile(id: id, path: path)
    default:
      result = errorResponse(id: id, code: "bad-request", message: "unknown verb \(verb)")
    }

    var entry: [String: Any] = [
      "ts": iso8601(Date()),
      "verb": verb,
      "peerPid": Int(peerPid),
      "ok": (result["ok"] as? Bool) ?? false,
      "ms": Int(Date().timeIntervalSince(started) * 1000),
    ]
    for (k, v) in auditExtra { entry[k] = v }
    audit(entry)
    return result
  }

  /**
   * Defense-in-depth lint, not a security boundary (a same-user process that
   * can read the token can also run osascript itself — what the deputy adds is
   * only its OWN TCC grants). The lint refuses the constructs that would turn
   * "drive the Things GUI" into "run arbitrary shell": every legitimate script
   * this library generates talks AppleScript/JXA to Things and System Events
   * and never shells out.
   */
  private func scriptGuard(_ script: String) -> String? {
    let lowered = script.lowercased()
    for banned in ["do shell script", "do script"] {
      if lowered.contains(banned) {
        return "script rejected: contains \"\(banned)\" — the deputy only brokers GUI/AppleEvent scripts, never shell execution"
      }
    }
    return nil
  }

  // --- verb handlers ---

  private func handleHello(id: Any?) -> [String: Any] {
    [
      "id": id ?? NSNull(),
      "ok": true,
      "protocol": PROTOCOL_VERSION,
      "deputyVersion": DEPUTY_VERSION,
      "pid": Int(getpid()),
      "dbPath": resolveDbPath() ?? NSNull(),
      "uptimeMs": Int(Date().timeIntervalSince(startedAt) * 1000),
    ]
  }

  private func handleLocate(id: Any?) -> [String: Any] {
    let candidates = locateCandidates()
    guard let first = candidates.first else {
      return errorResponse(
        id: id, code: "not-found",
        message: "Things database not found under the group container (searched \(containerGlobRoot()))")
    }
    return [
      "id": id ?? NSNull(), "ok": true, "path": first,
      "otherCandidates": Array(candidates.dropFirst()),
    ]
  }

  private func handleSql(id: Any?, sql: String, params: [Any]) -> [String: Any] {
    if reader == nil {
      guard let dbPath = resolveDbPath() else {
        return errorResponse(id: id, code: "not-found", message: "no Things database to query (locate failed and no dbPath configured)")
      }
      do {
        reader = try SqliteReader(path: dbPath)
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
    guard let root = containerRoot() else {
      return errorResponse(id: id, code: "read-denied", message: "no container root resolved; cannot authorize file reads")
    }
    let canonical = URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path
    let canonicalRoot = URL(fileURLWithPath: root).resolvingSymlinksInPath().standardizedFileURL.path
    guard canonical == canonicalRoot || canonical.hasPrefix(canonicalRoot + "/") else {
      return errorResponse(
        id: id, code: "read-denied",
        message: "path is outside the Things container (\(canonicalRoot)); the deputy only reads inside it")
    }
    guard let data = FileManager.default.contents(atPath: canonical) else {
      return errorResponse(id: id, code: "not-found", message: "cannot read \(canonical)")
    }
    guard data.count <= MAX_FILE_READ_BYTES else {
      return errorResponse(id: id, code: "too-large", message: "file exceeds \(MAX_FILE_READ_BYTES) bytes")
    }
    return ["id": id ?? NSNull(), "ok": true, "b64": data.base64EncodedString()]
  }

  // --- path resolution ---

  private func homeDir() -> String {
    config.home ?? NSHomeDirectory()
  }

  private func containerGlobRoot() -> String {
    homeDir() + "/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac"
  }

  /// Mirror of the library's locate precedence for the container case: every
  /// ThingsData-*/Things Database.thingsdatabase/main.sqlite, most recently
  /// modified first. A configured dbPath short-circuits (tests, odd installs).
  private func locateCandidates() -> [String] {
    if let explicit = config.dbPath { return [explicit] }
    let root = containerGlobRoot()
    let fm = FileManager.default
    guard let entries = try? fm.contentsOfDirectory(atPath: root) else { return [] }
    var found: [(String, Date)] = []
    for entry in entries where entry.hasPrefix("ThingsData-") {
      let dbPath = root + "/" + entry + "/Things Database.thingsdatabase/main.sqlite"
      if let attrs = try? fm.attributesOfItem(atPath: dbPath),
        let mtime = attrs[.modificationDate] as? Date {
        found.append((dbPath, mtime))
      }
    }
    return found.sorted { $0.1 > $1.1 }.map { $0.0 }
  }

  private func resolveDbPath() -> String? {
    locateCandidates().first
  }

  /// The subtree file reads are confined to. With a configured dbPath (tests)
  /// this is the dbPath's great-grandparent — the same shape the library uses
  /// for the group root (sync-health's dirname^3).
  private func containerRoot() -> String? {
    if let explicit = config.dbPath {
      return URL(fileURLWithPath: explicit)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .path
    }
    return containerGlobRoot()
  }

  // --- audit log ---

  private func audit(_ entry: [String: Any]) {
    var withTs = entry
    if withTs["ts"] == nil { withTs["ts"] = iso8601(Date()) }
    guard var data = try? JSONSerialization.data(withJSONObject: withTs) else { return }
    data.append(0x0A)
    let path = paths.log
    logQueue.async {
      if let handle = FileHandle(forWritingAtPath: path) {
        handle.seekToEndOfFile()
        handle.write(data)
        try? handle.close()
      } else {
        FileManager.default.createFile(
          atPath: path, contents: data, attributes: [.posixPermissions: 0o600])
      }
    }
  }
}

func iso8601(_ date: Date) -> String {
  ISO8601DateFormatter().string(from: date)
}
