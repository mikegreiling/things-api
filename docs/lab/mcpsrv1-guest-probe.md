# MCPSRV1 phase 2 — flipping the flag in a guest: the socket does not come up

**Immutable evidence snapshot.** Golden **`things-lab-golden-v5`**, Things **3.24 build 32400006**, macOS **15.7.7**, database version **29**, guest clock pinned to **2026-07-05 12:00** (inside the 2026-07-18 trial wall), airgapped. Run date **2026-09-14**. One disposable clone (`mcpsrv1-lab`), deleted at the end; the goldens were never booted. Fixtures fully synthetic.

Phase 1 — [mcpsrv1-static-recon.md](mcpsrv1-static-recon.md) — read Things' own in-process MCP server out of the bundle and designed this probe in its §8. This document is the result of running it.

**Method:** `lab/scripts/research-mcpsrv1.sh` (cells `setup` / `baseline` / `flip` / `control` / `diff` / `teardown`), plus static re-verification of the key derivation on the host against the extracted 3.24 bundle. Everything mutating happened inside the guest; nothing touched the maintainer's Things.

---

## 1. The verdict, in one paragraph

**The defaults flag is necessary but not sufficient, and the socket never came up.** The `THCFeature.mcpServer` activation key derives correctly — confirmed twice, by two independent implementations, one of them reading the guest's own binary — and writing it lands in the app's *real* preferences home, the app-group container plist, where it survives a full quit and relaunch. Things then starts, opens its database, builds its windows, and holds **zero unix-domain sockets**. No `mcp.sock` appears, under any of four candidate defaults domains, under all four at once, as a boolean or as an integer, under a background launch or a full activation with a sixty-second settle. And the same is true of **two other `.explicitThroughUserDefaults` feature flags** with visible oracles: they do not flip either. So this is a property of the feature-toggle machinery on a stock, account-less build — not something peculiar to `mcpServer`. **Cells D–H (handshake, `tools/list`, `GetTodayList`, pagination, cursor TTL, the negatives, latency) did not run: there was nothing listening to run them against.**

The consequence for us is the plain one: **Things' MCP server is not a read vector we can reach**, and the capability-matrix note phase 1 wrote stands unchanged and now rests on measurement rather than prediction.

---

## 2. What was seeded, and the baseline

The golden's own `LAB-*` fixture set, plus 39 synthetic `MCP1-*` rows created for this probe: 28 plain Today to-dos (to force pagination), a Today project in a new area with a heading and two Today children, one "rich" to-do (notes, two tags, a deadline, a two-item checklist), an overdue-deadline to-do, an evening to-do, a completed one, a cancelled one, and two more turned into daily repeating templates through the UI vector — `make-repeating` being the only way to express a repeat rule, since ThingsJSON cannot. 80 `TMTask` rows in total.

**Cell A — baseline, flag off:**

```
container:      (no socket)
socket stat:    (no socket)
Things sockets: 0
unix socket list:
db mark:        80/12/1783257257.03586
```

`lsof -U -a -p <Things pid>` returns nothing at all. This reproduces, inside a guest, the read-only host observation recon §7 made on the maintainer's machine.

---

## 3. Cell B — the key derives, and it is right

The guest derived the key from its own copy of `ThingsCommon`, following recon §5.3: locate `__FAStringObfuscationDefaultKey`, XOR the 32-hex flag id against it byte-by-byte modulo 12, format as a `NSUUID` string. It produced a well-formed uppercase UUID.

**This document does not print that UUID, for the same reason recon §5.3 did not:** writing an undocumented Cultured Code flag key into a public repository is not this project's business. The recipe reproduces it in one line and the script derives it at run time; the value lives only in gitignored `lab/artifacts/`.

Because the whole campaign turns on that one constant, it was verified two further ways:

1. **An independent host-side implementation** with a proper Mach-O `vmaddr → fileoff` map (rather than the guest script's `vmaddr == fileoff` assumption) read all **seven** copies of `__FAStringObfuscationDefaultKey` in the 3.24 arm64 slice, found them byte-identical, and produced the same UUID as the guest. (The 12-byte constant is not printed here either — with the flag id, which phase 1 does publish, it *is* the key.) The assumption was safe anyway — every copy sits in `__TEXT`, where `vmaddr` and `fileoff` coincide.

2. **`FADeobfuscatedUUID` was disassembled** (ThingsCommon `0x3a98a8`) and matches the recon description exactly:

```
NSData dataWithHexadecimalRepresentation: <hex>   ; 32 hex -> 16 bytes
mutableCopy; for i in 0..<length:
    x8 = (i / 12) * (-12) + 0x4e2e6a              ; key base, i.e. key[i % 12]
    data[i] ^= key[i % 12]
require length == 16 -> NSUUID UUIDBytes:
```

`0x4e2e6a` is one of the seven symbol addresses — the loop indexes the very constant we read. The derivation is not in doubt.

---

## 4. Cell C — every domain, every value type, every launch shape

Recon §5.4 rated the defaults domain MEDIUM-HIGH, not HIGH, so the probe tried the candidates one at a time, **quitting Things and killing `cfprefsd` before each write** — a write made while the app is running is not a fair test, because `cfprefsd` holds the app's cached preferences and rewrites the plist on quit.

| Domain written | Key readable after relaunch | `mcp.sock` |
| --- | --- | --- |
| `defaults write JLMPQHK86H.com.culturedcode.ThingsMac <key> -bool true` | yes | **no** |
| the app-group container plist by path (`…/Group Containers/<group>/Library/Preferences/<group>.plist`) | yes | **no** |
| the app sandbox container plist by path (`…/Containers/com.culturedcode.ThingsMac/Data/Library/Preferences/…`) | yes | **no** |
| `defaults write com.culturedcode.ThingsMac <key> -bool true` | yes | **no** |
| all four at once, `-bool true` | yes | **no** |
| all four at once, `-int 1` | yes | **no** |

**One trap is worth naming, because it would have produced a false "the key is set".** A shell `defaults write JLMPQHK86H.com.culturedcode.ThingsMac …` does **not** write into the app group container — it lands in `~/Library/Preferences/JLMPQHK86H.com.culturedcode.ThingsMac.plist`, a file the sandboxed app does not read. Reading the key back through the same suite name therefore succeeds while telling you nothing. The decisive check is `plutil -p` on the group-container plist itself, and it was made: the key **is** present there, alongside the app's own settings —

```
"<the derived UUID>" => 1              (redacted; the value lives only in gitignored lab/artifacts/)
"uriSchemeEnabled" => 1
"onboardingDidComplete" => 1
"THCDataFolderCurrentDataFolderPath" => "ThingsData-PO6VT"
```

— and it is **still** present after the app has quit and relaunched. Things reads this file; the key is in it; the server does not start.

Nor is it a matter of the app being half-awake. The last attempt used `open -a Things3` (not `-g`), followed by an explicit `activate` and a sixty-second settle:

```
windows: 2
socket: no-socket
=== all unix sockets held by Things ===
                                        <- empty
=== container listing ===
.com.apple.containermanagerd.metadata.plist
Library
ThingsData-PO6VT                        <- no mcp.sock
```

`log show --predicate 'process == "Things3"'` across the launch mentions neither MCP nor a feature toggle nor a socket.

---

## 5. The control — it is not an mcpServer-specific gate

A negative flip result has two very different explanations: *we have the wrong domain*, or *the defaults-key mechanism does not work on a stock build at all*. Two other flags in the same 27-flag set use the same `.explicitThroughUserDefaults` activation and carry oracles we can read without judgement:

| Flag | Display name | Oracle |
| --- | --- | --- |
| `copySelectionAsJSON` | "Copy Selection as JSON" | an Edit-menu item |
| `experimentalNewMenus` | "Experimental New Menus" | the menu bar itself |

Their obfuscated ids come out of their own `swift_once` initializers exactly as `mcpServer`'s did (`copySelectionAsJSON` = `c82f61d3e087324553ae782c33adb4c3` at `0x15534c`; `experimentalNewMenus` = `64469cf4c3d93200595365414292c175` at `0x1554b8`), and the derivation is the same function.

Both were written into the app-group suite and Things relaunched. The Edit menu is **identical** before and after:

```
Undo, Redo, —, Cut, Copy, Paste, Move Here, Delete, Select All, Duplicate, —,
Quick Find…, Find in Text…, Find and Replace in Text…, Markdown,
Spelling and Grammar, Substitutions, Transformations, Speech, —, —,
AutoFill, Start Dictation…, Emoji & Symbols
```

and so is the menu bar (`Apple, Things, File, Edit, View, Items, Window, Help`). **No `.explicitThroughUserDefaults` flag we tried flips from outside the app.** That is the finding that generalises: the gate is upstream of any one feature.

---

## 6. Where the gate probably is (static, MEDIUM confidence)

Reading further than phase 1 did, the path from flag to socket has three links, and the break is in the third.

**Link 1 — `update()` gates on one boolean.** `THCThingsMCPServerComponent.update()` (`0x2a63a4`) reaches its listener-construction path only past

```
2a6750:  ldurb w8, [x29, #-0x88]      ; self.isEnabled
2a6754:  cmp   w8, #0x1
2a6758:  b.ne  0x2a6b14               ; otherwise: tear down / do nothing
```

So the socket exists if and only if `isEnabled` is true.

**Link 2 — `isEnabled` has exactly one writer, and it is in `Things3`.** The main binary imports `THCThingsMCPServerComponent.isEnabled.setter` and calls it from a single site (`0x1003565d8`), where the value is computed as

```
component.isEnabled = <someFeatureArray>.contains(THCFeature.mcpServer)
```

with that array **captured** by the enclosing closure (the thunk at `0x100385804` loads two context words and tail-calls). `ThingsCommon` exports `THCFeatureToggles.didChangeFeaturesEnabledNotification` and `notificationFeaturesUserInfoKey : [THCFeature]`, which is exactly the shape such an array would arrive in.

**Link 3 — `isFeatureEnabled` does read the default, and would answer correctly.** Disassembling the lock closure (`0x3a6ef8`) confirms recon §5.3 and adds the cache: the byte at feature offset `+0xb8` is `cachedValue: Bool?`, initialised to `2` (nil) — `mcpServer`'s own initializer sets it at `0x155614` — and the first thing the nil-email path does is short-circuit on it. Past that, the activation discriminator (`0x02`) routes to `FADeobfuscatedUUID` → `valueForKey:` on the app-group defaults → `swift_dynamicCast` to `NSNumber` → `boolValue`. When the default is **absent**, a fallback byte (`0x03`) makes the function return false. Nothing on this path consults an account or a build type.

So links 1 and 3 are sound and our key satisfies link 3. **The break is link 2: nothing appears to assign `component.isEnabled` at startup.** If the only writer is the change-notification observer, then the value of the defaults key at launch is simply never consulted for this component, and the feature can only be turned on by `THCFeatureToggles.setFeatureEnabled` *while the app runs* — which means the hidden Feature Toggles panel, which `canToggleFeatureSet` / `isEmailAddressWhitelistedForInternalFeatures` gate on a whitelisted Cultured Code account or a development build (recon §5.5). The control result in §5 is consistent with this, and so is the complete absence of MCP settings copy anywhere in the bundle.

**Confidence: MEDIUM.** The alternative — that the toggles read a defaults domain we have not identified — is not excluded, though four domains and a `plutil` confirmation in the app's own prefs file argue against it. Discriminating between the two is a phase-3 question; §9 records it as such.

---

## 7. Zero mutation

Full-row snapshots of `TMTask`, `TMArea`, `TMTag` and `TMChecklistItem` were taken after seeding and again after every flip, relaunch and control cell — **3433 cells each, byte-identical**:

```
snapshot baseline-rows: 3433 cells
snapshot after-rows:    3433 cells
row diff: IDENTICAL — zero mutation
db mark after: 80/12/1783257257.03586      (equal to baseline)
```

Not one organic column moved — no `userModificationDate`, no index churn. Flipping feature-toggle defaults and relaunching Things repeatedly touches the database not at all. (The write-attempt negative that would have run in cell G never got to run; `MCP1-WRITE-PROBE` count is 0 because nothing ever sent it.)

---

## 8. What this is for us

Phase 1 decided the matrix consequence in advance and phase 2 does not change it — it only moves it from prediction to measurement. Against [capability-matrix.md](../capability-matrix.md)'s read column and [design/architecture.md](../design/architecture.md):

- **It is not reachable.** This is now the first fact about it. On a stock build with no Cultured Code account, the flag cannot be flipped from outside the app, so there is no socket to speak to. Everything below is conditional on a gate we cannot open.
- **It would remove SQLite, not the consent ceremony.** The socket lives at `~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/mcp.sock` — inside the Group Container, which is TCC "App Data" territory on modern macOS, the *same* protected directory our reader already needs. A client needs Full Disk Access or the sandboxed reader's security-scoped bookmark either way. The permissions story is unchanged; only the file format on the other side of the grant would differ.
- **It covers Today, and nothing else.** One tool, one list. Our SQLite read layer surfaces every view, item detail, tags, areas, projects, search, change feeds, repeat-rule decoding and occurrence projections. `GetTodayList` is a strict, small subset.
- **ThingsJSON is their documented interchange format, and that is the whole attraction.** What the MCP server would give us that SQLite does not is the app's *own canonical serialization of its own rows* — an encoding oracle to check our read shapes against, in the format Cultured Code publishes for the `things:///json` route. What it would not give us is anything our reader lacks: ThingsJSON carries titles, notes, `when`, deadlines, tags, checklist items and container references, but no `uuid` for the items it emits, no ordering indices (`todayIndex` and the entry-cohort machinery), no `rt1_*` repeat-rule internals, no completion or modification timestamps, no trashed/tombstone state — all of which we read directly and several of which the write layer depends on. The exchange would be *their* naming for *less* data. **A comparison of the two field sets on the same rows is exactly what phase 2 would have produced, and it is the main thing the campaign still owes.**
- **No write vector is in prospect.** There are no write tools in the binary; that was settled statically and nothing here disturbs it.

**Verdict: evidence and candidate, not a shipped vector.** No new row in the vector matrix; the read-side note phase 1 added stands, amended to say the guest probe ran and the socket did not come up.

---

## 9. What phase 2 did not answer

- **Which link is actually broken** — no startup assignment of `isEnabled` (§6, favoured) versus an unidentified defaults domain. A guest probe that toggles the flag *while the app runs* and looks for the notification would discriminate, if a way to raise it without the panel can be found.
- **Everything behind the handshake.** `serverInfo` and `instructions` in practice, the `tools/list` schema verbatim, the real page size and cursor TTL, whether the input schema is validated or merely decoded, whether an unsigned `node` descended from `sshd` is accepted (statically there is no peer-credential check at all — recon §4.2), and the ThingsJSON field-by-field comparison §8 calls for. The instrument for all of it is written and unexercised: `lab/scripts/mcpsrv1-probe.js`, a dependency-free NDJSON client covering handshake, pagination to exhaustion, cursor reuse and expiry, malformed and wrong-typed arguments, unknown tools, `resources/list` / `prompts/list` / `ping`, a JSON-RPC batch, a malformed line, concurrent clients, protocol-version negotiation and cold/warm latency.
- **The stdio channel.** `FAJSONRPCChannel_FileHandle` exists in `FoundationAdditions` beside the socket acceptor (recon §2.1) and nothing in this probe touched it. How it is reached — a launch argument, an environment variable, a second entry point — is unknown.

---

## 10. An incidental finding: ThingsJSON rejects an `area` element by discarding the whole batch

Seeding the fixtures cost two clone-boots, because the first payload contained `{"type":"area","attributes":{"title":"…"}}` and **all forty items silently failed to appear**. `open -g` exited 0. Bisecting the payload showed every other group landing normally and the area element taking the batch down with it.

This is oddity #22 (CHORD2) with a different trigger — an unsupported top-level `type` rather than a nested `checklist-items` — and it is recorded there as **§22a**. The probe driver now seeds in verified batches for exactly this reason, and creates the area through AppleScript instead.

---

## 11. Reproducing this

```bash
export TART_HOME=/Volumes/Workspace/tart
bash lab/scripts/research-mcpsrv1.sh setup      # clone golden-v5, airgap, pin clock, seed fixtures
bash lab/scripts/research-mcpsrv1.sh baseline   # cell A + the row snapshot
bash lab/scripts/research-mcpsrv1.sh flip       # cells B/C: derive, try each domain, then all at once
bash lab/scripts/research-mcpsrv1.sh control    # the two control flags
bash lab/scripts/research-mcpsrv1.sh diff       # zero-mutation check
bash lab/scripts/research-mcpsrv1.sh teardown   # delete the clone
```

`speak` and `lifecycle` are wired and will run the moment a socket exists.

The host-side key verification (static, read-only, launches nothing):

```bash
unzip -q /Volumes/Workspace/things-releases/Things3-3.24-32400006.zip -d /tmp/v324
TC=/tmp/v324/Things3.app/Contents/Frameworks/ThingsCommon.framework/Versions/A/ThingsCommon
xcrun llvm-objdump --arch-name=arm64 -d --no-show-raw-insn "$TC" | sed -n '/3a98a8:/,/3a99c0:/p'   # FADeobfuscatedUUID
nm -arch arm64 -n -a "$TC" | grep __FAStringObfuscationDefaultKey                                  # the seven copies
```
