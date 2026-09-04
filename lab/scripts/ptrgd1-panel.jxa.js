// PTRGD1 lab occluder — a floating, opaque, click-catching panel at a chosen
// screen rectangle, for the cells that need a REAL above-Things window while
// Things itself is frontmost.
//
// Why this exists: the Dock cannot serve as that occluder (it owns one
// full-screen mouse-transparent window and no separate strip on a headless
// clone), and Stickies' Note ▸ Float on Top is not reliably reachable from
// System Events on every build. `NSFloatingWindowLevel` is exactly what an
// ordinary always-on-top palette uses, so this is the same class of window the
// guard must catch in the field.
//
// Accessory activation policy: the panel appears WITHOUT taking activation, so
// Things stays frontmost and the cell isolates OCCLUSION from FRONTMOST. It
// self-terminates after the requested number of seconds, and it only ever runs
// inside a disposable lab clone.
//
// Usage: osascript -l JavaScript ptrgd1-panel.jxa.js <x> <y> <w> <h> <seconds>
// Coordinates are TOP-LEFT origin (the same space AX frames and CGEvent use);
// they are flipped here into AppKit's bottom-left space.
ObjC.import("AppKit");

var ARG = $.NSProcessInfo.processInfo.arguments;
function num(i) {
  return Number(ObjC.unwrap(ARG.objectAtIndex(i + 4)));
}
var X = num(0),
  Y = num(1),
  W = num(2),
  H = num(3),
  SECS = num(4) || 120;

var app = $.NSApplication.sharedApplication;
// NSApplicationActivationPolicyAccessory — no Dock tile, no activation.
app.setActivationPolicy(1);

var screen = $.NSScreen.mainScreen.frame;
var flippedY = screen.size.height - Y - H;

var win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(
  $.NSMakeRect(X, flippedY, W, H),
  0, // NSWindowStyleMaskBorderless
  2, // NSBackingStoreBuffered
  false,
);
// NSFloatingWindowLevel is 3; the bridge does not always expose the symbol.
var LEVEL = $.NSFloatingWindowLevel;
if (typeof LEVEL !== "number") LEVEL = 3;
win.setLevel(LEVEL);
win.setOpaque(true);
win.setBackgroundColor($.NSColor.redColor);
win.setIgnoresMouseEvents(false);
win.setHidesOnDeactivate(false);
win.orderFrontRegardless;

$.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(SECS));
("DONE");
