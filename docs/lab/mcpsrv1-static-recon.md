# MCPSRV1 — Things' own MCP server, read out of the bundle

**Immutable evidence snapshot.** Things **3.24 build 32400006** (primary), compared against the banked **3.23 build 32300036**, **3.23.1 32301002**, **3.23.2 32302001**, **3.23.3 32303001**, **3.22.14 32214000**, **3.22.12 32212016**, **3.22.11 32211007**. Run date **2026-09-14**, macOS 27.0 host.

**Method: STATIC bundle inspection only**, plus five read-only host observations named in §7. No VM was cloned or booted (the GV5 recertification held the goldens). Things was never launched by this campaign, no socket was connected to, no default was written, no configuration was flipped, and nothing touched the maintainer's database. Tools: `unzip -p`, `strings`, `nm`, `otool`, `codesign -d --entitlements`, `xcrun swift-demangle`, `llvm-objdump -d`, and a hand-written parser for the Swift 5 `__swift5_fieldmd` reflection section (field and enum-case names for types whose symbols are otherwise opaque).

Found by [AI324](ai324-app-intents-catalog.md) §7 while reading `ThingsCommon` for App Intents symbols. This document answers phase 1 of the campaign: **what it is, what it serves, how it is enabled, and when it appeared.** Phase 2 — speaking to it in a guest — is designed in §8 and has not been run.

---

## 1. The verdict, in one paragraph

Things ships a **complete, real, in-process MCP server**. It is not a stub and not a research branch: it is the reference protocol (`2025-06-18`), spoken as newline-delimited JSON-RPC 2.0 over a **unix domain socket named `mcp.sock` inside the app's own App Group container**, implemented in Cultured Code's own `FoundationAdditions.framework` as a general JSON-RPC + MCP stack (`FAJSONRPCPeer`, `FAMCPServer`, `FAMCPTool`), with the Things-specific half in `ThingsCommon` (`THCThingsMCPServerComponent`, `THCThingsMCPSession`, `THCThingsMCPToolCallContext`). It advertises exactly **one capability — `tools`** — and exposes exactly **one tool: `GetTodayList`**, a **read**, paginated, returning ThingsJSON. There are **no write tools, no resources, no prompts**. It is **off by default**, gated behind an internal feature toggle (`THCFeature.mcpServer`, display name "MCP Server") whose activation is an **obfuscated `NSUserDefaults` key**, and whose toggle UI is itself gated on a Cultured Code account or a development build. It first shipped in **3.23** and is **unchanged in substance through 3.24**. On the maintainer's host it is **not running**: the Things process holds zero unix-domain sockets.

If phase 2 confirms it can be enabled and spoken to, this is a **first-party JSON read path that needs neither SQLite nor a consent ceremony** — but a very narrow one (Today only), and one whose socket lives inside a TCC-protected Group Container.

---

## 2. Component map — where the code lives

Things 3.24 ships 17 frameworks. MCP symbols appear in exactly three binaries:

| Binary | MCP content |
| --- | --- |
| `Frameworks/FoundationAdditions.framework/…/FoundationAdditions` | the entire generic stack: JSON-RPC transport, peer, MCP protocol types |
| `Frameworks/ThingsCommon.framework/…/ThingsCommon` | the Things half: server component, session, tool-call context, the one tool, the feature toggle |
| `MacOS/Things3` | two references only — `mcpServerComponent`, i.e. the app owns the component |

No XPC service, no helper tool, no login item, no embedded launchd plist. The server runs **in the Things process**.

### 2.1 `FoundationAdditions` — the generic stack

Demangled from `nm`. Transport:

```
FAJSONRPCChannel                        (protocol)
FAJSONRPCChannel_StreamSocket           .init(socketFD: Int32)
                                        static .connect(to: String) async throws   <- client side
FAJSONRPCChannel_FileHandle             .init(input: NSFileHandle, output: NSFileHandle)  <- stdio side
FAJSONRPCChannel_InMemory               (enum)
FAJSONRPCChannelAcceptor                (protocol)
FAJSONRPCChannelAcceptor_StreamSocket   static .listening(at: String, backlog: Int32) throws
                                        .init(listenerFD: Int32, unlinkPathOnClose: String?)
FAJSONRPCChannelAcceptor_Single
FAJSONRPCPeer                           .start(), .send(_:params:), .notify(_:params:), .close(),
                                        .cancelInbound(id:), Configuration.register(_:handler:)
FAJSONRPCMessage / FAJSONRPCID / FAJSONRPCError / FAJSONRPCPeerError / FAJSONRPCChannelError
```

MCP:

```
FAMCPServer                 .init(acceptor: FAJSONRPCChannelAcceptor,
                                  serverInfo: FAMCPImplementation,
                                  instructions: String?,
                                  sessionFactory: @Sendable () async throws -> Session)
FAMCPServerConnection       { peer }
FAMCPSession                (protocol)  + .callTool(name:arguments:) async throws -> ToolsCall.Result
FAMCPTool / FAMCPArguments / FAMCPOutput / FAMCPAnyTool / FAMCPEmptyArguments
FAMCPToolDescriptor         { name, description: String?, inputSchema, outputSchema }
FAMCPImplementation         { name, version }
FAMCPServerCapabilities     { tools: FAMCPToolsCapability }
FAMCPToolsCapability        { listChanged: Bool? }
FAMCPClientCapabilities     (empty)
FAMCPContent                enum { text(String) }          <- text content only
FAMCPToolError              { content: [FAMCPContent] }
FAMCPRequest_Initialize     Params { protocolVersion, capabilities, clientInfo }
                            Result { protocolVersion, capabilities, serverInfo, instructions }
FAMCPRequest_ToolsList      Params { cursor: String? }  Result { tools: [...], nextCursor: String? }
FAMCPRequest_ToolsCall      Params { name: String, arguments: FAJSONValue? }
                            Result { content: [FAMCPContent], structuredContent, isError: Bool? }
FAMCPNotification_Initialized
FAMCPNotification_Cancelled Params { requestId, reason: String? }
```

That is the whole implemented surface: **`initialize`, `notifications/initialized`, `notifications/cancelled`, `tools/list`, `tools/call`**. There is **no** `resources/*`, no `prompts/*`, no `logging/*`, no `sampling/*`, no `completion/*` — neither the method literals nor the types exist in any binary in the bundle.

### 2.2 `ThingsCommon` — the Things half

```
THCThingsMCPServerComponent   : ivars _isEnabled (FAUpdateProp<Bool>), _databaseURL (FAUpdateProp<URL>),
                                _mcpServer (FAUpdateState<FAMCPServer<THCThingsMCPSession>?>)
                                static var socketURL: URL      (§4.1)
                                func update()                  (the reactive rebuild)
THCThingsMCPSession           : { tools: [...], databaseURL: URL,
                                  paginatedThingsJSONResult: PaginatedThingsJSONResult? }
THCThingsMCPToolCallContext   : { locale, timeZone, todayDate, todayDateCurrentTime, logDate,
                                  store, thingsModel, thingsQueryCache }
THCThingsMCPSessionError      : enum { databaseNeedsUpgrade }        <- the only session error
THCThingsMCPTool_GetTodayList : enum, conforms to FAMCPTool; Arguments { cursor: String? }
THCThingsMCPToolOutput_ThingsJSON : { items: [...], nextCursor: String? }
PaginatedThingsJSONResult     : { toolName: String, nextCursor: String, callContext: …,
                                  items: […], expiryTask: Task<(), …> }
```

Source file literal: `ThingsCommon/THCThingsMCPServerComponent.swift`.

Two things are worth naming. `THCThingsMCPToolCallContext` carries a pinned `todayDate`, `todayDateCurrentTime`, `logDate`, `locale` and `timeZone` — the call is evaluated against a **frozen "now"**, not against whatever the clock says mid-pagination. And `PaginatedThingsJSONResult` holds the **materialized item list plus an `expiryTask`**: a page cursor is a handle into a server-side snapshot that reaps itself, which is exactly what the tool description warns about (§3).

---

## 3. Tool catalog — one tool, and it is a read

`THCThingsMCPTool_GetTodayList` is the **only** `FAMCPTool` conformer in the bundle. There is no Inbox tool, no Upcoming/Anytime/Someday tool, no search tool, no project tool, and **no tool that writes anything**.

**Name** — recovered from the Swift small-string immediates at `0x58380` (arm64), `"GetToday"` + `"List"`, count `0x0c`:

```
GetTodayList
```

**Description** — 463 bytes (`0x1cf`), literal pool at `0x542410`:

> Returns the contents of the user's Today list in Things as ThingsJSON. Results are paginated; call repeatedly with the returned cursor until nextCursor is absent to retrieve all items. Stopping at the first page will likely miss results. Pagination is an internal detail of this tool — do not ask the user whether to fetch more pages, just keep calling until done. Cursors expire after a short time and must not be stored or reused across separate interactions.

**Input schema** — built at `0x56e24`; the `cursor` sub-schema is a static `FAJSONValue` object at `0x612398`, decoded field by field:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "cursor": {
      "type": "string",
      "description": "Opaque pagination cursor returned by a previous call. Omit to fetch the first page."
    }
  }
}
```

No `required` array — `cursor` is optional, as `Arguments { cursor: String? }` says.

**Output** — `THCThingsMCPToolOutput_ThingsJSON`, `Codable` with `CodingKeys { items, nextCursor }`:

```json
{ "items": [ /* ThingsJSON */ ], "nextCursor": "…" }
```

`nextCursor` is `String?`; per the description its **absence** is the end-of-pagination signal.

**Errors** — one string literal is dedicated to the cursor path (`0x5423e0`): *"Cursor is invalid or has expired."* The session's only error case is `databaseNeedsUpgrade`.

**Classification: READ.** Nothing in the MCP path reaches a mutation. The tool-call context holds `store` / `thingsModel` / `thingsQueryCache` — the same read machinery the rest of the app uses — and the output type is an encoder, not an applier. (`ThingsCommon` does contain a ThingsJSON **applier**, `THMLogic+ThingsJSONApply.swift`, but no MCP symbol reaches it.)

---

## 4. Transport and protocol

### 4.1 The socket path

`THCThingsMCPServerComponent.socketURL` is a `static let` built once (`swift_once` initializer at `0x2a5ef4`):

```
NSFileManager.defaultManager.thingsAppGroupContainerURL  ->  appending "mcp.sock"
```

`"mcp.sock"` is a Swift small-string immediate (`0x2a5fac`, count 8). The app group comes straight out of the entitlements:

```
com.apple.security.application-groups = [ "JLMPQHK86H.com.culturedcode.ThingsMac" ]
```

So the path is, on a normal Mac:

```
~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/mcp.sock
```

(HIGH confidence. The construction is unambiguous; the only inference is that `thingsAppGroupContainerURL` — an `NSFileManager` category in `FoundationAdditions` — returns the container for the one group id the app is entitled to.)

**This matters for the doctrine**: that directory is a Group Container, i.e. TCC "App Data" territory on modern macOS. The socket is not in `/tmp`.

### 4.2 The listener

`FAJSONRPCChannelAcceptor_StreamSocket.listening(at:backlog:)` at `0x1b960` / `0x1bd94` (FoundationAdditions, arm64):

```
socket(AF_UNIX=1, SOCK_STREAM=1, 0)
unlink(path)                        <- stale-socket removal before bind
sockaddr_un { sun_len = 0x6a, sun_family = 1 }; strlcpy(sun_path, path, 0x68)
bind(); listen(backlog)
```

and the acceptor is constructed with `unlinkPathOnClose:` — it removes its own socket on shutdown.

**No `chmod`, no `umask`, no `fchmod`** on the socket. **No peer-credential check of any kind**: `getpeereid`, `LOCAL_PEERCRED`, `SO_PEERCRED`, `audit_token`, `csops`, `SecCode`/`SecStaticCode` appear **nowhere** in `FoundationAdditions` or `ThingsCommon`. The only imported socket syscalls are `socket`, `bind`, `listen`, `accept`, `setsockopt`, `unlink`. **There is no handshake token and no client authentication.** Whoever can `connect(2)` to the path is a client. The gate is entirely filesystem/TCC.

### 4.3 Framing

`FAJSONRPCChannel_StreamSocket.send(_:)` encodes the message and then, at `0x1dbd0`:

```
mov  w8, #0xa
strb w8, [x0, #0xc0]!        ; append 0x0A to the encoded data
```

**Newline-delimited JSON (NDJSON) — one JSON-RPC message per line.** This is the same framing the MCP stdio transport uses; it is *not* LSP `Content-Length` framing (the one `Content-Length` string in `ThingsCommon` belongs to the HTTP stack, not to this one).

### 4.4 The protocol literals

From `FoundationAdditions`:

- protocol version: **`2025-06-18`** (small-string immediates at `0x74186` and `0x746d4`: `"2025-06-"` + `"18"`, count 10)
- methods: `initialize`, `notifications/initialized`, `notifications/cancelled`, `tools/list`, `tools/call`
- wire keys: `jsonrpc`, `protocolVersion`, `capabilities`, `clientInfo`, `serverInfo`, `instructions`, `listChanged`, `inputSchema`, `structuredContent`, `isError`

### 4.5 `serverInfo` and `instructions`

At `0x2a693c` in `ThingsCommon`, where the `FAMCPServer` is constructed:

```
x1    = "Things"                                 (small string, count 6)
x3:x4 = Bundle …["CFBundleShortVersionString"]   (literal pool "CFBundleShortVersionString")
x5:x6 = 0, 0                                     (instructions = nil)
```

So the handshake should answer approximately:

```json
{"protocolVersion":"2025-06-18",
 "capabilities":{"tools":{}},
 "serverInfo":{"name":"Things","version":"3.24"}}
```

with **no `instructions` string**. (`serverInfo.version` is `CFBundleShortVersionString`, i.e. `3.24`, not the build number.)

---

## 5. The enabling condition

### 5.1 It is a feature toggle

`ThingsCommon` carries a full internal feature-flag system — `THCFeature`, `THCFeatureSet`, `THCFeatureToggles` — and **`THCFeature.mcpServer` is one of its 27 flags**. The full list, for the record (Cultured Code's internal names, read out of a shipped public binary):

```
accountWebApp             experimentalNewMenus     macStyleStartButton    newTagFilterBar
contentZoomShortcuts      frontMatter              macStyleTagFilterBar   noteItems
copySelectionAsJSON       improvedTagListEditing   macStyleTagPills       showDiagnosticsInQuickFind
desyncedNotesList         longText                 macStyleTaskDetails    smartLists
eveningThisWeekPrototype  macStyleChecklists       mcpServer              stickyEvening
experimentalAIFeatures    macStyleCloudIndicator   newLook                syncronyChunkingStressTest
                          macStyleProjectCounts    newProjectList
                          macStyleSearchMatches
```

`THCFeature`'s shape, from the reflection metadata:

```
THCFeature { name: String, activation: Activation, visibilityPrerequisites: Prerequisites?,
             requiresQuittingAppUponChanging: Bool, enabledInUnitTests: Bool, cachedValue: Bool? }
Activation     = .constant(Bool) | .implicit(Prerequisites) | .explicitThroughUserDefaults(obfuscatedUUID: String, …)
Prerequisites  = .whitelistedAccount | .developmentBuild | .whitelistedAccountOrDevelopmentBuild
THCFeatureToggles.isFeatureEnabled(_:overridenEmailAddress:) / .setFeatureEnabled(_:_:)
                  .isEmailAddressWhitelistedForInternalFeatures / .checkWhitelist(forEmailAddress:)
                  .visibleFeatureSets / .canToggleFeatureSet(_:) / .clearFeatureEnabledCache()
```

### 5.2 `mcpServer`'s own definition

Disassembled from the flag's `swift_once` initializer at `0x1555e4` (arm64):

```
name       = "MCP Server"                                                  (small string, count 10)
activation = .explicitThroughUserDefaults(                                 (enum tag 0x02)
               obfuscatedUUID: "88c69644b0ee3912446353d03e99de8c")         (count 0x20)
```

The 32-hex constant sits at `0x544230`, and the store at `[x8+0x11] = 0x02` is the `Activation` discriminator — the case that `isFeatureEnabled` handles by calling `FADeobfuscatedUUID` (§5.3). **HIGH confidence.**

### 5.3 How an obfuscated id becomes a defaults key

`THCFeatureToggles.isFeatureEnabled` (`0x3a62b8`, real work in the mutex closure at `0x3a6ef8`) does, on the `.explicitThroughUserDefaults` branch:

```
key   = FADeobfuscatedUUID(obfuscatedUUID)          ; 0x3a98a8
value = <userDefaults> valueForKey: key.UUIDString  ; note: KVC, not objectForKey:
```

and `FADeobfuscatedUUID` is, verbatim from the disassembly:

```
data = NSData(hexadecimalRepresentation: hex)        ; 32 hex chars -> 16 bytes
for i in 0..<data.count:  data[i] ^= key12[i % 12]   ; key12 = __FAStringObfuscationDefaultKey
require data.count == 16
return NSUUID(UUIDBytes: data)                       ; the defaults key is a UUID string
```

`__FAStringObfuscationDefaultKey` is a 12-byte constant present six times in the binary, byte-identical at every copy. The sibling `FADeobfuscatedString` (`0x1cc24`) is the same XOR against the same key, terminating in a UTF-8 `NSString` instead of an `NSUUID` — this is Cultured Code's general string-obfuscation primitive, and the feature ids are one user of it.

**So: the enabling condition is an `NSUserDefaults` boolean whose key is a UUID derived by XOR from `88c69644b0ee3912446353d03e99de8c`.** The derivation is fully determined by the two constants above; this document deliberately does not print the resulting UUID, and the phase-2 script (§8) **derives it at run time from the guest's own copy of the binary** instead of carrying it. That is a speed bump, not a secret — but writing an undocumented Cultured Code flag key into a public repository is not this project's business, and the recipe reproduces it in one line.

### 5.4 Which defaults domain

`ThreadUnsafeFeatureToggles.init` (`0x3a8d84`) picks the domain on an `NSProcessInfo`-derived boolean:

```
if <processInfo predicate>  -> NSUserDefaults.standardUserDefaults
else                        -> NSUserDefaults.thingsAppGroupUserDefaults   (an FA category)
```

The predicate is a stripped local symbol. Given that `THCFeature` carries an `enabledInUnitTests` field, the overwhelmingly likely reading is *"running under XCTest → standard defaults; otherwise → the app-group suite"*, i.e. production reads **`NSUserDefaults(suiteName: "JLMPQHK86H.com.culturedcode.ThingsMac")`**. **MEDIUM-HIGH confidence.** The phase-2 recipe sidesteps the ambiguity by writing **both** domains — it costs one extra command.

### 5.5 Visibility — why there is probably no UI switch for it

`THCFeatureToggles.visibleFeatureSets` / `canToggleFeatureSet` exist, so Things has a hidden Feature Toggles panel. But the toggles are gated: `isEmailAddressWhitelistedForInternalFeatures` plus `Prerequisites.{whitelistedAccount, developmentBuild, whitelistedAccountOrDevelopmentBuild}`, and `mcpServer`'s own `visibilityPrerequisites` byte is set (non-nil) in its initializer. **A search of every localized `.strings` table and every UI string in the bundle finds no "MCP", "Model Context", "assistant" or "agent" settings copy** — the only human-readable strings for this feature anywhere are the flag's own display name "MCP Server" and the tool's description. So: no shipping UI, no menu item, no URL command. The defaults key is the door. **MEDIUM-HIGH confidence** (absence of evidence in the string tables, which is strong here because every other visible feature *does* have copy).

### 5.6 What it is NOT gated on

No entitlement gates it (the bundle's entitlements, §4.1, contain nothing MCP-related and nothing new versus 3.23). No `TMSettings` column is involved — the flag lives in `NSUserDefaults`, not in the database. No Things Cloud account flag appears on the `isFeatureEnabled` path other than the *visibility* whitelist. No OS-version check appears anywhere near the component. No Sparkle/MAS channel difference — the toggle and the component are in the direct-download build we inspected.

---

## 6. Lineage — it arrived in 3.23

Searching every banked build's `ThingsCommon` and `FoundationAdditions` for `THCThingsMCPServerComponent`, `GetTodayList`, `FAMCPServer` and the flag id `88c69644b0ee3912446353d03e99de8c`:

| Build | server component | `GetTodayList` | `FAMCPServer` | flag id |
| --- | --- | --- | --- | --- |
| 3.22.11 32211007 | — | — | — | — |
| 3.22.12 32212016 | — | — | — | — |
| 3.22.14 32214000 | — | — | — | — |
| **3.23 32300036** | **present** | **present** | **present** | **present** |
| 3.23.1 32301002 | present | present | present | present |
| 3.23.2 32302001 | present | present | present | present |
| 3.23.3 32303001 | present | present | present | present |
| 3.24 32400006 | present | present | present | present |

**First appearance: Things 3.23** (the release that also redesigned the Repeat dialog — [RDLG2](rdlg2-323-recipe-cert.md)). Absent from 3.22.14.

**What changed between 3.23 and 3.24: nothing in the MCP surface.** The tool description is byte-identical in 3.23, 3.23.3 and 3.24 (same 284-character `strings` line, same md5). `ThingsCommon`'s MCP symbol set differs only by outlined `__swift_memcpy*` helpers, i.e. a compiler artifact. The only real diff is inside `FoundationAdditions`, and it is a **generalization refactor, not an MCP change**: `FAJSONRPCValue` → `FAJSONValue`, with `FAJSONRPCValueEncoder`/`Decoder` and `FAJSONRPCCustomValue{En,De}codable` dropped in favour of `FAJSONValueEncoder`/`Decoder`. The JSON value type stopped being JSON-RPC's private property and became a shared one — the sort of thing you do when a second consumer shows up.

Protocol version `2025-06-18` is already present in 3.23. It has not moved.

---

## 7. Read-only host observations (2026-09-14)

Five commands, all read-only, none of them touching Things:

| Observation | Result |
| --- | --- |
| `pgrep -lf Things` | `/Applications/Things3.app/Contents/MacOS/Things3` running (plus this project's own deputy and reader) |
| `launchctl list \| grep -i cultured` | one entry: `application.com.culturedcode.ThingsMac.…` — the running app's own session job. **No MCP-related launchd job.** |
| `lsof -U \| grep -i 'mcp\|culturedcode'` | one hit, and it is **not Things**: VS Code's own `…/T/mcp-XXXXXX/mcp.sock`. |
| `lsof -U -a -p <Things pid>` | **zero unix-domain sockets.** |
| `defaults read com.culturedcode.ThingsMac` | `Error: Domain '…/Library/Containers/com.culturedcode.ThingsMac/Data/Library/Preferences/com.culturedcode.ThingsMac' not found.` — not readable from this terminal. Not worked around. |

**The MCP server is not running on the maintainer's host**, which is what §5 predicts for a machine that has never had the flag written. The app-group defaults suite, where the flag would live, is inside the TCC-protected Group Container and was not read.

---

## 8. Phase 2 — the guest probe, designed (NOT run)

Blocked only on golden availability (the GV5 recertification). Script: `lab/scripts/research-mcpsrv1.sh` — written, **not executed**.

**Arm.** One disposable clone of **`things-lab-golden-v5`** once it is minted, else **`things-lab-golden-v4`** — the server is byte-for-byte the same code on 3.23, so v4 answers every question here and v5 only adds a 3.24 confirmation. Airgapped, clock pinned inside the trial wall, fixtures fully synthetic. **Direct execution is correct for this probe** (lab probes are direct by design); nothing here is a shipped operation, so no routed arm is required.

**Steps.**

1. **Baseline.** List the Group Container; confirm **no** `mcp.sock`. Confirm the Things process' open unix sockets = 0.
2. **Derive the key, in the guest, from the guest's own binary** — read the 12-byte `__FAStringObfuscationDefaultKey` and the flag id out of `/Applications/Things3.app/…/ThingsCommon`, XOR, format as a UUID. (The script carries the *recipe*, not the key.)
3. **Flip it.** `defaults write <app-group-suite> "<UUID>" -bool true` **and** `defaults write com.culturedcode.ThingsMac "<UUID>" -bool true` — both domains, because §5.4 is MEDIUM-HIGH, not HIGH. Quit and relaunch Things (the flag has a `requiresQuittingAppUponChanging` field; relaunching costs nothing and removes the question).
4. **Look for the socket.** Poll the container for `mcp.sock` (bounded, ~30 s). Record `stat` — mode, owner — and the process' socket list. *If it does not appear, that is the finding*: the flag is necessary but not sufficient, and the next question is what else `update()` requires (most plausibly a non-nil `databaseURL`, i.e. a database that has finished opening).
5. **Speak MCP.** A dependency-free node script over `net.connect(path)`, NDJSON framing, in order:
   - `initialize` with `{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcpsrv1-probe","version":"0"}}` → capture the whole result verbatim (server name/version, capabilities, whether `instructions` really is absent).
   - `notifications/initialized`.
   - `tools/list` → **the full catalog with schemas**, and whether `nextCursor` appears at the tool-list level.
   - `tools/call` `GetTodayList` with no arguments → the ThingsJSON shape of a **synthetic** Today list.
   - `tools/call` `GetTodayList` with the returned cursor until `nextCursor` is absent, against a seeded ~40-item Today list, to measure the page size and confirm the cursor contract.
   - **Cursor expiry**: hold a cursor, sleep past the `expiryTask` window, re-call → expect *"Cursor is invalid or has expired."* Records the actual TTL.
   - **Negative probes**: `tools/call` with an unknown tool name; `tools/call GetTodayList` with `{"cursor": 123}` (wrong type) and with an extra property (the schema says `additionalProperties: false`) — does the server validate, or does the decoder just throw? `resources/list` and `prompts/list` → expect JSON-RPC method-not-found, confirming §2.1 negatively.
   - **Is it really read-only?** `tools/call` with a plausible-but-absent write name (`AddTodo`, `CreateTodo`) → tool not found, and a DB diff either side showing zero writes.
6. **Who may connect.** The probe process is an unsigned `node` descended from sshd. If it connects at all, that settles "no peer-credential check" empirically as well as statically. Then repeat from a **second** user account in the guest if one exists (expectation: blocked by container permissions, not by the server).
7. **DB oracle either side of everything** — row counts and `max(userModificationDate)` from the guest's `main.sqlite`, to prove no session wrote anything.
8. **Teardown**: delete the clone. Nothing about this campaign is a shipped operation and nothing leaves the guest but the transcript.

**Evidence to capture**: the raw NDJSON transcript of every exchange (the single most valuable artifact), `stat` of the socket, the tool list with schemas verbatim, one page and one full pagination of a synthetic Today list, the measured cursor TTL, the error text for each negative probe, and the DB diff.

**The capability-matrix consequence, if it works.** A working `GetTodayList` is a **first-party, structured, officially-encoded read of exactly one list**, reached without SQLite and without a consent ceremony — but it is (a) behind an undocumented flag Cultured Code has not shipped a switch for, which makes it unfit for a consumer surface on its own, (b) narrower than what we already read (Today only, versus the whole database), and (c) reached through a Group Container path that is TCC-protected anyway, so it buys no permissions relief over the reader we ship. Its real value would be as a **ThingsJSON encoding oracle**: the app's own canonical serialization of its own rows, to check our read shapes against. That is worth a matrix note either way; a *new vector row* is only warranted if phase 2 shows it working without the flag, or with tools we have not seen. **No write vector is in prospect** — there are no write tools.

---

## 9. Reproducing this

```bash
unzip -q /Volumes/Workspace/things-releases/Things3-3.24-32400006.zip -d /tmp/v324
APP=/tmp/v324/Things3.app
TC=$APP/Contents/Frameworks/ThingsCommon.framework/Versions/A/ThingsCommon
FA=$APP/Contents/Frameworks/FoundationAdditions.framework/Versions/A/FoundationAdditions

# the component map
nm -arch arm64 -a "$TC" | awk '{print $NF}' | grep -i MCP | xcrun swift-demangle
nm -arch arm64 -a "$FA" | awk '{print $NF}' | grep -E 'FAMCP|FAJSONRPC' | xcrun swift-demangle

# the tool description, the cursor description, the schema literals
strings -a "$TC" | grep -E "Today list in Things|Opaque pagination cursor|Cursor is invalid"

# the protocol version and the method names (cstrings + small-string immediates)
strings -a "$FA" | grep -E '^(tools/(list|call)|notifications/|initialize|protocolVersion|jsonrpc)$'
grep -a -o '2025-06-' "$FA" | head -1          # plus "18" in the adjacent immediate

# the socket path and the app group
strings -a "$TC" | grep -x 'mcp.sock'
codesign -d --entitlements :- "$APP" 2>/dev/null | tr ',' '\n' | grep -A2 application-groups

# the feature flags, and the mcpServer flag's initializer
nm -arch arm64 -a "$TC" | awk '{print $NF}' | xcrun swift-demangle \
  | grep -E '^static ThingsCommon\.THCFeature\.[a-zA-Z]+ :'
xcrun llvm-objdump --arch-name=arm64 -d --no-show-raw-insn "$TC" \
  | sed -n '/^ *1555e4:/,/^ *1556d0:/p'

# lineage
for z in /Volumes/Workspace/things-releases/Things3-*.zip; do
  printf '%s ' "$(basename "$z")"
  unzip -p "$z" 'Things3.app/Contents/Frameworks/ThingsCommon.framework/Versions/A/ThingsCommon' \
    | grep -a -c THCThingsMCPServerComponent
done
```

The `__swift5_fieldmd` parse (§2.2, §5.1) is a ~40-line Python walk of the section: each descriptor is `{ i32 mangledTypeName, i32 superclass, u16 kind, u16 recordSize = 12, u32 numFields }` followed by `numFields × { u32 flags, i32 mangledTypeName, i32 fieldName }`, every pointer relative to its own slot; symbolic references (`\x01` + i32) resolve to a nominal type descriptor whose name is a relative pointer at `+8`.

**No step in this document launches Things, connects to a socket, writes a default, or reads the maintainer's database.**
