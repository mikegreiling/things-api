# URLEN1 — "Enable Things URLs": where the switch lives, and what the app does when it is off

**Probed under: `things-lab-golden-v4` · Things 3.23 (build 32300036) · DB v27 · macOS 15.7.7 · guest clock pinned 2026-07-05 (never rolled — the trial wall is 2026-07-18).** One disposable clone (`urlen1-lab`), destroyed at the end. All fixtures synthetic (`URLEN1-*`). Driver: [`lab/scripts/research-urlen1.sh`](../../lab/scripts/research-urlen1.sh):

```sh
TART_HOME=/Volumes/Workspace/tart bash lab/scripts/research-urlen1.sh setup   # clone + boot + airgap + clock pin + ship the CLI
                                                           … run              # phase 1: GOLD / PREF / FREE / OFF-* / FRESH / REEN
                                                           … run2             # phase 2: the never-asked state, the park, late-apply
                                                           … run3             # phase 3: the CORRECTED disabled arm, Cancel, stacking
                                                           … teardown
```

Occasioned by **[#611](https://github.com/mikegreiling/things-api/issues/611)**: on a freshly onboarded machine, a `things project update … --clear-deadline --notes …` reported `verify-failed:silent-noop` with every grant held and the helpers routing. The suspicion was Things' own Settings ▸ General ▸ **"Enable Things URLs"**. This campaign establishes where that setting lives, whether it can be read without a consent dialog, and exactly what the app does to each URL verb when it is not on.

---

## Verdicts

| # | Question | Answer |
|---|---|---|
| 1 | Where does the toggle live? | `uriSchemeEnabled` in **`~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/Library/Preferences/JLMPQHK86H.com.culturedcode.ThingsMac.plist`** — and **nowhere else** |
| 2 | Is there a consent-free copy? | **No.** The un-TCC'd user domain holds only window frames and Sparkle keys. The one authoritative copy is inside the group container (app-data class) |
| 3 | What does a disabled app do to a URL mutation? | **NOT a silent drop.** It raises its own **"Things URL Scheme" alert** and **PARKS** the command behind it |
| 4 | Is the alert a window? | **No — an `AXSheet` on the main window.** A window census is blind to it |
| 5 | Does a parked command apply LATE? | **YES.** Clicking Enable runs the command that was dispatched minutes earlier |
| 6 | Do never-asked and explicitly-disabled differ behaviorally? | **No.** Same alert, same park, same late-apply. Only the key reading differs (absent vs `0`) |
| 7 | Are navigation URLs gated? | **No.** `things:///show` works untouched with the setting off |
| 8 | Do the alerts stack? | **Yes** — one per dispatched command, nested, none self-dismissing |
| 9 | Why has the rig never hit this? | The golden was minted with the setting already **on** (`uriSchemeEnabled => 1` in the untouched baseline) |

Cell tally: phase 1 PASS=4 FAIL=1 (the REEN failure is explained in §7 — it is an artefact of the blind oracle, not an app finding), phase 2 PASS=1 FAIL=0, phase 3 PASS=4 FAIL=0.

**Beeps.** Phase 2: **0**. Phase 3: **0**. Phase 1: **17** (report-only). All seventeen are downstream of the same blind spot: with alert sheets standing, `⌘,`, `⌘W` and Escape are swallowed and the app beeps. They are the audible signature of the bug this campaign found, not of a mis-drive — and once phase 3 force-killed the app to reach a sheet-free state, the count went to zero and stayed there.

---

## 1. The toggle's durable home (cell PREF)

Baseline (untouched golden), the whole preferences surface dumped and grepped for `url|scheme|uri`:

```
### plist-group-container
      "uriSchemeEnabled" => 1
### TMSettings
  uriSchemeAuthenticationToken = <redacted>
```

(The token is redacted here as a matter of course — it is only a disposable clone's, but no credential-shaped string is committed. It is also the point of Phase 21b's rule: the token sits in `TMSettings` regardless of the setting's state, so a populated token has never implied the scheme is enabled.)

Driving the Settings checkbox by AX (`AXCheckBox` `ttl="Enable Things URLs"` `id=_NS:129`, `AXPress`, value `1 → 0`, `AXError=0`) and re-dumping every surface produced exactly one semantic delta:

```
### plist-group-container
-      "uriSchemeEnabled" => 1
+      "uriSchemeEnabled" => 0
```

Nothing else moved but window frames and `importantInformationLastForegroundDate`. The value **survives a quit and relaunch** (`urls-off` → `urls-off-relaunched`: no delta on the key; the Settings checkbox still reads 0).

**No `-currentHost` domain exists** (`Domain com.culturedcode.ThingsMac does not exist`), and the app-sandbox container path is empty — Things is not sandboxed here.

## 2. Reading it is NOT free of the app-data class (cell FREE)

This is the finding that shapes the fix. The brief hoped for an un-TCC'd copy in `~/Library/Preferences`, which is ordinarily un-gated. There is none:

```
### defaults-read-com.culturedcode.ThingsMac
      "NSWindow Frame MainWindow-…" = "44 59 935 664 0 0 1024 743 ";   (×8)
      SUEnableAutomaticChecks = 0;  SUHasLaunchedBefore = 1;  SULastCheckTime = …;
      SULastProfileSubmissionDate = …;  SUSendProfileInfo = 1;  SUUpdateGroupIdentifier = 722442228;
```

Window frames and Sparkle. Per-key probes for every plausible spelling — `URLSchemeEnabled`, `EnableURLScheme`, `URLScheme`, `ThingsURLsEnabled`, `URLSchemeIsEnabled` — all answer *"The domain/default pair … does not exist"*. The single authoritative copy is the group-container plist, which is the same `kTCCServiceSystemPolicyAppData` class as the database.

**Consequence for the shipped reader.** The read must never be attempted speculatively — that is the Article I corollary. It rides one of the standings that already covers the container:

| standing | how the plist is reached |
|---|---|
| `helpers` | the reader's security-scoped bookmark is over the **group-container root** (`locateCandidates` scans it for `ThingsData-*`), so `Library/Preferences/…plist` is inside the granted subtree and `read-file` serves it with no host grant in play |
| `direct-fda` / `session-grant` | a plain read, already covered |
| anything else (incl. `explicit-db`) | **not read at all** — the verdict is `unreadable`, and `unreadable` is permissive |

## 3. The disabled arm — the correction (cells OFF-*, then P3-*)

**Phase 1 got this wrong and phase 3 fixed it.** Phase 1 censused *windows* after each URL and saw nothing but the ordinary Today windows, and so recorded "explicitly-off is a total silent drop, no dialog". Re-reading phase 1's own AX dumps overturned it — the count of `Things URL Scheme` occurrences climbs monotonically across the very cells that reported "no dialog":

| dump | occurrences |
|---|---|
| `off-add-after` | 1 |
| `off-upd-after` | 2 |
| `off-json-after` | 3 |
| `off-show-after` | 3 *(no increment — navigation is not gated)* |
| `off-2-after` | 4 |
| `off-fg-after` | 5 |
| `fresh-add-after` | 7 |
| `fresh-add2-after` | 8 |

The alert is an **`AXSheet`** hanging off the main window, not a window:

```
[30] role=AXSheet | desc=alert | id=_NS:91 | @[382,244 260x246]
  [1] role=AXImage      | desc=Things alert | id=_NS:35
  [2] role=AXStaticText | val=Things URL Scheme | id=_NS:78
  [3] role=AXStaticText | val=Things has been opened via the URL Scheme. Do you want to enable
                              this feature? You can change it later in Settings → General. | id=_NS:58
  [4] role=AXButton     | ttl=Cancel | id=action-button-2
  [5] role=AXButton     | ttl=Enable | id=action-button-1
```

Phase 3 re-measured the arm cleanly — `defaults write … uriSchemeEnabled -bool false`, `pkill -x Things3`, relaunch, **`SHEETS=0`** confirmed before anything was dispatched — with a sheet-aware oracle:

| cell | gesture | rows | sheets | key |
|---|---|---|---|---|
| P3-DIS1 | `things:///add` | 3 → **3** | 0 → **1** | 0 |
| P3-CANCEL | press **Cancel** | 3 → **3** (discarded) | 1 → **0** | **still 0** |
| P3-DIS2 | `things:///add`, then press **Enable** | 3 → **4** | 1 → **0** | **0 → 1** |
| P3-NAV | `things:///show?id=today` | — | **0** | 0 |
| P3-STACK | three adds in a row | — | **3** (nested) | 0 |

So, for a mutating URL with the app not authorized:

- `open -g` **exits 0**; nothing lands; there is nothing to wait for and no error anywhere.
- The command is **held**, not dropped. **Cancel discards it** (and leaves the setting off). **Enable runs it** — the row appears — and flips `uriSchemeEnabled` to `1`.
- Every further command adds another sheet. Nothing self-dismisses, and with sheets standing the app will not take `⌘,`, `⌘W` or Escape and will not quit gracefully.

## 4. The never-asked arm (cells FRESH, P2-*)

Deleting only the key (`defaults delete … uriSchemeEnabled`, app quit, `killall cfprefsd`) reproduces the *reading* but not a fresh app: the Settings checkbox then renders **unchecked** (`VALUE=0` — so absent ≡ off in the app's own UI), and a URL behaves exactly as the disabled arm.

Moving the **entire** group-container prefs plist aside reached the state properly. The first URL after that relaunch raised the same "Things URL Scheme" sheet, and P2-PARK then measured the load-bearing question:

- `URLEN1-p2-first` was dispatched at ~12:09 and did **not** appear.
- ~60s later, `AXPress` on `Enable` (`AXError=0`).
- The row count went **1 → 2** and `URLEN1-p2-first` appeared. `uriSchemeEnabled` became `1`.

**A parked command APPLIES LATE.** A write the CLI has already reported as `verify-failed:silent-noop` can still land afterwards, whenever somebody answers the alert. P2-AFTER then confirmed ordinary operation resumed (a plain add landed immediately).

Between "never asked" and "explicitly disabled" there is **no observable behavioral difference** and **no on-disk discriminator beyond the key itself** — the key sets in both dumps are otherwise identical. The three-valued state machine is three *readings* (`1` / `0` / absent) over two *behaviors* (authorized / held).

## 5. Reproducing #611 through the shipped CLI (cell OFF-CLI)

With the setting off, `things todo update <uuid> --notes …` returned exit 3:

```json
{"kind":"verify-failed","reason":"silent-noop", … "assert":[{"field":"notes","equals":"URLEN1-cli-notes"}],"observed":{"notes":""}}
```

Verbatim #611. `things doctor` in the keyless state already reported the state correctly (`url scheme: unknown — 'Enable Things URLs' has never been toggled…`) — the information was on screen in `doctor` and nowhere near the write.

## 6. Why the rig never hit it (cell GOLD)

The untouched golden reads `uriSchemeEnabled => 1`: whoever minted the image answered the alert during the build, and every clone inherits that byte through APFS COW. A `things:///add` on the pristine clone landed on the first try (GOLD, PASS). The lab has therefore only ever exercised the authorized arm, and no suite asserts the setting — which is why an entire vector's precondition went unmodelled until a fresh user machine met it.

## 7. Harness lessons

**A window census is not a modal census.** `AXChildren` of the application element lists windows; a sheet is a child *of a window*. Every oracle that answers "did a dialog appear?" by counting windows — including this campaign's first two phases, and the disruption tier's `window-new` signal — is blind to an `AXSheet`. The driver now carries an `ax sheets` verb that walks the whole tree for `AXRole == AXSheet` and prints each one's text and buttons; anything asking that question should use it. This is also the standing reminder that a **negative** result from an unproven oracle is not evidence (the CNCAC1 positive-control law, in its detection form).

**Phase 1's REEN failure was this blind spot, not an app behavior.** By the time REEN ran, eight sheets were stacked; the graceful `quit` could not complete, `⌘,` never opened Settings, the checkbox press had no checkbox to land on, and the re-enable add did not land. Phase 3, which force-kills to a sheet-free state before each arm, re-established the same fact cleanly (P3-RESTORE, PASS).

**Restoring a "fresh install" state needs the whole plist, not the key.** Deleting `uriSchemeEnabled` alone leaves the app in the disabled arm; `mv`-ing the plist aside (and killing `cfprefsd`, which promptly rewrites the rest of it from cache) is what brings the first-use alert back.

## 8. Build certification (cell CERT-*, phase `cert`)

The shipped `dist/` pushed back into the same clone and run against the app, **16/16 PASS, 0 beeps, 0 crash reports**. The assertion that only this campaign could make is the third one in each refusal row: **zero sheets** — proof that nothing was dispatched, not merely that nothing landed.

| arm | key | doctor row | `things todo add` / `update` | rows | sheets |
|---|---|---|---|---|---|
| CERT-OFF | `0` | `url-scheme  disabled` | **exit 4** `blocked:environment`, `likelyCause: feature-disabled` | unchanged | **0** |
| CERT-NEVER | absent | `url-scheme  never-asked` | **exit 4**, same shape | unchanged | **0** |
| CERT-ON | `1` | `url-scheme  enabled` | **exit 0**, `vector: url-scheme`, `tier: 0`, undo token issued | **+1** | **0** |

The refusal as the caller sees it:

```json
{"code":"blocked:environment",
 "message":"this operation is delivered as a Things URL, and nobody has answered Things' own
            'Things URL Scheme' dialog on this machine — the app holds the first URL command
            behind it, and a command dispatched now waits there instead of running",
 "likelyCause":"feature-disabled",
 "remediation":"turn on Things ▸ Settings ▸ General ▸ Enable Things URLs, then retry;
                or send one `things:///` command while you are at the machine and click Enable"}
```

`things setup --dry-run` reported the new leg in every arm (`things urls: disabled — …` / `never-asked — …`) and, correctly, still raised nothing.

## 9. What shipped from this

- `urlSchemeCapability()` in `src/capability.ts` — four verdicts (`enabled` / `disabled` / `never-asked` / `unreadable`), the plist read gated behind a read standing that already covers the container.
- A pre-dispatch **URL-scheme gate** in the mutation pipeline, keyed on the vector's `dispatchesUrls` declaration: a not-enabled app is refused with the Settings path before any URL is opened, so no sheet is raised on an unattended screen and no write is left parked.
- `things setup` grows leg (d), which detects the setting and says what to flip.
- `doctor` reports the four-valued verdict in its vector table.
- The `verify-failed:silent-noop` hint (which now fires on `unreadable` as well) warns that a parked command **can still land**, and says to verify before resending.
