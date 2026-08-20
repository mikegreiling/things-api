/**
 * osascript execution with a hard timeout. The deputy owns the child process:
 * a caller (or its whole harness) dying mid-request never orphans an
 * osascript — the deputy's timer terminates it at the requested deadline
 * (SIGTERM, then SIGKILL after a 2s grace). Argv shapes are fixed here; the
 * client supplies only the script text, language, and timeout.
 */
import CryptoKit
import Foundation

private final class Flag {
  private let lock = NSLock()
  private var value = false
  func set() {
    lock.lock()
    value = true
    lock.unlock()
  }
  func get() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return value
  }
}

func runOsascript(script: String, lang: String, timeoutMs: Int, binPath: String, id: Any?)
  -> [String: Any]
{
  runChildTool(
    binPath: binPath,
    args: lang == "javascript" ? ["-l", "JavaScript", "-e", script] : ["-e", script],
    timeoutMs: timeoutMs, id: id)
}

/// Generic deadline-bounded child runner shared by the osascript and
/// shortcuts verbs. Argv is always assembled deputy-side from a fixed shape.
func runChildTool(binPath: String, args: [String], timeoutMs: Int, id: Any?) -> [String: Any] {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: binPath)
  process.arguments = args
  let outPipe = Pipe()
  let errPipe = Pipe()
  process.standardOutput = outPipe
  process.standardError = errPipe
  process.standardInput = FileHandle.nullDevice

  do {
    try process.run()
  } catch {
    return [
      "id": id ?? NSNull(), "ok": false,
      "error": ["code": "internal", "message": "cannot launch \(binPath): \(error.localizedDescription)"],
    ]
  }

  let timedOut = Flag()
  let pid = process.processIdentifier
  let killer = DispatchWorkItem {
    timedOut.set()
    process.terminate()
    DispatchQueue.global().asyncAfter(deadline: .now() + 2.0) {
      if process.isRunning { kill(pid, SIGKILL) }
    }
  }
  DispatchQueue.global().asyncAfter(
    deadline: .now() + .milliseconds(max(1, timeoutMs)), execute: killer)

  // Drain both pipes off-thread so a chatty script never deadlocks the wait.
  var outData = Data()
  var errData = Data()
  let group = DispatchGroup()
  group.enter()
  DispatchQueue.global().async {
    outData = outPipe.fileHandleForReading.readDataToEndOfFile()
    group.leave()
  }
  group.enter()
  DispatchQueue.global().async {
    errData = errPipe.fileHandleForReading.readDataToEndOfFile()
    group.leave()
  }
  process.waitUntilExit()
  killer.cancel()
  group.wait()

  var result: [String: Any] = [
    "id": id ?? NSNull(),
    "ok": true,
    "exitCode": Int(process.terminationStatus),
    "stdout": String(decoding: outData, as: UTF8.self),
    "stderr": String(decoding: errData, as: UTF8.self),
  ]
  if process.terminationReason == .uncaughtSignal {
    result["signal"] = Int(process.terminationStatus)
  }
  if timedOut.get() { result["timedOut"] = true }
  return result
}

func sha256Hex(_ text: String) -> String {
  SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
}
