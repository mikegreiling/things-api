/**
 * Socket server: accept loop, peer verification, JSON-lines framing, request
 * dispatch, and the local JSONL audit log. One thread per connection;
 * osascript/shortcuts execution is funneled through one serial queue.
 *
 * MUTATIONS ONLY: the deputy serves the automation verbs (osascript,
 * shortcuts). File verbs (sql / read-file / locate) live exclusively on the
 * sandboxed things-reader — the deputy's own container access would ride the
 * per-process AppData consent class (a prompt per process instance, measured
 * 2026-08-21), which is precisely the churn this pair exists to end.
 */
import Foundation

/// How long a shutting-down deputy waits for requests already in flight. An
/// upgrade (`things helpers install` / `restart`) boots the old process out
/// mid-flight; without a drain the in-flight request dies with it. launchd's
/// own bootout wait, and the CLI's `launchctl` timeout, both clear this bound.
let DRAIN_TIMEOUT_SECONDS: TimeInterval = 10

final class Server {
  let paths: DeputyPaths
  let config: DeputyConfig
  let token: String
  let startedAt = Date()
  private let osaQueue = DispatchQueue(label: "things-deputy.osa")
  private let logQueue = DispatchQueue(label: "things-deputy.log")
  private var listenFd: Int32 = -1
  /// Requests between dispatch and their written response. Guarded by
  /// `inflightCond`, which the drain waits on.
  private let inflightCond = NSCondition()
  private var inflight = 0

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

  /**
   * Graceful drain, then teardown. Order matters:
   *
   * 1. unlink the socket path FIRST — a new client cannot even find us, which
   *    is deterministic where waking a thread blocked in accept() is not.
   * 2. close the listener so no further connection is accepted.
   * 3. wait (bounded) for requests already dispatched to write their response.
   * 4. flush the audit log and return; the caller exits 0.
   *
   * SIGKILL remains the hard stop — nothing here tries to survive it.
   */
  func drainAndShutdown(timeout: TimeInterval = DRAIN_TIMEOUT_SECONDS) {
    unlink(paths.socket)
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
    // The audit log is written asynchronously; a barrier makes "stopped" the
    // last thing on disk instead of a line lost to exit().
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
        // In flight from dispatch until the response is on the wire — that
        // span is exactly what a drain must not cut short.
        beginRequest()
        let response = dispatch(line: line, peerPid: peerPid)
        let written = writeLine(conn, response)
        endRequest()
        if !written { return }
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
        message: "deputy speaks protocol \(PROTOCOL_VERSION); restart or rebuild the deputy (things helpers restart)")
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
    case "prime-ax":
      result = handlePrimeAx(id: id)
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
    case "sql", "read-file", "locate":
      // File verbs live exclusively on the sandboxed things-reader.
      result = errorResponse(
        id: id, code: "unsupported-verb",
        message: "the deputy serves automation verbs only — file access rides things-reader (things helpers grant)")
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

  /**
   * The handshake, plus the deputy's own TCC standing — Accessibility trust
   * and Automation permission for each target it drives. Every field here is
   * PROMPT-FREE by construction (see tcc.swift), which is what lets a status
   * report and the onboarding ceremony ask "is this leg already granted?"
   * without raising a dialog at whoever happens to run `things` next.
   */
  private func handleHello(id: Any?) -> [String: Any] {
    [
      "id": id ?? NSNull(),
      "ok": true,
      "protocol": PROTOCOL_VERSION,
      "deputyVersion": DEPUTY_VERSION,
      "role": "deputy",
      "pid": Int(getpid()),
      "uptimeMs": Int(Date().timeIntervalSince(startedAt) * 1000),
      "axTrusted": accessibilityTrusted(),
      "automation": [
        "things": automationStatus(bundleID: "com.culturedcode.ThingsMac"),
        "systemEvents": automationStatus(bundleID: "com.apple.systemevents"),
      ],
    ]
  }

  /**
   * Raise the Accessibility consent dialog for the deputy's own identity. The
   * grant itself is a toggle in System Settings, so the answer can only arrive
   * later — the caller polls `hello`'s axTrusted. Returns the state as of now.
   */
  private func handlePrimeAx(id: Any?) -> [String: Any] {
    ["id": id ?? NSNull(), "ok": true, "axTrusted": primeAccessibility()]
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
