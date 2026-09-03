/**
 * THE DEPUTY-HOSTED AX SETTLE OBSERVER (DEPOBS1, #695/#676).
 *
 * A settle that waits for the app's own Accessibility notification needs a
 * process that (a) holds the Accessibility grant and (b) can own a C function
 * pointer and a CFRunLoop. On a direct-execution Mac that process is a
 * `python3` ctypes sidecar spawned from inside the osascript hop
 * (src/write/vectors/ui-observer.ts). On a HELPERS-ROUTED Mac it cannot be:
 * both of the sidecar's hops reach their socket through `do shell script`, and
 * the broker refuses that phrase by design (`scriptGuard`) — which is how
 * 0.20.7 shipped a `todo add-repeating --dangerously-drive-gui` that died in two
 * seconds on every routed host. So the observer moves to the one process on a
 * routed Mac that already satisfies both conditions: the deputy itself.
 *
 * WHAT THIS BUYS, AND WHAT IT DOES NOT.
 *
 * The deputy hosts the LEDGER and the WAIT. A drive marks the ledger's sequence
 * before an actuation and awaits the observable after it, over the socket it
 * already holds open — so every CROSS-HOP settle (the `Next:` pop-up's
 * recompute, the whole-hop wait the field could see) becomes a socket
 * round-trip against a ledger that has been recording since before the first
 * actuation. What it does NOT restore is the IN-SCRIPT settle: a generated
 * script still has no way to reach a socket without shelling out, so on a
 * routed host the in-script waits stay the certified polling ones, byte for
 * byte. That is a deliberate half-measure, recorded as such.
 *
 * NO NEW CONSENT, BY CONSTRUCTION (permissions doctrine). `AXObserverCreate`
 * rides the caller's Accessibility trust, and the deputy already holds it (it is
 * what every drive's clicks and keystrokes go through). This file never calls
 * `AXIsProcessTrustedWithOptions` — the one API here that can raise a dialog
 * lives in tcc.swift and is reached only by the `prime-ax` verb during a setup
 * ceremony. An untrusted deputy answers `observer-start` with a refusal and the
 * client falls back to polling; it never prompts.
 *
 * IT NEVER READS CONTENT. A recorded event carries a notification NAME and the
 * posting element's AX ROLE. No title, value, description or identifier is ever
 * read, so nothing from the user's database can reach a wire, a log or a trace
 * through this path — the same rule the python sidecar was written under, and
 * the reason the settle matcher discriminates on role alone.
 *
 * BOUNDED ON EVERY AXIS. A session dies on an explicit `observer-stop`, on
 * idleness ({@link OBSERVER_IDLE_SECONDS}), and with the deputy's own drain. A
 * crashed client therefore cannot leak an observer, and the registry caps how
 * many can exist at once.
 */
import AppKit
import ApplicationServices
import Foundation

/**
 * The notification classes registered on the Things application element.
 *
 * Identical to the sidecar's list (VOPAT1 §4 measured the observables; VOPAT1-12
 * found `AXLayoutChanged` never fires for any actuation this driver makes — it
 * is registered anyway so that a future app version which starts posting it
 * shows up in a trace instead of being invisible). Registration on the
 * APPLICATION element is sufficient: VOPAT2 recorded sheet, menu and pop-up
 * arrivals, each tagged with its own role, from a registration that named none
 * of those elements.
 */
let OBSERVER_NOTIFICATIONS: [String] = [
  "AXCreated",
  "AXUIElementDestroyed",
  "AXSheetCreated",
  "AXWindowCreated",
  "AXValueChanged",
  "AXTitleChanged",
  "AXFocusedUIElementChanged",
  "AXFocusedWindowChanged",
  "AXMenuOpened",
  "AXMenuClosed",
  "AXRowCountChanged",
  "AXSelectedRowsChanged",
  "AXSelectedChildrenChanged",
  "AXLayoutChanged",
  "AXResized",
  "AXMoved",
]

/// Things' bundle identifier — the only process this observer will ever target.
let OBSERVER_TARGET_BUNDLE_ID = "com.culturedcode.ThingsMac"

/// One drive holds one session; the cap is slack for a stale one, not a pool.
let OBSERVER_MAX_SESSIONS = 4
/// No request for this long and the session is reaped (a crashed client leaks nothing).
let OBSERVER_IDLE_SECONDS: TimeInterval = 120
/// Ledger ceiling. Idle chatter is zero and the largest measured burst is 65.
let OBSERVER_LEDGER_LIMIT = 4000
/// Ceiling on one wait, so a wedged client cannot pin a connection (or a drain).
let OBSERVER_MAX_WAIT_MS = 30_000
/// How many marks keep their timestamp, so a reported latency is measured from the actuation.
let OBSERVER_MARKS_LIMIT = 64
/// Most events one reply will carry back (the trace wants a sample, not a transcript).
let OBSERVER_MAX_REPLY_EVENTS = 32
/// How long `observer-start` waits for the run loop to attach before answering.
let OBSERVER_ATTACH_TIMEOUT: TimeInterval = 2.0

/// One arrival: when, what, and the posting element's role. Never its content.
struct ObserverEvent {
  let seq: Int
  let at: Date
  let notification: String
  let role: String
}

/// `AXValueChanged:AXPopUpButton` → ("AXValueChanged", "AXPopUpButton"); role optional.
struct ObserverMatcher {
  let notification: String
  let role: String?

  static func parse(_ spec: String) -> ObserverMatcher? {
    let trimmed = spec.trimmingCharacters(in: .whitespaces)
    if trimmed.isEmpty { return nil }
    let parts = trimmed.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
    let name = String(parts[0])
    if name.isEmpty { return nil }
    let role = parts.count > 1 ? String(parts[1]) : ""
    return ObserverMatcher(notification: name, role: role.isEmpty ? nil : role)
  }

  func matches(_ event: ObserverEvent) -> Bool {
    event.notification == notification && (role == nil || event.role == role)
  }
}

/**
 * The AXObserver callback. A C function pointer — which is the whole reason the
 * observer cannot live in an osascript hop (JXA's ObjC bridge cannot marshal
 * one, VOPAT1 §4) and can live here: Swift converts a capture-free global
 * function to `AXObserverCallback` directly.
 *
 * Runs on the session's own run-loop thread. Reads the element's ROLE and
 * nothing else.
 */
private func observerCallback(
  _ observer: AXObserver,
  _ element: AXUIElement,
  _ notification: CFString,
  _ refcon: UnsafeMutableRawPointer?
) {
  guard let refcon else { return }
  let session = Unmanaged<ObserverSession>.fromOpaque(refcon).takeUnretainedValue()
  session.record(notification: notification as String, element: element)
}

/// The posting element's AX role, or "" when it will not say.
private func roleOf(_ element: AXUIElement) -> String {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &value) == .success
  else { return "" }
  return (value as? String) ?? ""
}

/**
 * One drive's observer: an `AXObserver` on Things' pid, a dedicated run-loop
 * thread, and the sequenced ledger a waiter compares against.
 *
 * WHY ITS OWN THREAD. The deputy's main thread sits in `dispatchMain()`, which
 * services the main dispatch queue and never runs a CFRunLoop — so a run-loop
 * source added to the main run loop would never fire. The session therefore owns
 * a thread whose only job is to pump its own run loop in short slices, exactly
 * as the python sidecar does (short slices so an arrival's recorded time is its
 * own, and so teardown is checked between them).
 */
final class ObserverSession {
  let token: String
  let pid: pid_t
  /**
   * A session with NO ACCESSIBILITY AT ALL, whose events arrive by injection.
   *
   * It exists so that the socket, the token, the ANY-OF/ALL-OF matcher, the
   * burst debounce, the wait timeout, the unknown-token refusal and every
   * bounded exit can be certified against the REAL broker binary on a machine
   * where the deputy is not (and must not be) Accessibility-trusted — CI
   * included. It touches no other process's UI tree and grants nothing: the
   * same seam the python sidecar has carried since VOPAT2 (`--self-test`).
   */
  let selfTest: Bool

  private let cond = NSCondition()
  private var events: [ObserverEvent] = []
  private var seqCounter = 0
  private var dropped = 0
  private var marks: [Int: Date] = [:]
  private var stopped = false

  private let stateLock = NSLock()
  private var lastRequestAt = Date()
  private(set) var registered = 0
  private(set) var asked = 0

  private var observer: AXObserver?
  private var thread: Thread?
  private let attached = DispatchSemaphore(value: 0)

  init(token: String, pid: pid_t, selfTest: Bool) {
    self.token = token
    self.pid = pid
    self.selfTest = selfTest
  }

  // --- lifecycle ---

  /// Create the observer, register every class, attach the run loop. Error string on failure.
  func arm() -> String? {
    if selfTest { return nil }
    var created: AXObserver?
    let err = AXObserverCreate(pid, observerCallback, &created)
    guard err == .success, let obs = created else {
      return "AXObserverCreate failed for pid \(pid) (AXError \(err.rawValue))"
    }
    observer = obs
    let app = AXUIElementCreateApplication(pid)
    _ = AXUIElementSetMessagingTimeout(app, 5.0)
    let refcon = Unmanaged.passUnretained(self).toOpaque()
    for name in OBSERVER_NOTIFICATIONS {
      asked += 1
      // kAXErrorNotificationUnsupported is not a failure: an app that does not
      // post a class never will, and a settle waiting on it times out into its
      // own named reason rather than hanging.
      if AXObserverAddNotification(obs, app, name as CFString, refcon) == .success {
        registered += 1
      }
    }
    guard registered > 0 else {
      observer = nil
      return "the app accepted none of the \(asked) notification registrations"
    }
    let worker = Thread { [weak self] in self?.pump(obs) }
    worker.name = "things-deputy.observer"
    worker.stackSize = 512 * 1024
    thread = worker
    worker.start()
    // The run loop must be attached before the client's first mark, or an
    // arrival between arming and attaching would be invisible.
    if attached.wait(timeout: .now() + OBSERVER_ATTACH_TIMEOUT) == .timedOut {
      teardown()
      return "the observer run loop did not attach within \(Int(OBSERVER_ATTACH_TIMEOUT * 1000))ms"
    }
    return nil
  }

  private func pump(_ obs: AXObserver) {
    let runLoop = CFRunLoopGetCurrent()
    let source = AXObserverGetRunLoopSource(obs)
    CFRunLoopAddSource(runLoop, source, .defaultMode)
    // Drain whatever the registration itself queued, so sequence 0 is a clean
    // "nothing has happened yet" for the drive's first mark.
    CFRunLoopRunInMode(.defaultMode, 0.10, false)
    resetLedger()
    attached.signal()
    while !isStopped() {
      CFRunLoopRunInMode(.defaultMode, 0.05, false)
    }
    CFRunLoopRemoveSource(runLoop, source, .defaultMode)
  }

  /// Stop the run loop and drop the observer. Idempotent.
  func teardown() {
    cond.lock()
    stopped = true
    cond.broadcast()
    cond.unlock()
    // The pump thread notices between run-loop slices (≤50 ms) and removes its
    // own source; nothing here waits on it, so a teardown cannot block a drain.
    observer = nil
    thread = nil
  }

  private func isStopped() -> Bool {
    cond.lock()
    defer { cond.unlock() }
    return stopped
  }

  // --- the ledger ---

  func record(notification: String, element: AXUIElement) {
    let role = roleOf(element)
    cond.lock()
    seqCounter += 1
    events.append(ObserverEvent(seq: seqCounter, at: Date(), notification: notification, role: role))
    if events.count > OBSERVER_LEDGER_LIMIT {
      let cut = events.count - OBSERVER_LEDGER_LIMIT
      events.removeFirst(cut)
      // What is trimmed is COUNTED, so a waiter is never silently answered out
      // of a ledger that dropped its evidence.
      dropped += cut
    }
    cond.broadcast()
    cond.unlock()
  }

  /// Self-test only: inject arrivals by `Notification[:Role]` spec.
  func inject(_ specs: [String]) -> Int {
    var added = 0
    cond.lock()
    for spec in specs {
      guard let matcher = ObserverMatcher.parse(spec) else { continue }
      guard OBSERVER_NOTIFICATIONS.contains(matcher.notification) else { continue }
      seqCounter += 1
      events.append(
        ObserverEvent(
          seq: seqCounter, at: Date(), notification: matcher.notification,
          role: matcher.role ?? ""))
      added += 1
    }
    cond.broadcast()
    cond.unlock()
    return added
  }

  private func resetLedger() {
    cond.lock()
    events.removeAll()
    seqCounter = 0
    dropped = 0
    marks.removeAll()
    cond.unlock()
  }

  func touch() {
    stateLock.lock()
    lastRequestAt = Date()
    stateLock.unlock()
  }

  func idleSeconds() -> TimeInterval {
    stateLock.lock()
    defer { stateLock.unlock() }
    return Date().timeIntervalSince(lastRequestAt)
  }

  /**
   * The ledger's current sequence, with the moment recorded.
   *
   * The timestamp is what makes a reported latency the time from THE ACTUATION
   * to the app's announcement rather than the time from the wait request — the
   * distinction that made the sidecar's first traces report negative latencies
   * for settles whose notification had already landed.
   */
  func mark() -> Int {
    cond.lock()
    let current = seqCounter
    marks[current] = Date()
    if marks.count > OBSERVER_MARKS_LIMIT {
      for old in marks.keys.sorted().prefix(marks.count - OBSERVER_MARKS_LIMIT) {
        marks.removeValue(forKey: old)
      }
    }
    cond.unlock()
    return current
  }

  /**
   * Block until the wanted arrival — and every required class — has landed past
   * `after`, or until the budget is spent.
   *
   * ANY-OF (`want`) ends the wait; ALL-OF (`all`) must also have been seen.
   * `quietMs` requires that many milliseconds with no further matching arrival,
   * which absorbs a burst without reading anything — and, in the one place it is
   * load-bearing, spans two indistinguishable pop-up changes whatever their
   * order (SETTLE_OCCURRENCE_RECOMPUTE).
   *
   * With `want` empty the wait does not wait at all: it reports what has landed
   * since `after` and returns. That is how a caller asks "did the previous step
   * actuate anything?" — meaningful only because Things is silent when nothing
   * happens (VOPAT1-6).
   */
  func wait(after: Int, want: [ObserverMatcher], all: [ObserverMatcher], quietMs: Int, timeoutMs: Int)
    -> [String: Any]
  {
    let started = Date()
    cond.lock()
    let reference = marks[after] ?? started
    let deadline = started.addingTimeInterval(Double(timeoutMs) / 1000.0)
    let quiet = max(0.0, Double(quietMs) / 1000.0)
    while true {
      let fresh = events.filter { $0.seq > after }
      let hit = want.isEmpty ? nil : fresh.first { event in want.contains { $0.matches(event) } }
      let missing = all.filter { required in !fresh.contains { required.matches($0) } }
      if let hit, missing.isEmpty {
        let relevant = fresh.filter { event in
          want.contains { $0.matches(event) } || all.contains { $0.matches(event) }
        }
        let last = relevant.map(\.at).max() ?? hit.at
        if quiet == 0.0 || Date().timeIntervalSince(last) >= quiet {
          let reply = self.reply(
            fresh: fresh, timedOut: false,
            extra: [
              "fired": hit.notification + (hit.role.isEmpty ? "" : ":" + hit.role),
              "latencyMs": ((hit.at.timeIntervalSince(reference) * 10_000).rounded() / 10),
              "hits": fresh.filter { event in want.contains { $0.matches(event) } }.count,
              "waitedMs": Int(Date().timeIntervalSince(started) * 1000),
            ])
          cond.unlock()
          return reply
        }
      }
      let remaining = deadline.timeIntervalSince(Date())
      if remaining <= 0 || (want.isEmpty && all.isEmpty) {
        let reply = self.reply(
          fresh: fresh, timedOut: true,
          extra: [
            "waitedMs": Int(Date().timeIntervalSince(started) * 1000),
            "missing": missing.map { matcher -> String in
              matcher.role == nil ? matcher.notification : matcher.notification + ":" + matcher.role!
            }.joined(separator: "+"),
          ])
        cond.unlock()
        return reply
      }
      var slice = remaining
      if hit != nil && missing.isEmpty && quiet > 0.0 { slice = min(slice, quiet) }
      cond.wait(until: Date().addingTimeInterval(min(slice, 0.25)))
    }
  }

  /// Shared reply body: the cursor, a bounded event sample, and what was dropped.
  private func reply(fresh: [ObserverEvent], timedOut: Bool, extra: [String: Any]) -> [String: Any] {
    var body: [String: Any] = [
      "seq": seqCounter,
      "seen": fresh.count,
      "dropped": dropped,
      "timedOut": timedOut,
      "events": fresh.suffix(OBSERVER_MAX_REPLY_EVENTS).map { event in
        ["seq": event.seq, "notification": event.notification, "role": event.role]
      },
    ]
    for (key, value) in extra { body[key] = value }
    return body
  }
}

/// A start attempt's outcome: the live session, or the reason there is none.
enum ObserverStartOutcome {
  case started(ObserverSession)
  case refused(String)
}

/**
 * Every live session, keyed by its opaque token.
 *
 * The token is the capability: a client that holds one can mark and wait on that
 * session and nothing else. It is minted here rather than accepted from the
 * client so a caller cannot name (or guess at) another drive's session.
 */
final class ObserverRegistry {
  static let shared = ObserverRegistry()

  private let lock = NSLock()
  private var sessions: [String: ObserverSession] = [:]
  private var sweeper: DispatchSourceTimer?

  /// Is Things running, and under which pid? Prompt-free, and needs no consent
  /// class of its own — the deputy is asking about the session it lives in.
  static func thingsPid() -> pid_t? {
    NSRunningApplication.runningApplications(withBundleIdentifier: OBSERVER_TARGET_BUNDLE_ID)
      .first?.processIdentifier
  }

  private func mintToken() -> String {
    var bytes = [UInt8](repeating: 0, count: 16)
    for index in 0..<bytes.count { bytes[index] = UInt8.random(in: 0...255) }
    return bytes.map { String(format: "%02x", $0) }.joined()
  }

  /**
   * Start a session, or say why not. Never prompts: an untrusted deputy is a
   * REFUSAL the client turns into a polling fallback, never a dialog.
   */
  func start(pid requested: pid_t?, selfTest: Bool) -> ObserverStartOutcome {
    sweep()
    lock.lock()
    let count = sessions.count
    lock.unlock()
    if count >= OBSERVER_MAX_SESSIONS {
      return .refused("\(count) observer sessions are already live (max \(OBSERVER_MAX_SESSIONS))")
    }
    var pid: pid_t = 0
    if !selfTest {
      guard accessibilityTrusted() else {
        return .refused(
          "the helper is not trusted for the Accessibility API — run `things helpers setup` once, at the machine"
        )
      }
      guard let resolved = requested ?? ObserverRegistry.thingsPid(), resolved > 0 else {
        return .refused("Things is not running")
      }
      pid = resolved
    }
    let session = ObserverSession(token: mintToken(), pid: pid, selfTest: selfTest)
    if let error = session.arm() { return .refused(error) }
    lock.lock()
    sessions[session.token] = session
    lock.unlock()
    startSweeper()
    return .started(session)
  }

  func session(_ token: String) -> ObserverSession? {
    lock.lock()
    defer { lock.unlock() }
    return sessions[token]
  }

  @discardableResult
  func stop(_ token: String) -> ObserverSession? {
    lock.lock()
    let session = sessions.removeValue(forKey: token)
    lock.unlock()
    session?.teardown()
    return session
  }

  /// Reap sessions no client has spoken to in OBSERVER_IDLE_SECONDS.
  @discardableResult
  func sweep() -> Int {
    lock.lock()
    let stale = sessions.filter { $0.value.idleSeconds() >= OBSERVER_IDLE_SECONDS }
    for (token, _) in stale { sessions.removeValue(forKey: token) }
    lock.unlock()
    for (_, session) in stale { session.teardown() }
    return stale.count
  }

  /// Drain: no observer outlives the deputy that hosts it.
  func stopAll() -> Int {
    lock.lock()
    let all = sessions
    sessions.removeAll()
    sweeper?.cancel()
    sweeper = nil
    lock.unlock()
    for (_, session) in all { session.teardown() }
    return all.count
  }

  func liveCount() -> Int {
    lock.lock()
    defer { lock.unlock() }
    return sessions.count
  }

  /**
   * The idle reaper. On a global queue rather than the main run loop, which the
   * deputy's `dispatchMain()` never runs — the same reason a session owns its
   * own run-loop thread.
   */
  private func startSweeper() {
    lock.lock()
    defer { lock.unlock() }
    if sweeper != nil { return }
    let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global())
    timer.schedule(deadline: .now() + 15, repeating: 15)
    timer.setEventHandler { [weak self] in self?.sweep() }
    timer.resume()
    sweeper = timer
  }
}
