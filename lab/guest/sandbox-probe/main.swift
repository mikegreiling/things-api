/**
 * SANDBOX1 probe — can a SANDBOXED tool hold a DURABLE, DIRECTORY-SCOPED grant
 * to ANOTHER app's group container via a security-scoped bookmark, immune to
 * the per-process kTCCServiceSystemPolicyAppData consent churn?
 *
 * Modes (one per invocation):
 *   grant <dir>   present NSOpenPanel (⌘⇧G-driven by the campaign's AX rig),
 *                 save an app-scoped security bookmark for the selection into
 *                 the sandbox container home; prints GRANT-OK <path>
 *   read          resolve the bookmark, start the security scope, locate the
 *                 ThingsData-…/main.sqlite inside it, open READ-ONLY via
 *                 SQLite, count TMTask rows + read a prefs plist; prints
 *                 READ-OK {json}. The cell passes iff this succeeds in a
 *                 FRESH process with NO consent prompt and NO kernel stall.
 *   noscope <dir> attempt the same read WITHOUT resolving the bookmark;
 *                 expects the sandbox to deny immediately (NOSCOPE-DENIED)
 *   serve         bind a UNIX socket in the sandbox container home, echo one
 *                 line per connection prefixed ECHO: (socket-under-sandbox cell)
 *
 * The read/noscope cells must run under LAUNCHD (not ssh): ssh-spawned guest
 * processes inherit sshd-keygen-wrapper's TCC standing, which would mask the
 * exact semantics under test.
 */
import AppKit
import Foundation
import SQLite3

let SQLITE_TRANSIENT_P = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

// Unbuffered stdout: launchd redirects it to a file, and a long-running mode
// (serve) would otherwise hold its banner in the libc buffer forever.
setvbuf(stdout, nil, _IONBF, 0)

func bookmarkPath() -> String {
  // Sandboxed home == the container's Data dir — the durable private store.
  NSHomeDirectory() + "/sandbox-probe.bookmark"
}

func fail(_ message: String) -> Never {
  print("FAIL \(message)")
  exit(1)
}

func doGrant(startDir: String) {
  let app = NSApplication.shared
  // Regular policy: the panel needs real key-window standing for the AX rig
  // to target the process and for ⌘⇧G to land (accessory apps flake here).
  app.setActivationPolicy(.regular)
  let panel = NSOpenPanel()
  panel.canChooseDirectories = true
  panel.canChooseFiles = false
  panel.allowsMultipleSelection = false
  panel.directoryURL = URL(fileURLWithPath: startDir)
  panel.message = "SANDBOX1: select the Things group container"
  app.activate(ignoringOtherApps: true)
  let response = panel.runModal()
  guard response == .OK, let url = panel.url else { fail("panel dismissed without selection") }
  do {
    let bookmark = try url.bookmarkData(
      options: [.withSecurityScope],
      includingResourceValuesForKeys: nil, relativeTo: nil)
    try bookmark.write(to: URL(fileURLWithPath: bookmarkPath()))
    print("GRANT-OK \(url.path)")
  } catch {
    fail("bookmark mint failed: \(error)")
  }
}

func resolveScope() -> URL {
  guard let data = FileManager.default.contents(atPath: bookmarkPath()) else {
    fail("no bookmark at \(bookmarkPath()) — run grant first")
  }
  var stale = false
  guard
    let url = try? URL(
      resolvingBookmarkData: data, options: [.withSecurityScope],
      relativeTo: nil, bookmarkDataIsStale: &stale)
  else { fail("bookmark resolution failed") }
  guard url.startAccessingSecurityScopedResource() else { fail("startAccessing refused") }
  if stale {
    // Refresh in place — staleness is reportable, not fatal.
    if let fresh = try? url.bookmarkData(
      options: [.withSecurityScope], includingResourceValuesForKeys: nil, relativeTo: nil) {
      try? fresh.write(to: URL(fileURLWithPath: bookmarkPath()))
    }
  }
  return url
}

func readContainer(root: String, label: String) {
  let fm = FileManager.default
  guard let entries = try? fm.contentsOfDirectory(atPath: root) else {
    print("\(label)-DENIED listing \(root) (errno \(errno))")
    exit(2)
  }
  var dbPath: String? = nil
  for entry in entries where entry.hasPrefix("ThingsData-") {
    let candidate = root + "/" + entry + "/Things Database.thingsdatabase/main.sqlite"
    if fm.fileExists(atPath: candidate) { dbPath = candidate }
  }
  guard let db = dbPath else { fail("\(label): no main.sqlite under \(root)") }

  var handle: OpaquePointer?
  guard sqlite3_open_v2(db, &handle, SQLITE_OPEN_READONLY, nil) == SQLITE_OK, let h = handle
  else {
    print("\(label)-DENIED sqlite open \(db)")
    exit(2)
  }
  defer { sqlite3_close_v2(h) }
  var stmt: OpaquePointer?
  guard sqlite3_prepare_v2(h, "SELECT count(*) FROM TMTask", -1, &stmt, nil) == SQLITE_OK,
    sqlite3_step(stmt) == SQLITE_ROW
  else { fail("\(label): TMTask count query failed: \(String(cString: sqlite3_errmsg(h)))") }
  let taskRows = sqlite3_column_int64(stmt!, 0)
  sqlite3_finalize(stmt)

  let plist = root + "/Library/Preferences/JLMPQHK86H.com.culturedcode.ThingsMac.plist"
  let plistBytes = fm.contents(atPath: plist)?.count ?? -1

  print("\(label)-OK {\"tmtaskRows\": \(taskRows), \"plistBytes\": \(plistBytes), \"db\": \"\(db)\"}")
}

func doServe() {
  let sockPath = NSHomeDirectory() + "/reader.sock"
  unlink(sockPath)
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  guard fd >= 0 else { fail("socket() errno \(errno)") }
  var addr = sockaddr_un()
  addr.sun_family = sa_family_t(AF_UNIX)
  let capacity = MemoryLayout.size(ofValue: addr.sun_path)
  guard sockPath.utf8.count < capacity else { fail("socket path too long") }
  _ = withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
    sockPath.withCString { cstr in
      strncpy(UnsafeMutableRawPointer(ptr).assumingMemoryBound(to: CChar.self), cstr, capacity - 1)
    }
  }
  let bound = withUnsafePointer(to: &addr) { ptr in
    ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
      bind(fd, sa, socklen_t(MemoryLayout<sockaddr_un>.size))
    }
  }
  guard bound == 0 else {
    print("SERVE-DENIED bind errno \(errno)")
    exit(2)
  }
  guard listen(fd, 4) == 0 else { fail("listen errno \(errno)") }
  print("SERVE-OK \(sockPath)")
  // Echo loop: one line per connection, then close. The campaign connects
  // once via a helper and asserts the echo round-trips.
  while true {
    let conn = accept(fd, nil, nil)
    if conn < 0 { continue }
    var buffer = [UInt8](repeating: 0, count: 4096)
    let n = read(conn, &buffer, buffer.count)
    if n > 0 {
      let line = "ECHO:" + String(decoding: buffer[0..<n], as: UTF8.self)
      _ = line.withCString { write(conn, $0, strlen($0)) }
    }
    close(conn)
  }
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage: sandbox-probe grant <dir> | read | noscope <dir> | serve") }
switch args[1] {
case "grant":
  guard args.count == 3 else { fail("grant needs the start directory") }
  doGrant(startDir: args[2])
case "read":
  let root = resolveScope()
  readContainer(root: root.path, label: "READ")
  root.stopAccessingSecurityScopedResource()
case "noscope":
  guard args.count == 3 else { fail("noscope needs the directory") }
  readContainer(root: args[2], label: "NOSCOPE")
case "serve":
  doServe()
default:
  fail("unknown mode \(args[1])")
}
