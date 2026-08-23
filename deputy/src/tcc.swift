/**
 * Prompt-free TCC introspection, plus the one call that deliberately DOES
 * prompt (Accessibility).
 *
 * The deputy is the process macOS attributes every AppleEvent and every
 * Accessibility action to, so it — and only it — can answer "am I allowed to
 * drive Things?" truthfully. Both answers ride the `hello` response, which
 * makes `things helpers status` and the onboarding ceremony able to SKIP a leg
 * that is already granted instead of re-firing a dialog at the user.
 *
 * `AEDeterminePermissionToAutomateTarget(…, askUserIfNeeded: false)` is the
 * documented non-prompting probe: it answers from the existing TCC record and
 * returns errAEEventWouldRequireUserConsent (-1744) when no record exists yet
 * — reported here as "unknown", which is exactly the state the ceremony then
 * resolves by sending a real (prompting) AppleEvent.
 */
import ApplicationServices
import Foundation

/// One target's Automation state: "granted" | "denied" | "not-running" | "unknown".
func automationStatus(bundleID: String) -> String {
  var target = AEAddressDesc()
  let bytes = Array(bundleID.utf8)
  let created = bytes.withUnsafeBufferPointer { buf in
    AECreateDesc(typeApplicationBundleID, buf.baseAddress, buf.count, &target)
  }
  guard created == noErr else { return "unknown" }
  defer { AEDisposeDesc(&target) }
  // askUserIfNeeded: false — a status probe must never raise a dialog.
  let status = AEDeterminePermissionToAutomateTarget(&target, typeWildCard, typeWildCard, false)
  switch status {
  case noErr:
    return "granted"
  case -1743:  // errAEEventNotPermitted — the user (or MDM) said no.
    return "denied"
  case -600:  // procNotFound — the target is not running, so TCC has no answer.
    return "not-running"
  default:
    // -1744 errAEEventWouldRequireUserConsent lands here: never asked yet.
    return "unknown"
  }
}

/// Accessibility trust for THIS process, prompt-free.
func accessibilityTrusted() -> Bool {
  AXIsProcessTrusted()
}

/**
 * Ask macOS to show the Accessibility prompt for this process. The dialog is
 * fire-and-forget (it offers a Settings deep-link; the actual grant is a
 * toggle the user flips in System Settings), so this returns the CURRENT trust
 * state immediately rather than waiting for one that can only arrive later.
 */
func primeAccessibility() -> Bool {
  let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
  return AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
}
