# things-helpers — the permission broker pair (one bundle)

Two small launchd-supervised Swift helpers, shipped inside ONE signed bundle (`Things API Helper.app`), that perform the CLI's privileged primitives so macOS permission grants attach to **stable signed identities** instead of whichever agent harness happens to invoke `things` this week. Design of record: [docs/design/agent-daemon.md](../docs/design/agent-daemon.md) (§β1, §3b).

- **things-deputy** (`src/`, the bundle's main executable, unsandboxed) — app automation: `osascript` execution and the bundled `things-proxy-*` Shortcuts. Mutations only; file verbs answer `unsupported-verb`.
- **things-reader** (`reader/`, nested at `Contents/Helpers/things-reader.app`, SANDBOXED) — database/file reads through a durable security-scoped bookmark to the Things folder, minted once by `things helpers setup` (SANDBOX1, [docs/lab/sandbox1-scoped-reader.md](../docs/lab/sandbox1-scoped-reader.md)). Serves `sql`/`read-file`/`locate` from its container socket (`~/Library/Containers/com.pixelcog.things-reader/Data/reader.sock`). Ships as a signed minimal .app because amfid refuses ad-hoc/self-signed roots on sandboxed code and secinit refuses bare executables. Its bundle identifier keys the user's bookmark grant and must never change.

**Deliberately dumb.** All product logic — validation, guards, verification, audit, rendering — stays in the TypeScript library. The helpers never see an operation, only primitives, which is what makes CLI↔helper version skew survivable (the protocol is versioned; matching protocol = safe to execute across package versions).

## Build, sign, install

```sh
bash scripts/build-helpers.sh        # swiftc → deputy/build/Things API Helper.app, signed when an identity exists
things helpers setup                 # install (or update) + ONCE, at the machine: the full consent ceremony (read grant, both Automation prompts, Accessibility, shortcuts census)
things helpers status                # inspect: running, signed, granted, routing
things helpers uninstall [--revoke]  # remove; --revoke also clears the grants and local state
```

The build step above is the **source-checkout** path. A published `things-api` install already carries a signed + notarized bundle at `deputy/prebuilt/Things API Helper.app` (staged there by the release workflow), and `things helpers setup` prefers it — so from an npm install the sequence is just `things helpers setup`, with no Xcode and no certificate. A local `deputy/build/` bundle is the fallback, which is what a checkout uses. Maintainer setup for the release-time signing secrets: [docs/design/release-signing.md](../docs/design/release-signing.md).

Installing is the opt-in: `helpers-enabled` defaults to `auto`, so an installed and healthy helper is used from the next command on. `true` additionally reports absence, `false` never routes, and `--helpers`/`--no-helpers` (or `THINGS_API_HELPERS=auto|true|false`) override one invocation. Whatever the mode, a helper that is installed and cannot serve degrades to direct execution with one stderr line — never silently — and `things doctor`'s `── Helpers ──` section spells out the state.

Rebuild flow after pulling changes: `bash scripts/build-helpers.sh && things helpers setup` (setup is install-or-update followed by the ceremony; on an already-onboarded machine the ceremony is an all-skip no-op). Install owns its `bin/` directory wholesale — every install is a fresh copy (which also resets the kernel's per-vnode code-signature cache), so there is no upgrade ceremony and no migration logic. Both halves DRAIN on SIGTERM — the socket goes away, the listener closes, requests already dispatched finish within 10s, then the process exits 0 — so `setup`/`restart` on a busy helper no longer kills a request in flight (`launchctl bootout`/`kickstart -k` wait for that exit). SIGKILL remains the hard stop.

**Never ad-hoc sign.** TCC identity follows the certificate; an ad-hoc identity changes per build, which silently re-introduces the grant churn these helpers exist to end. The build script picks the best stable identity present — **Developer ID Application** (distribution-grade, 5-year, notarizable) > **Apple Development** (Apple-issued dev cert) > the self-signed ceremony cert (`scripts/deputy-cert-setup.sh`; deputy-only — the sandboxed reader REQUIRES an Apple-issued chain and is skipped without one) — signing with hardened runtime + timestamp, and warns loudly when none exists. Verified 2026-08-20: an Apple-chain signature also stops the EDR exec-time conviction that killed unsigned builds (see design §3a).

## Security posture

- Deputy socket, token, and logs live in a 0700 state dir (`~/.local/state/things-api/deputy/`); socket and token are 0600. The reader's live in its sandbox container.
- Every connection is peer-checked (same UID); every request must carry the token file's value — a sandboxed process that cannot read the token cannot use a helper.
- SQL runs on a `SQLITE_OPEN_READONLY` connection with `ATTACH` denied by an authorizer: it cannot write and cannot be aimed at other files. One statement per request.
- The reader can read NOTHING outside the granted folder — the OS enforces the sandbox, not our code; file-read requests are additionally confined to the granted subtree (symlinks resolved before the prefix check).
- osascript runs at a fixed absolute path with exactly two argv shapes (`-e <script>`, `-l JavaScript -e <script>`); scripts containing `do shell script` / `do script` are refused (a lint, not a boundary — see the threat-model note below).
- Every request is audit-logged locally (JSONL: verb, ok, script/sql SHA-256, duration — never content).

**Threat model, honestly:** a non-sandboxed same-user process can read the token and use the helpers — but such a process could equally run `osascript` itself and answer its own TCC prompt. What the helpers add is *their* grants; the token + peer check keep sandboxed and other-user processes out, and the guard/read-only/argv constraints keep them from being a general execution or file-read proxy.

## Protocol

JSON lines over each UNIX socket; one request → one response. Deputy verbs: `hello` (carries the deputy's own prompt-free TCC standing: `axTrusted`, `automation.{things,systemEvents}` ∈ granted|denied|not-running|unknown — see `src/tcc.swift`), `prime-ax` (raises the Accessibility dialog for the deputy's identity, fire-and-forget; the caller polls `hello`), `osascript` (`{script, lang, timeoutMs}` → `{exitCode, stdout, stderr, timedOut?, signal?}` — the deputy kills the child at the deadline, so a dead caller never leaves an unbounded osascript), `shortcuts` (`op: "list"`, or `op: "run"` restricted to the bundled `things-proxy-*` names, fixed argv, same deadline-kill). Reader verbs: `hello` (carries `granted`), `sql` (`{sql, params}` → `{rows}`; BLOBs as `{"$b64": …}`), `read-file`, `locate`. Each half answers the other's verbs with `unsupported-verb`. TypeScript twin: `src/deputy/protocol.ts`.

## Tests

- `test/unit/deputy-routing.test.ts` — routing/bridge/facade against mock helpers (any platform; runs in CI's ubuntu job).
- `test/deputy/broker-integration.test.ts` — the REAL deputy end-to-end (synthetic DB, stub osascript). Gated by `THINGS_DEPUTY_LIVE=1` + macOS + swiftc; CI's `deputy-macos` job runs it on every push. The gate exists because managed dev machines with EDR may refuse to execute freshly built unknown binaries (observed 2026-08-19: Cylance `execution_control` auto-quarantine, score −1000) — hosted runners are clean.
- `test/deputy/reader-integration.test.ts` — the REAL sandboxed reader (handshake, not-granted refusals, verb gating). Additionally gated on an Apple-chain signing identity and skipped when a production reader already serves on the machine.
