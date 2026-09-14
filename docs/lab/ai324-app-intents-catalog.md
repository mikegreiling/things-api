# AI324 — the Things 3.24 App Intents catalog, extracted (static bundle inspection, 2026-09-14)

**Version stamp:** Things **3.24** build **32400006** (direct download; the Mac App Store twin is build 32400506) vs **3.23.3** build **32303001**. Host: macOS **27.0** "Golden Gate" (released the same day). Both bundles are the banked archives in `things-releases/` — `Things3-3.24-32400006.zip` and `Things3-3.23.3-32303001.zip` — unpacked to a scratch dir and read there.

**Method: STATIC ONLY.** `Metadata.appintents/extract.actionsdata` (the compiled App Intents catalog Xcode emits into the bundle) parsed as JSON; `strings -a`, `nm -a` + `swift-demangle`, `otool -L`, `PlistBuddy` and `assetutil` over the binaries and assets. **No intent, Siri, Shortcuts, AppleScript, URL-scheme or GUI invocation was performed, on any host, at any point** — this is a read of two zip files. Every claim below is therefore a claim about what the app *declares*, not about what it *does* when run; behavioral claims are flagged as such and queued as probes in [apple-intelligence-research.md](../design/apple-intelligence-research.md) §7.

**Nothing in this document derives from the maintainer's library.** Type names, parameter names, counts and Cultured Code's own English strings only.

**Build provenance (Info.plist).** 3.23.3: `DTSDKName macosx26.0`, `DTXcode 2601`, `DTXcodeBuild 17A400`, built on 25F84. 3.24: `DTSDKName macosx27.0`, `DTXcode 2700`, `DTXcodeBuild 27A266a`, built on 26A428. `LSMinimumSystemVersion` is **13.3 in both** — 3.24 still runs on Ventura; the new intents are availability-gated rather than raising the floor. The metadata generator string moves with it (`xcode-tools 17A400` → `27A266a`), which matters for reading the delta: some bits below changed because the *toolchain* changed, not because Cultured Code changed a line.

## 1. Where the catalog lives

Five `Metadata.appintents` bundles ship inside `Things3.app`. Only two are non-empty, and only one is interesting:

| Bundle | 3.23.3 | 3.24 |
|---|---|---|
| `Contents/Resources` (main app) | 0 actions | 0 actions |
| `Contents/Frameworks/ThingsCommon.framework/…` | **16 actions / 2 entities / 2 queries / 5 enums** | **24 actions / 6 entities / 6 queries / 7 enums** |
| `Contents/Frameworks/ThingsWidgets.framework/…` | 5 actions / 1 entity / 1 query | 5 actions / 1 entity / 1 query (byte-equivalent but for two widget-config default values) |
| `Contents/Frameworks/ThingsWidgetsActions.framework/…` | 1 action | 1 action |
| `Contents/PlugIns/ThingsWidgetExtension.appex/…` | 0 | 0 |

Everything below is the ThingsCommon catalog. The widget catalogs are unchanged in substance (the only diff is which `WAIPlusButtonMode` case is the default on two widget-configuration intents — a widget detail, not an automation surface).

### Type-identifier decoding

`extract.actionsdata` stores value types as small integers. Cross-checking Things' parameter names against Apple's published schema signatures (see §4) pins them:

| Wire | Type | Pinned by |
|---|---|---|
| `primitive 0` | `String` | `title`, `name`, `tags` members |
| `primitive 1` | `Bool` | `isFlagged`, `evening` |
| `primitive 8` | `Date` | `creationDate`, `completionDate` (always carry `DateFormat 2`) |
| `primitive 9` | `DateComponents` | `dueDate` — Apple's `createReminder` declares `dueDate: DateComponents?`; Things' own `startDate`/`deadline`/`reminderTime` use the same identifier with a `DateFormat` hint (0 = date, 1 = time) |
| `primitive 11` | `URL` | `urls` members, `TINRunThingsURLIntent.url` |
| `primitive 12` | `AttributedString` | `note` — Apple declares `note: AttributedString?` |
| `array cap=3` | `Array` | `urls: [URL]` |
| `array cap=0` | `Set` | `tags: Set<String>` |
| `intents 12` | `IntentFile` | `images: [IntentFile]` |
| `foundation 0` | `Calendar.RecurrenceRule` | `recurrence` — Apple declares `recurrence: Calendar.RecurrenceRule?` |

## 2. The 3.24 catalog in full

`Shortcuts?` = whether the action is reachable from the Shortcuts app's action library, and therefore from `shortcuts run` and our proxy fleet. It is `isDiscoverable` AND-ed with the absence of `visibilityMetadata.assistantOnly` — see §5 for why that is the right reading and what confidence it carries.

### 2.1 Actions — the nine that were already there (unchanged in 3.24)

All nine are `isDiscoverable: true`, `assistantOnly: false`, availability `*` (no OS floor), and their parameter lists are **byte-identical to 3.23.3**.

| Action | Summary | openAppWhenRun | Output | Parameters | Shortcuts? |
|---|---|---|---|---|---|
| `TAIAddTodo2` | Create To-Do ${title} | no | `TAIItemEntity` | title, parent, heading, start (`TAIItemStart`), startDate, evening, reminderTime, deadline, tags, status (`TAIItemStatus`), notes, checklist | ✅ |
| `TAIAddProject` | Create Project ${title} | no | `TAIItemEntity` | title, area, start, startDate, evening, reminderTime, deadline, tags, status, notes | ✅ |
| `TAIAddHeading` | Create Heading ${title} in ${project} | no | `TAIItemEntity` | title, project, status | ✅ |
| `TAIAddTodoWithQuickEntry` | Create To-Do with Quick Entry | no | — | title, parent, start, startDate, evening, reminderTime, deadline, tags, status, notes, checklist | ✅ |
| `TAIEditItems` | ${titleAction} ${detail} of ${items} to … | no | `[TAIItemEntity]` | 26 params: `items` plus a `<field>Action` / `<field>` pair per field (title, parent, start(+startDate, evening), reminderTime, deadline, tags, status, completionDate, notes, checklist, creationDate) | ✅ |
| `TAIDeleteItems` | — | no | — | entities, deleteImmediately | ✅ |
| `TAIDuplicateItems` | Duplicate ${items} | no | `[TAIItemEntity]` | items | ✅ |
| `TAIGetItems` | Get ${type} … | no | `[TAIItemEntity]` | type, todos, headings, projects, areas | ✅ |
| `TAIGetSelectedItems` | Get Selected Items | no | `[TAIItemEntity]` | — | ✅ |

Plus the four legacy Intents-framework actions Things still carries (`customIntentClassName` set, i.e. SiriKit-era intents bridged into App Intents), also unchanged: `TINAddTodoIntent`, `TINRunThingsURLIntent` (Run Things URL ${url}), `TINShowListIntent`, `TINShowTodoIntent`; and the two modern open actions `TAIShowItems2` (Show ${items}) and `TAIShowList2` (Open ${list}, + `filterByTags`). All discoverable. That is the **15-action Shortcuts-visible surface**, identical in both builds.

**No repeat/recurrence parameter appears anywhere in this group.** `TAIEditItemsDetail` — the enumeration of everything `TAIEditItems` can touch — has exactly eleven cases: title, parent, start, reminderTime, deadline, tags, status, completionDate, notes, checklist, creationDate. Unchanged from 3.23.3. The [capability matrix](../capability-matrix.md) "Repeating items" gap is untouched by the discoverable surface.

### 2.2 Actions — the one that moved

| Action | 3.23.3 | 3.24 |
|---|---|---|
| `TAIInAppSearch` | schema `system/ShowInAppSearchResultsIntent@1.0.0`, availability iOS 18.0 / macOS 15.0 | schema `system/SystemSearchInAppIntent@1.0.0`, availability iOS/macOS/visionOS **27.0** |

Both builds declare it `isDiscoverable: false` with `openAppWhenRun: true` and one `criteria` (search-criteria) parameter, and both carry `systemProtocolMetadata` `…systemProtocol.ShowInAppStringSearchResults` with `searchScopes: ["general"]`. This is the Siri/Spotlight "search inside Things for X" hook; the rename is Apple's, tracking the 27 SDK's renamed system protocol. Not a new capability, and not Shortcuts-reachable in either build.

### 2.3 Actions — the eight that are new

Every one of them: `isDiscoverable: **false**`, `visibilityMetadata.assistantOnly: **true**`, `systemProtocols: ["com.apple.link.systemProtocol.AssistantIntent"]`, availability **iOS 27.0 / macOS 27.0 / visionOS 27.0** (no watchOS, no tvOS). None has a `descriptionMetadata`, a `title`, or an action summary — the assistant supplies the phrasing, per the schema contract.

| Action | Schema | openAppWhenRun | Output | Parameters (optional marked `?`) | Shortcuts? |
|---|---|---|---|---|---|
| `TAIRemindersCreateReminderIntent` | `reminders/CreateReminderIntent@1.0.0` | no | `TAIRemindersReminderEntity` | title, list?, note?, isFlagged?, images (`[IntentFile]`, default `[]`, `public.image`), tags (`Set<String>`, default `{}`), urls (`[URL]`, default `[]`), dueDate?, **recurrence?**, locationTrigger?, section? | ❌ |
| `TAIRemindersUpdateReminderIntent` | `reminders/UpdateReminderIntent@1.0.0` | no | `TAIRemindersReminderEntity` | target, title?, note?, tags?, urls?, dueDate?, **recurrence?**, isCompleted?, isFlagged?, list?, locationTrigger? | ❌ |
| `TAIRemindersDeleteRemindersIntent` | `reminders/DeleteRemindersIntent@1.0.0` (+ `systemProtocol.DeleteEntity`) | no | — | entities `[TAIRemindersReminderEntity]` | ❌ |
| `TAIRemindersCreateListIntent` | `reminders/CreateListIntent@1.0.0` | no | `TAIRemindersListEntity` | type (`TAIRemindersListType`), name | ❌ |
| `TAIRemindersCreateSectionIntent` | `reminders/CreateSectionIntent@1.0.0` | no | `TAIRemindersSectionEntity` | name, list | ❌ |
| `TAIRemindersOpenReminderIntent` | `system/OpenIntent@1.0.0` (+ `systemProtocol.OpenEntity`) | **yes** | — | target `TAIRemindersReminderEntity` | ❌ |
| `TAIRemindersOpenListIntent` | `system/OpenIntent@1.0.0` (+ `OpenEntity`) | **yes** | — | target `TAIRemindersListEntity` | ❌ |
| `TAIRemindersOpenSectionIntent` | `system/OpenIntent@1.0.0` (+ `OpenEntity`) | **yes** | — | target `TAIRemindersSectionEntity` | ❌ |

That is **all five** actions Apple's `reminders` domain defines, plus the three `OpenIntent`s over its three addressable entities. Cultured Code adopted the domain completely.

A naming note that matters when reading Apple's docs: `reminders` is **not** one of the iOS-18-era `AssistantSchemas` domains (Books, Browser, Camera, Files, Journal, Mail, Photos, …). It lives in the newer [`AppSchema`](https://developer.apple.com/documentation/appintents/appschema) namespace — [`app-schema-domain-reminders`](https://developer.apple.com/documentation/appintents/app-schema-domain-reminders) — and the adopting macro is `@AppIntent(schema: .reminders.createReminder)`. Every action in it carries `introducedAt: 27.0` for iOS/iPadOS/macOS/Mac Catalyst/visionOS and nothing earlier, which is exactly the availability Things declares. The domain has **five** actions and no more (secondary write-ups claiming an `updateList` or `updateSection` are wrong), five entities (`group`, `list`, `locationTrigger`, `reminder`, `section`) and two enums.

### 2.4 Entities

Property names are not stored in `extract.actionsdata` (only ordered types); the names below are recovered from the Swift reflection field descriptors in `ThingsCommon` (`_title`, `_note`, … in declaration order) and line up one-for-one with the metadata's type list.

| Entity | Schema | Protocols | Properties |
|---|---|---|---|
| `TAIItemEntity` (existing) | — | — | 21 properties, unchanged from 3.23.3: type (`TAIItemType`), + 20 more (String/Bool/Date/`[String]`/`TAIItemStart`/`TAIItemStatus`). No sync, no indexing. |
| `TAIListEntity` (existing) | — | — | no `@Property`s (identifier + display only), unchanged |
| `TAIRemindersReminderEntity` | `reminders/ReminderEntity@1.0.0` | AssistantEntity, **Syncable**, **Indexed** | title, note, tags, urls, dueDate, **recurrence**, isCompleted, isFlagged, creationDate, completionDate, list, locationTrigger |
| `TAIRemindersListEntity` | `reminders/ListEntity@1.0.0` | AssistantEntity, Syncable, Indexed | name, type; plus a non-`@Property` `hideInSpotlight: Bool` |
| `TAIRemindersSectionEntity` | `reminders/SectionEntity@1.0.0` | AssistantEntity, Syncable, Indexed | name, list |
| `TAIRemindersLocationTriggerEntity` | `reminders/LocationTriggerEntity@1.0.0` | AssistantEntity (transient) | place (`GeoToolbox.PlaceDescriptorEntity`), event (`TAIRemindersLocationTriggerEvent`) |

The three persistent reminders entities carry `entitySyncMetadata.entitySyncType: 1` and `allowedTargets: [{type: 1}]`; the two legacy entities carry `entitySyncType: 0` and no `allowedTargets`. Apple's `reminders` domain also defines a `group` entity (a folder of lists) — **Things did not adopt it**, consistent with Things having no folder-of-areas concept.

### 2.5 Queries

| Query | Entity | `capabilities` 3.23.3 → 3.24 | Notes |
|---|---|---|---|
| `TAIItemQuery` | `TAIItemEntity` | 14 → **78** | has comparators (on `TAIItemType`) + sorting options |
| `TAIListQuery` | `TAIListEntity` | 6 → **70** | no parameters |
| `TAIRemindersReminderQuery` | reminder | — → **322** | `allowedTargets [{type:1}]`, 27.0-gated |
| `TAIRemindersListQuery` | list | — → **322** | ″ |
| `TAIRemindersSectionQuery` | section | — → **322** | ″ |
| `LocationTriggerEntityQuery` | location trigger | — → **66** | nested in the entity |

The bitmask decomposes cleanly: 14 = 2+4+8, 78 = 2+4+8+**64**, 6 = 2+4, 70 = 2+4+**64**, 322 = 2+**64**+256, 66 = 2+**64**.

**Bit 64 is toolchain-emitted, not a behavior change** — it is set on *every* query in the 3.24 build, including the two whose source is provably unchanged (same entity, same parameters, same comparators, same sorting options). Reading the two pre-existing queries as having "gained a capability" would be a misreading of an Xcode 26→27 metadata-format bump. *Inference, high confidence* (the alternative — that Cultured Code added the same conformance to two untouched queries in the same release — is not consistent with every other field being byte-identical).

The remaining bits, *inferred, medium confidence* from which queries carry them: **2** = the base `EntityQuery` (`entities(for:)`, universal); **4** = string search (`EntityStringQuery`) — only on the two Shortcuts-facing pickers, which is exactly where a "search for the item" field appears; **8** = property query (`EntityPropertyQuery`) — only on `TAIItemQuery`, the only query with comparators and sorting options; **256** = only on the three reminders queries, all of them `Indexed` + `Syncable`, so most likely the indexed/enumerable conformance the assistant needs to resolve an entity from the semantic index. None of this is documented by Apple; it is arithmetic over two files.

### 2.6 Enums

| Enum | Cases | Availability |
|---|---|---|
| `TAIItemType` | todo, heading, project, area | `*` (unchanged) |
| `TAIItemStart` | onDate, anytime, someday | `*` (unchanged) |
| `TAIItemStatus` | open, completed, canceled | `*` (unchanged) |
| `TAIEditItemsAction` | set, append, prepend, add, remove, removeAll | `*` (unchanged) |
| `TAIEditItemsDetail` | title, parent, start, reminderTime, deadline, tags, status, completionDate, notes, checklist, creationDate | `*` (unchanged) |
| `TAIRemindersListType` | **standard** (one case) | 27.0, schema `reminders/ListType@1.0.0` |
| `TAIRemindersLocationTriggerEvent` | arrive, depart | 27.0, schema `reminders/LocationTriggerEvent@1.0.0` |

`TAIRemindersListType` having a single case is not a Things restriction: Apple's `RemindersEnum.listType` itself defines exactly one case, `.standard`. So `createList(type:name:)` carries a type parameter that can only ever hold one value.

### 2.7 App Shortcut phrases

Unchanged between builds: exactly one `autoShortcuts` entry, wrapping `TAIAddTodoWithQuickEntry` with nine phrase templates ("Create a to-do in ${applicationName}", "Add a task to ${applicationName}", "Remind me in ${applicationName}", …), short title "Add To-Do", glyph `plus.circle`, availability `*`. **Cultured Code did not add an App Shortcut for any of the eight new intents** — which is the single most consequential fact in this document (§5).

## 3. What "list", "section" and "reminder" map onto in Things

The metadata does not say. Three independent pieces of bundle evidence do, and they agree:

1. **Identifier prefixes.** The `TAIRemindersList` type is a Swift enum with a nested `Identity` struct carrying an optional `BSEntity` instance id; the string-encoding routine's literal pool holds, adjacently, `"area-"`, `"project-"`, `"inbox"` and `"noList"`. So a reminders *list* is one of: the Inbox, a project (`project-<id>`), an area (`area-<id>`), or a synthetic `noList`.
2. **New Spotlight artwork.** `SharedResources.framework` gained exactly 20 PNGs in 3.24 (light + dark of ten): `Spotlight-Inbox`, `Spotlight-Area`, `Spotlight-NoList`, `Spotlight-Heading`, `Spotlight-Project-{Open,Completed,Canceled}`, `Spotlight-ToDo-{Open,Completed,Canceled}`. The list-shaped icons are Inbox / Area / Project / NoList; the section-shaped icon is **Heading**; the reminder-shaped icons are the three to-do states.
3. **The error vocabulary.** `TAIRemindersError` (a `Swift.Error` with `CustomLocalizedStringResourceConvertible`) has exactly three cases, `invalidList`, `locationTriggerUnsupported`, `recurrenceUnsupported`, whose English strings are quoted in §4.

So the mapping Cultured Code chose is:

| Apple `reminders` concept | Things concept |
|---|---|
| list | **Inbox**, a **project**, an **area**, or `noList` (the to-dos that belong to neither) |
| section | **heading** (which only exists inside a project) |
| reminder | **to-do** |
| `isCompleted` | Things' `completed` — and, by omission, `canceled` too (§6) |
| group (folder of lists) | *not adopted* |

*Inference, high confidence* for the list mapping (three converging artifacts); *inference, medium-high* for section = heading (the `Spotlight-Heading` asset plus `createSection(name:list:)` requiring a list — and only projects can hold headings, which is presumably what `invalidList` guards).

## 4. The headline: `recurrence` is declared and refused

`TAIRemindersError` has a case named **`recurrenceUnsupported`**, and its localized string is:

> "Adding a recurrence is not supported."

Alongside it: `locationTriggerUnsupported` → "Adding a location trigger is not supported.", and `invalidList` → "Invalid list."

The `recurrence` parameter is present on `createReminder` and `updateReminder` **because Apple's schema conformance requires it** — a schema-conforming intent must declare the full signature or it does not compile. Things declares it, and (on the evidence of a purpose-built error case whose only plausible caller is the `recurrence` parameter's handling) throws when it is non-nil. The same is true of `locationTrigger`, which Things has no model for at all.

Corroborating: `ThingsCommon` contains **no `Calendar.RecurrenceRule` symbol, no RRULE vocabulary, and no reference to the type outside the generated metadata**. The only `RecurrenceRule` strings in the binary are EventKit ObjC accessors (`hasRecurrenceRules`, `setHasRecurrenceRules:`) belonging to the long-standing calendar-events integration, present identically in 3.23.3.

**Verdict for the repeating-items gap: no new write route.** The one parameter in the whole 3.24 catalog that could have created or edited a repeating to-do without driving the GUI is declared-but-refused, and it was unreachable anyway (§5). The ui vector remains the only way to make an item repeat.

*Confidence:* the error case, its name and its string are facts in the binary. That the throw fires on every non-nil `recurrence` (rather than, say, only on rule shapes Things cannot express) is an **inference** — a static read cannot see the branch condition. AI324-P1 in the probe plan tests it.

A second, subtler open question the static read cannot settle: `TAIRemindersReminderEntity` **exposes `recurrence` as a readable property**. Whether Things populates it from a repeating template's rule (making the entity a *read* surface for repeat rules, in Apple's vocabulary) or always returns `nil` is unknown — AI324-P2.

### Why Apple's own type could not have carried Things' repeats anyway

Even a Things that accepted `recurrence` would lose information. `Foundation.Calendar.RecurrenceRule` (macOS 15+, [docs](https://developer.apple.com/documentation/foundation/calendar/recurrencerule), [swift-foundation source](https://github.com/swiftlang/swift-foundation/blob/main/Sources/FoundationEssentials/Calendar/RecurrenceRule.swift), design in [SF-0009](https://github.com/swiftlang/swift-foundation/blob/main/Proposals/0009-calendar-recurrence-rule.md)) implements RFC 5545 + RFC 7529: `frequency` (minutely…yearly, no `.secondly`), `interval`, `end` (`.never` / `.afterOccurrences(n)` / `.afterDate(d)`), `months`, `weeks`, `daysOfTheYear`, `daysOfTheMonth`, `weekdays` (`.every(_)` / `.nth(n, _)`, n negative from the end), `hours`, `minutes`, `seconds`, `setPositions`, `matchingPolicy`, `repeatedTimePolicy`. Against Things' repeat vocabulary:

| Things repeat feature | `Calendar.RecurrenceRule` |
|---|---|
| fixed daily/weekly/monthly/yearly + interval | ✅ `frequency` + `interval` |
| ends-after N occurrences (`rc`) | ✅ `.afterOccurrences(n)` |
| ends-on date (`ed`) | ✅ `.afterDate(d)` |
| nth weekday of month | ✅ `.nth(n, weekday)` |
| **repeat N days AFTER COMPLETION** | ❌ **not expressible.** The rule is a pure function of a start date and a calendar pattern (`recurrences(of:in:)` takes only a start and a range); there is no completion anchor, no reset, nothing relative to an event. RFC 5545 has no such concept either, and neither does Apple Reminders. |
| exceptions / skipped occurrences (RD-29 projection-row exception) | ❌ no `EXDATE`/`RDATE` — the type has no exception-date concept at all |
| `WKST` / week-start | ⚠️ folded into the rule's `Calendar` (`firstWeekday`), not a rule field |

So Apple's carrier is **structurally incapable** of two of the things our repeat decoder already reads out of `rt1_recurrenceRule`. Had Things accepted it, round-tripping an after-completion series through Siri would have silently converted it to a fixed schedule. Refusing is the correct call (§6).

## 5. Reachability — can anything but Siri invoke these?

**Short answer: no, not on a machine with SIP on — and the gate is documented, not inferred.**

Every one of the eight new actions carries **`visibilityMetadata: {assistantOnly: true, isDiscoverable: false}`** and `systemProtocols: ["com.apple.link.systemProtocol.AssistantIntent"]`. Those are exactly the two flags Apple names as the hide switches. [`AppIntent.isDiscoverable`](https://developer.apple.com/documentation/appintents/appintent/isdiscoverable): *"When the value of this property is `true`, system features like Siri, Spotlight, and the Shortcuts app can discover and use the app intent. When the value of the property is `false`, you can run the intent from your app's interface or from a widget, but system features can't access it"* — with the explicit rider that **"App Shortcuts require this property to be `true`"**. And [WWDC25 session 260](https://developer.apple.com/videos/play/wwdc2025/260/), on Shortcuts/Spotlight eligibility: *"you'll want to make sure that the intent is not hidden from Shortcuts in Spotlight. For example by setting 'is discoverable' to false or setting 'assistant only' to true."*

Things sets **both**.

| Candidate invoker | Verdict | Confidence |
|---|---|---|
| **`shortcuts run <name>`** (our proxy fleet's transport) | **Cannot reach them.** The CLI has four subcommands (`run`/`list`/`view`/`sign`) and `run` takes a *shortcut*, never an intent identifier; a non-discoverable intent is not in the action library, so no shortcut can be built that contains one. `shortcuts://`, and the scriptable **Shortcuts Events** app, are the same surface with a different door — all three take a shortcut. | **High**, documented. |
| **An `AppShortcutsProvider` entry** (the escape hatch that would publish an intent to Siri/Spotlight without the Shortcuts library) | **Closed twice over.** Apple's own doc says App Shortcuts *require* `isDiscoverable == true`, so it is not even available to Cultured Code without flipping the flag; and independently, Things ships exactly one `autoShortcuts` entry and it wraps `TAIAddTodoWithQuickEntry` (§2.7). | **High**, documented. |
| **macOS 26/27 Spotlight actions / Quick Keys** | **Excluded by the same flags.** WWDC25 260's eligibility list is: the parameter summary must carry every required parameter, the intent must implement `perform()`, and it must not be hidden — `isDiscoverable != false`, `assistantOnly != true`. Both of Things' flags fail it. Separately, there is no CLI that enumerates or triggers a Spotlight action at all; it is a keyboard surface in a system window. | **High** on eligibility (documented); **medium-high** on "no CLI" (negative result). |
| **"Type to Siri"** | **GUI, and pointless.** Siri ships no scripting dictionary; the only route anyone has ever published is `osascript` + System Events keystroking the menu-bar item — a ui-vector drive of a system surface we do not own, with a non-deterministic model in the loop. And per the flags above, Siri's *discoverable* catalog does not contain these intents either; only the assistant-schema path reaches them, which is Siri's internal business, not a scriptable one. | **High.** |
| **`AppIntentsTesting`** (new in macOS/iOS **27.0**; [docs](https://developer.apple.com/documentation/appintentstesting), [WWDC26 295](https://developer.apple.com/videos/play/wwdc2026/295/)) | **The one genuinely interesting candidate — and it is team-signature-gated.** Contrary to what one would assume of a test framework, it is explicitly *out-of-process and by-name*: `IntentDefinitions(bundleIdentifier: "com.example.my-app")`, then `definitions.intents["X"].makeIntent(…).run()`, with no linking against the app target — and Apple's own guide **demonstrates running an `isDiscoverable = false` intent this way**. But: *"make sure it uses the same code signing team as the app"*, restated flatly in WWDC26 295 — *"AppIntentsTesting requires the test runner and the app to use the same development team for code signing."* `com.culturedcode.ThingsMac` is signed by Cultured Code, so this is their tool, not ours. | **Medium-high.** The capability and the constraint are both documented; whether the same-team check is enforced at runtime by the test runner or merely stated is untested, and re-signing Things to satisfy it would break its own signature and entitlements. Not a path this project would take even if it worked. |
| **A CLI/daemon that dispatches an intent directly** (`xcrun`, `lsappinfo`, `open`, a URL scheme) | **Nothing documented exists.** `shortcuts` is the only shipped intent-dispatch CLI, and it dispatches shortcuts. | **High.** |
| **Private-API routes** (`WorkflowKit`'s `BackgroundShortcutRunner` XPC service, reached by synthesizing a workflow plist that names the action identifier directly — the approach taken by the community tools *Action Relay* and *sosumi*, both of which, amusingly, discover actions by reading the very `extract.actionsdata` this document reads) | **Out of bounds, and unproven besides.** Both require the Apple-private `com.apple.shortcuts.background-running` entitlement, i.e. **SIP and AMFI disabled**; their authors describe them as research toys. Neither publishes a demonstration against a non-discoverable intent, so whether the runner would even accept one is an open question. This project writes exclusively through official app surfaces — a SIP-off private-XPC injection is categorically not one. | **High** that it is out of bounds; **unknown** whether it would work. |
| **Siri Extensions / third-party model as Siri backend** | **Model-swap, not API access, and no public API.** The third-party model runs *behind* Siri; the OS still performs invocation, and Siri consumes the same catalog. The Model Delegation surface found in shipping binaries is gated by an Apple-controlled private entitlement (`com.apple.developer.model-delegation`) not granted to third parties. | **Medium-high** (announcement + code-level community reporting). |

**Consequence for things-api:** the eight new intents are, for us, *evidence about Things' model* and nothing else. They do not grow the Shortcuts vector by a single action. The memo's §3 thesis ("`shortcuts run` is the generic-agent gateway to App Intents") survives with a sharp new boundary: it is the gateway to the **discoverable** catalog, and Apple has deliberately put the assistant-schema catalog on the other side of it. The only lever that would change this is Cultured Code's: flip `isDiscoverable`, or ship App Shortcuts. That is a feature request, not a probe.

### Spotlight as a READ surface

`ThingsCommon` in 3.24 links **CoreSpotlight** and **GeoToolbox** (plus `_GeoToolbox_AppIntents` and `_AppIntents_SwiftUI`) for the first time; the main `Things3` binary's link list is unchanged. New inside ThingsCommon: `THCSpotlightIndexComponent` (+ `_Coordinator`, a `Delegate` protocol, an `isIndexing` flag and a `hasSpotlightIndexChanges` bit), and the three reminders entities' `com.apple.appintents.entity.Indexed` conformance. `TAIRemindersListEntity` additionally carries a `hideInSpotlight: Bool` — some lists are deliberately kept out of the index. The database side of this work (the `BSSpotlightDirtyEntity` / `BSSpotlightIndexState` tables and the new `TMTask.userModificationDate` index) is measured separately in [dbv29-migration-diff.md](dbv29-migration-diff.md) and is not duplicated here.

Is that a read path for us? **No — item closed.** CoreSpotlight donations and App Intents `IndexedEntity` records live in the CoreSpotlight index (`~/Library/Metadata/CoreSpotlight`), not in the file-metadata store that `mdfind`/`mdls` query — those read `kMD*` attributes of files on disk, and a donated entity is not a file. The only *documented* programmatic read of another target's donations is `AppEntityDefinition.spotlightQuery(_:)` in `AppIntentsTesting`, which inherits the same-team signing constraint above. And even if a query existed, it would be a strictly poorer read than our direct SQLite reads: a title and a handful of attributes against 41 columns.

*Confidence:* high on the architecture (donated items are not file metadata; the separate index is long-established). The "still true on macOS 27" half is an inference from the absence of any documentation or report to the contrary, not an audit — but nothing hinges on it, because the read would be worse than what we already have.

## 6. Craft, and the quirk that isn't one yet

The adoption is logged as craft: [things-app-craft.md](../things-app-craft.md) §12 — the whole-domain adoption, and specifically the decision to declare `recurrence`/`locationTrigger` (as schema conformance demands) and then **refuse them with named, spoken-back errors** rather than silently converting an after-completion series into the nearest fixed schedule.

**No oddities entry was added, deliberately.** The one candidate is that Apple's reminder entity has `isCompleted` and nothing else while Things has three states (`open`, `completed`, `canceled`) — the entity carries a non-schema `isCanceled` member and Things ships `Spotlight-ToDo-Canceled` artwork, so the app knows the difference, but the schema has no slot for it. That is a fact about a *declaration*, not an observed behavior: a static read cannot show what the assistant is actually told about a canceled to-do, and [things-app-oddities.md](../things-app-oddities.md) is a catalog of reproduced behavior with repro steps. It is noted as the bounded credit inside the craft entry, and it is what probe AI324-P3 would settle. If that probe ever runs and the answer is bad, it earns an oddities section then.

## 7. Adjacent discovery — not part of this delta

While reading `ThingsCommon` for App Intents symbols, an unrelated surface surfaced: Things ships an **in-process MCP server** — `THCThingsMCPServerComponent` (`ThingsCommon/THCThingsMCPServerComponent.swift`), `THCThingsMCPSession`, `THCThingsMCPToolCallContext`, a `FAMCPTool` protocol, a socket path literal `mcp.sock`, a `PaginatedThingsJSONResult` type with `nextCursor`, and at least one tool whose English description is "*Returns the contents of the user's Today list in Things as ThingsJSON. Results are paginated; call repeatedly with the returned cursor until nextCursor is absent to retrieve all items…*".

**It is byte-for-byte present in 3.23.3 as well** — every one of those strings appears in both builds — so it is **not** part of the 3.24 delta and is out of scope for this document. It is recorded here only so the finding is not lost; investigating it (what enables it, where the socket lives, what the tool list is) is its own probe.

## 8. Reproducing this

```
unzip -q things-releases/Things3-3.24-32400006.zip -d /tmp/v324
python3 -c "import json;d=json.load(open('/tmp/v324/Things3.app/Contents/Frameworks/ThingsCommon.framework/Versions/A/Resources/Metadata.appintents/extract.actionsdata'));print(sorted(d['actions']))"
strings -a /tmp/v324/Things3.app/Contents/Frameworks/ThingsCommon.framework/Versions/A/ThingsCommon | grep -n 'TAIRemindersError'
nm -a /tmp/v324/.../ThingsCommon | grep TAIRemindersList | xargs -n1 xcrun swift-demangle
otool -L /tmp/v324/.../ThingsCommon | grep -E 'CoreSpotlight|GeoToolbox'
```

No step touches a running Things, a database, or a user account.
