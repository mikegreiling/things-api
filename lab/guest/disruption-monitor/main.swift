// disruption-monitor — in-guest Aqua-session observer for the Things lab.
//
// Emits NDJSON events to ~/things-lab/events.ndjson:
//   {"ts":"…","kind":"launch|activate|terminate|frontmost|window-new|window-close|title-change","detail":{…}}
// The probe runner brackets probes with MARK sentinels by appending its own
// lines to the same file; evidence extraction is a log slice between marks.
//
// Requires (granted once in the golden image, clones inherit):
//   - Accessibility (window/title introspection via CGWindowList)
// Build: see build.sh (host-side cross-compile, arm64 macOS 15+).
import AppKit
import Foundation

let thingsBundleId = "com.culturedcode.ThingsMac"
let outPath = ("~/things-lab/events.ndjson" as NSString).expandingTildeInPath

final class EventSink {
    private let handle: FileHandle
    private let iso = ISO8601DateFormatter()
    init?() {
        FileManager.default.createFile(atPath: outPath, contents: nil)
        guard let h = FileHandle(forWritingAtPath: outPath) else { return nil }
        h.seekToEndOfFile()
        handle = h
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    }
    func emit(_ kind: String, _ detail: [String: Any]) {
        var record: [String: Any] = ["ts": iso.string(from: Date()), "kind": kind]
        record["detail"] = detail
        guard let data = try? JSONSerialization.data(withJSONObject: record) else { return }
        handle.write(data)
        handle.write(Data("\n".utf8))
    }
}

guard let sink = EventSink() else {
    FileHandle.standardError.write(Data("cannot open \(outPath)\n".utf8))
    exit(1)
}

func appDetail(_ note: Notification) -> [String: Any] {
    guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
    else { return [:] }
    return [
        "bundleId": app.bundleIdentifier ?? "?",
        "name": app.localizedName ?? "?",
        "pid": app.processIdentifier,
    ]
}

let nc = NSWorkspace.shared.notificationCenter
for (name, kind) in [
    (NSWorkspace.didLaunchApplicationNotification, "launch"),
    (NSWorkspace.didActivateApplicationNotification, "activate"),
    (NSWorkspace.didTerminateApplicationNotification, "terminate"),
] {
    nc.addObserver(forName: name, object: nil, queue: .main) { note in
        sink.emit(kind, appDetail(note))
    }
}

// 50ms frontmost poll + Things window snapshot diffing via CGWindowList.
var lastFrontmost = ""
var lastWindows: [Int: String] = [:] // windowNumber -> title

func thingsWindows() -> [Int: String] {
    guard
        let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
            as? [[String: Any]]
    else { return [:] }
    var result: [Int: String] = [:]
    for w in info {
        guard let owner = w[kCGWindowOwnerName as String] as? String, owner == "Things",
              let num = w[kCGWindowNumber as String] as? Int
        else { continue }
        result[num] = (w[kCGWindowName as String] as? String) ?? ""
    }
    return result
}

Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in
    let front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? ""
    if front != lastFrontmost {
        sink.emit("frontmost", ["bundleId": front])
        lastFrontmost = front
    }
    let windows = thingsWindows()
    for (num, title) in windows {
        if let old = lastWindows[num] {
            if old != title { sink.emit("title-change", ["window": num, "from": old, "to": title]) }
        } else {
            sink.emit("window-new", ["window": num, "title": title])
        }
    }
    for (num, title) in lastWindows where windows[num] == nil {
        sink.emit("window-close", ["window": num, "title": title])
    }
    lastWindows = windows
}

sink.emit("monitor-start", ["pid": ProcessInfo.processInfo.processIdentifier])
RunLoop.main.run()
