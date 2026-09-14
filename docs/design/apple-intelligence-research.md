# Apple Intelligence & the macOS 27 agent surfaces — research memo

Written 2026-07-09 from post-WWDC-2026 sources (WWDC26 ran June 8–12, 2026; iOS 27 / macOS 27 "Golden Gate" ship publicly ~September 14, 2026). Answers Mike's questions: how do Apple Intelligence features hook into apps, can generic LLM agents use the same paths as Siri, is there a back door, and should we explore the beta.

## 1. How Apple Intelligence drives apps: App Intents is the whole story

- **SiriKit received its formal deprecation at WWDC26** — App Intents is now the ONLY way Siri calls into a third-party app.
- **App Intents 2.0** (iOS/macOS 27) adds: richer entity types, streaming responses for long-running actions, multi-turn conversational follow-ups, and the new **View Annotations API** (map views to entities so Siri has onscreen awareness).
- **App Intents schemas**: Apple ships system-defined schemas for common domains — **task management is explicitly one of them** — so an adopting app's intents need no trigger phrases and automatically improve with Siri's models. Entity schemas feed the **Spotlight semantic index** (content discoverable via natural language, attributed back to the app).
- **Siri AI chains intents across apps** (find X in messages → check calendar → book → add event) — Apple's first shipped agentic behavior, all routed through App Intents.
- New **App Intents Testing Framework**: validates Siri/Shortcuts/Spotlight integration "through real system pathways (no UI automation)" — see §5, this may matter to us directly.

**Why this matters for things-api:** our six Shortcuts proxies invoke Things' App Intents already — the extracted workflow blobs literally carry `com.culturedcode.ThingsMac.TAI*` AppIntent descriptors. Everything Apple builds on App Intents grows the surface our Shortcuts vector can reach.

## 2. Can generic LLM agents do what Siri does? No — by design (today)

The ecosystem consensus (well-argued in [App Intents vs MCP: The Routing Question](https://blakecrosley.com/blog/app-intents-vs-mcp-tools-frontier), April 2026) is that Apple maintains **two orthogonal caller classes**:

| Caller class | Framework | Who can call |
|---|---|---|
| System agents (Siri, Shortcuts, Spotlight, Apple Intelligence) | App Intents (OS-mediated, app-entitlement-scoped) | first-party runtimes only |
| External LLM agents (Claude, ChatGPT, Cursor…) | MCP tools (developer-shipped servers) | anything the host configures |

- **External agents cannot directly invoke App Intents** — invocation is system-mediated.
- iOS 27's **"Extensions"** program lets third-party models (Claude, ChatGPT, Gemini, Grok are confirmed user-selectable) act as **Siri backends** — the third-party MODEL runs inside Siri's harness and the OS still performs intent invocation. That's model-swap, not API access. (There's also a default-assistant slot: side-button → your chosen agent.)
- **MCP shipped at WWDC26 only inside Xcode 27** (an `mcpbridge` binary translating MCP over XPC into Xcode's process, plus the new Agent Client Protocol governing which agents may connect). It's developer tooling, not an OS-wide App Intents bridge.
- An OS-level MCP↔App Intents bridge is credibly rumored ("Apple takes on the heavy lifting of protocol compatibility") but at "very early stage"; realistic arrival **no earlier than iOS 27.x / macOS 28**.

## 3. The back door: we already have it, and it's the sanctioned one

**`shortcuts run` is the generic-agent gateway to App Intents**, today and on 27. Shortcuts actions ARE App Intents invocations; the Shortcuts CLI is a stable, consented, headless (for output-class actions) bridge that Apple ships. Our proxy pattern — signed `.shortcut` files wrapping one intent each, driven by a verified pipeline, surfaced over OUR MCP server — is exactly the "wrap platform capability in an MCP tool" architecture the routing-question analysis prescribes. **things-api IS the Things App-Intents-to-MCP bridge**, a year before Apple ships a generic one.

Consequences:
- When Things adopts App Intents 2.0 schemas (see §4), its Shortcuts action catalog grows → we re-run the L5 Card-5 catalog sweep and mint new proxies for anything valuable (repeat-rule parameters would fill the Repeating-items gap in the capability matrix, the biggest wish-list item).
- If/when Apple ships the OS MCP bridge, our MCP tool names/semantics are already agent-facing; we'd evaluate it as a NEW WRITE VECTOR (matrix + evidence, like any other), not a rewrite.

## 4. Things-specific outlook

- Cultured Code's public blog has nothing 2026 yet (latest: "Things for OS 26", Sept 2025), but their 2024 release notes said "groundwork for Apple Intelligence," and CC historically ships day-one OS-feature adoption. Apple's task-management being a **system-defined App Intents schema domain** makes a big Things App-Intents release alongside iOS 27 GA (~Sept 14) very likely — consistent with Mike's correspondence hinting at repeat-handling changes.
- Watch items for that release, in priority order: (1) repeat-rule format (`rrv` gate + doctor canary will trip — [lab/things-update-runbook.md](../lab/things-update-runbook.md) step 7); (2) Shortcuts action catalog growth (new intents = new capabilities for the proxy fleet); (3) schema/`databaseVersion` bump (fingerprint gate); (4) whether the sdef/URL surfaces change at all (historically stable while Shortcuts grows).

## 5. Probe plan (revised 2026-09-14, post-3.24)

Every probe below runs in a **macOS 27 Tart guest** with a synthetic library — never the maintainer's host, never his data. None is blocked on anything but building that guest, which is itself the first item.

**AI324-P0 — build a macOS 27 guest with Things 3.24.** *Method:* the golden-image drill against a 27.0 IPSW / cirruslabs image, Things 3.24 installed, synthetic seed. *Opens:* everything else here, plus the 3.24 re-certification of the assumption register (the release runbook's business, not this memo's). **Prerequisite for P1–P5.**

**AI324-P1 — is `recurrence` refused unconditionally, or only for shapes Things cannot express?** *Hypothesis:* `recurrenceUnsupported` throws on every non-nil `recurrence`, including a plain daily rule the app's own dialog can express. *Method:* the static read cannot see the branch, and the only invoker of an assistant-only intent is Siri ([AI324](../lab/ai324-app-intents-catalog.md) §5) — so the honest method is a **manual, one-shot, human-driven** Siri / Type-to-Siri utterance in the guest, with a DB diff either side. Not automatable, not a suite cell. *Opens:* if a simple weekly rule **lands**, the refusal is shape-conditional and Things has a non-GUI repeat-create path after all — the most valuable finding available here, and worth the manual drive. If it refuses, the gap is closed with certainty rather than inference and this never runs again.

**AI324-P2 — does `TAIRemindersReminderEntity.recurrence` READ back?** *Hypothesis:* the entity's `recurrence` property is always `nil`; Things does not project `rt1_recurrenceRule` into a `Calendar.RecurrenceRule`. *Method:* same manual Siri path, asking about an existing repeating to-do and observing whether the assistant knows its cadence. *Opens:* a populated value would mean the semantic index carries a lossy copy of every repeat rule in the library — worth knowing as a data-exposure fact, though not a surface we could read.

**AI324-P3 — what is a CANCELED to-do to the assistant?** *Hypothesis:* it surfaces as `isCompleted: true`, since Apple's schema has no third state while Things carries a non-schema `isCanceled` member and dedicated artwork. *Method:* seed one open, one completed and one canceled to-do; ask. *Opens:* if canceled reads as completed, that is a reproducible oddity — an app telling the system a false thing about its own data — and earns a [things-app-oddities.md](../things-app-oddities.md) section. Until then it is a declaration, not a behavior.

**AI324-P4 — what does a reminders "list" actually enumerate?** *Hypothesis:* Inbox + every area + every project + `noList`, per the `area-`/`project-`/`inbox`/`noList` identifier literals and the ten new Spotlight glyphs; and `createSection` refuses a list that is not a project (`invalidList`), because only projects hold headings. *Method:* ask the assistant to list Things lists in a seeded guest, then to create a section in an area. *Opens:* confirms or corrects AI324 §3; a `createList(type:.standard, name:)` that produces an **area** rather than a project is a modeling choice worth recording either way.

**AI324-P5 — does `hideInSpotlight` hide what we would expect?** *Hypothesis:* the synthetic `noList` bucket (and possibly the Inbox) is kept out of the Spotlight index. *Method:* seed, let `THCSpotlightIndexComponent` settle, search Spotlight in the guest. *Opens:* little on its own — run it only while P4 is already set up.

**MCPSRV1 — Things' own MCP server (not an AI324 item; its own campaign).** *Hypothesis:* `THCThingsMCPServerComponent` opens a unix socket named `mcp.sock` under the app's container when some setting or entitlement enables it, and speaks MCP with at least one paginated ThingsJSON read tool. *Method:* static first — locate the socket-path construction and the enabling condition, enumerate the `FAMCPTool` conformers and their descriptions, all from the binary. Only then, in a guest, check whether the socket appears at rest. *Opens:* if this is a real, user-enablable read surface, it is a **first-party JSON read path** needing neither SQLite nor a consent ceremony — a significant addition to the vector matrix if true, and equally possibly an internal thing that is off by default and never appears. Present in 3.23.3 and 3.24 alike, so it is not urgent; merely large if true.

**Retired.** The old probe 2 (macOS 27 *beta* regression) is moot — 27.0 is GA. The old probe 3 (Spotlight semantic-index reads) is closed negative, §7.

## 6. Recommendation

- **Now**: nothing to build. The hardening pass (runbook + rrv gate + canary) is the right preparation; the proxy/MCP architecture is already aligned with where Apple is heading.
- **July 2026 (public beta)**: one beta-VM regression run (probe candidate 2).
- **~Sept 2026 (iOS 27 GA + expected Things release)**: execute [things-update-runbook.md](../lab/things-update-runbook.md) in full; L5-style catalog sweep for new App Intents; revisit probe candidate 1.
- **macOS 28 horizon**: watch for the OS MCP bridge; evaluate as a write vector when real.

## 7. 2026-09-14: what Things 3.24 actually shipped

Things **3.24** (build 32400006) shipped the same day as macOS 27, with release notes reading, in full, "Full integration with the new Siri. Full integration with Spotlight." The catalog is extracted and version-stamped in [lab/ai324-app-intents-catalog.md](../lab/ai324-app-intents-catalog.md) (AI324 — static bundle inspection, no invocation of anything). Reconciling it against this memo:

**Held.**

- *"App Intents is the whole story"* — exactly right, and more completely than expected. Every capability in the release is an App Intents capability; the URL scheme, the sdef and the Shortcuts action list are untouched.
- *"Task management is a system-defined schema domain"* (§1) — it is, and Cultured Code adopted it **whole**: all five actions of Apple's `reminders` domain, four of its five entities, both enums, plus three `OpenIntent`s. Eight new actions, sixteen new types.
- *"Entity schemas feed the Spotlight semantic index"* (§1) — confirmed in the bundle: the three persistent reminders entities conform to `com.apple.appintents.entity.Indexed` and `…Syncable`, `ThingsCommon` links CoreSpotlight for the first time and gains a `THCSpotlightIndexComponent`, and twenty new `Spotlight-*` glyphs ship for the indexed shapes.
- *"CC historically ships day-one OS-feature adoption"* (§4) — day-zero, in fact.
- *"Watch item (3): schema/`databaseVersion` bump"* (§4) — tripped: DB v29, measured separately in [lab/dbv29-migration-diff.md](../lab/dbv29-migration-diff.md).
- *"Watch item (4): the sdef/URL surfaces stay stable while Shortcuts grows"* (§4) — half right, and the interesting half is the correction below: the sdef and URL surfaces did stay stable, but **Shortcuts did not grow either**.

**Did not hold.**

- **"New intents = new capabilities for the proxy fleet" (§4 watch item 2, and the §3 consequence) is wrong for this release.** Every one of the eight new actions is `isDiscoverable: false` **and** `visibilityMetadata.assistantOnly: true`. Apple documents both flags as hiding an intent from Shortcuts *and* Spotlight, and documents that an `AppShortcut` cannot be built over a non-discoverable intent at all. The Shortcuts action library therefore contains exactly the same fifteen Things actions it contained in 3.23.3, byte-for-byte. **The Shortcuts vector gained nothing.** The memo's §3 thesis is still true — `shortcuts run` *is* the generic-agent gateway to App Intents — but it needed a boundary it did not have: it is the gateway to the **discoverable** catalog, and Apple deliberately put the assistant-schema catalog on the other side of it. An L5-style catalog sweep for this release would have found nothing to mint.
- **"Repeat-rule parameters would fill the Repeating-items gap" (§3) — the parameter arrived and is refused.** `createReminder`/`updateReminder` declare `recurrence: Calendar.RecurrenceRule?` because schema conformance requires the full signature, and `ThingsCommon` carries a purpose-built error case, `TAIRemindersError.recurrenceUnsupported` → *"Adding a recurrence is not supported."* There is no `Calendar.RecurrenceRule` symbol anywhere in the binary. **No new non-GUI route to repeating to-dos exists**, and Apple's carrier could not have expressed Things' after-completion repeats or exceptions in any case (`Calendar.RecurrenceRule` is RFC 5545 + 7529: no completion anchor, no `EXDATE`). This is credited as craft, not filed as a defect — [things-app-craft.md](../things-app-craft.md) §12.
- **"Spotlight semantic index reads may be a new READ surface" (§5 probe 3) — closed, negative.** CoreSpotlight/`IndexedEntity` donations live in the per-app CoreSpotlight index, not the file-metadata store `mdfind`/`mdls` read; no CLI queries it, and the only documented programmatic read is team-signature-gated. The probe is retired rather than run: even a hypothetical success would return a title and a few attributes where we already read 41 columns.
- **"The App Intents Testing Framework may be an invoke channel" (§5 probe 1) — sharper than expected, and still not ours.** `AppIntentsTesting` (macOS 27.0) is genuinely out-of-process and by-name — `IntentDefinitions(bundleIdentifier:)`, `definitions.intents["X"].makeIntent().run()`, no linking — and Apple's own guide demonstrates it running an `isDiscoverable: false` intent. But it requires the test runner and the app to share a **code-signing team**, so it is Cultured Code's tool for Things, not ours. Downgraded from "candidate invoke path" to "the reason the vendor can test what we cannot".

**Not predicted at all.**

- **Things already ships an MCP server.** `THCThingsMCPServerComponent`, `THCThingsMCPSession`, `THCThingsMCPToolCallContext`, an `FAMCPTool` protocol, an `mcp.sock` socket-path literal, and at least one paginated tool returning ThingsJSON. It is **present byte-for-byte in 3.23.3** as well, so it is not part of this release — but §2's table, which put App Intents and MCP in orthogonal caller classes with Apple owning one and developers the other, missed that this particular developer had already shipped on both sides. What enables it, where the socket lives, and what the tool list is are unknown and unprobed.
- **`TAIInAppSearch` moved schemas** (`system/ShowInAppSearchResultsIntent` → `system/SystemSearchInAppIntent`) and re-floored to 27.0. Apple's rename, not a capability change, but it is the kind of churn a future sweep should expect.

## Sources

- [Apple: next generation of Apple Intelligence, Siri AI (newsroom, June 2026)](https://www.apple.com/newsroom/2026/06/apple-unveils-next-generation-of-apple-intelligence-siri-ai-and-more/)
- [Apple: new intelligence frameworks and advanced tools (newsroom, June 2026)](https://www.apple.com/newsroom/2026/06/apple-aids-app-development-with-new-intelligence-frameworks-and-advanced-tools/)
- [Apple Developer: WWDC26 Apple Intelligence guide](https://developer.apple.com/wwdc26/guides/apple-intelligence/)
- [MacRumors: WWDC26 Platforms State of the Union](https://www.macrumors.com/2026/06/09/apple-outlines-major-ai-and-developer-tool-updates/)
- [MacRumors: iOS 27 Siri app with Extensions](https://www.macrumors.com/2026/03/29/ios-27-siri-app-with-extensions-rumor/)
- [Blake Crosley: App Intents vs MCP — The Routing Question](https://blakecrosley.com/blog/app-intents-vs-mcp-tools-frontier)
- [Joche Ojeda: Xcode 27, ACP, MCP deep dive](https://jocheojeda.com/2026/06/15/xcode-27-agent-client-protocol-mcp-and-the-end-of-the-simulator/)
- [byteiota: Xcode 27 agentic coding / MCP](https://byteiota.com/xcode-27-agentic-coding-mcp-guide/), [byteiota: Siri Extensions API in iOS 27](https://byteiota.com/siri-extensions-api-ios-27-integrate-ai-app/)
- [mcp.directory: MCP integration in Apple OS (rumor analysis)](https://mcp.directory/blog/apple-prepares-revolution-mcp-integration-in-macos-ios-ipados)
- [ecorpit: iOS 27 App Intents migration guide](https://ecorpit.com/ios-27-app-intents-siri-ai-developer-guide-2026/)
- [Cultured Code blog](https://culturedcode.com/things/blog/) (nothing 2026 yet)
