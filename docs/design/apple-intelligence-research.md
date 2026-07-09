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
- When Things adopts App Intents 2.0 schemas (see §4), its Shortcuts action catalog grows → we re-run the L5 Card-5 catalog sweep and mint new proxies for anything valuable (repeat-rule parameters would close gaps.md §2, the biggest wish-list item).
- If/when Apple ships the OS MCP bridge, our MCP tool names/semantics are already agent-facing; we'd evaluate it as a NEW WRITE VECTOR (matrix + evidence, like any other), not a rewrite.

## 4. Things-specific outlook

- Cultured Code's public blog has nothing 2026 yet (latest: "Things for OS 26", Sept 2025), but their 2024 release notes said "groundwork for Apple Intelligence," and CC historically ships day-one OS-feature adoption. Apple's task-management being a **system-defined App Intents schema domain** makes a big Things App-Intents release alongside iOS 27 GA (~Sept 14) very likely — consistent with Mike's correspondence hinting at repeat-handling changes.
- Watch items for that release, in priority order: (1) repeat-rule format (`rrv` gate + doctor canary will trip — [lab/things-update-runbook.md](../lab/things-update-runbook.md) step 7); (2) Shortcuts action catalog growth (new intents = new capabilities for the proxy fleet); (3) schema/`databaseVersion` bump (fingerprint gate); (4) whether the sdef/URL surfaces change at all (historically stable while Shortcuts grows).

## 5. Probe candidates opened by WWDC26 (queued, not yet run)

1. **App Intents Testing Framework as an invoke channel**: it drives intents "through real system pathways" without UI automation. If it can run headless against an installed app in a lab VM (likely needs Xcode tooling), it's both a better probe harness for the S-suite AND a candidate invoke path that skips proxy installation. Feasibility probe once Xcode 27 + a macOS 27 VM exist in the lab.
2. **macOS 27 beta regression** (decision: memo first — beta VM deferred): when the PUBLIC beta lands (July 2026), build a beta base VM (tart / IPSW; check cirruslabs beta images), install Things 3.22.11, run `lab:regress` — early warning on OS-side breakage months before GA. Do NOT install the beta on any host.
3. **Spotlight semantic index reads**: if Things contributes entities to the semantic index, a new READ surface may exist (query the index instead of/alongside SQLite). Low priority — SQLite reads are richer — but worth one look on the beta.

## 6. Recommendation

- **Now**: nothing to build. The hardening pass (runbook + rrv gate + canary) is the right preparation; the proxy/MCP architecture is already aligned with where Apple is heading.
- **July 2026 (public beta)**: one beta-VM regression run (probe candidate 2).
- **~Sept 2026 (iOS 27 GA + expected Things release)**: execute [things-update-runbook.md](../lab/things-update-runbook.md) in full; L5-style catalog sweep for new App Intents; revisit probe candidate 1.
- **macOS 28 horizon**: watch for the OS MCP bridge; evaluate as a write vector when real.

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
