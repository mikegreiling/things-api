# things-deputy — the TCC permission broker

A small launchd-supervised Swift helper that performs the CLI's privileged primitives — read-only SQL against the Things database, `osascript` execution, and file reads inside the Things group container — so that macOS TCC grants (Automation, Accessibility, group-container access) attach to **one stable signed identity** instead of whichever agent harness happens to invoke `things` this week. Design of record: [docs/design/agent-daemon.md](../docs/design/agent-daemon.md) (§β1).

**Deliberately dumb.** All product logic — validation, guards, verification, audit, rendering — stays in the TypeScript library. The deputy never sees an operation, only primitives, which is what makes CLI↔deputy version skew survivable (the protocol is versioned; matching protocol = safe to execute across package versions).

## Build, sign, install

```sh
bash scripts/deputy-cert-setup.sh   # ONCE per machine, interactive: mints the persistent
                                    # self-signed signing cert ("things-deputy-signing")
bash scripts/build-deputy.sh        # swiftc → deputy/build/things-deputy, signed when the cert exists
things deputy install               # copy to the stable path + launchd bootstrap
things deputy status                # verify: running, signed, database resolved
things config set deputy-enabled true   # opt the CLI into routing (per-call: --deputy/--no-deputy)
```

Rebuild flow after pulling changes: `bash scripts/build-deputy.sh && things deputy install`.

**Never ad-hoc sign.** TCC identity follows the certificate; an ad-hoc identity changes per build, which silently re-introduces the grant churn this helper exists to end. The build script signs with the ceremony cert when present and warns loudly when it is absent.

## Security posture

- Socket, token, config, and logs live in a 0700 state dir (`~/.local/state/things-api/deputy/`); socket and token are 0600.
- Every connection is peer-checked (same UID); every request must carry the token file's value — a sandboxed process that cannot read the token cannot use the deputy.
- SQL runs on a `SQLITE_OPEN_READONLY` connection with `ATTACH` denied by an authorizer: it cannot write and cannot be aimed at other files. One statement per request.
- osascript runs at a fixed absolute path with exactly two argv shapes (`-e <script>`, `-l JavaScript -e <script>`); scripts containing `do shell script` / `do script` are refused (a lint, not a boundary — see the threat-model note below).
- File reads are confined to the resolved group-container subtree (symlinks resolved before the prefix check).
- Every request is audit-logged locally (JSONL: verb, peer pid, script/sql SHA-256, duration — never content).

**Threat model, honestly:** a non-sandboxed same-user process can read the token and use the deputy — but such a process could equally run `osascript` itself and answer its own TCC prompt. What the deputy adds is *its* grants; the token + peer check keep sandboxed and other-user processes out, and the guard/read-only/argv constraints keep the deputy from being a general execution or file-read proxy.

## Protocol

JSON lines over the UNIX socket; one request → one response. Verbs: `hello` (handshake: protocol + versions + resolved db path), `sql` (`{sql, params}` → `{rows}`; BLOBs as `{"$b64": …}`), `osascript` (`{script, lang, timeoutMs}` → `{exitCode, stdout, stderr, timedOut?, signal?}` — the deputy kills the child at the deadline, so a dead caller never leaves an unbounded osascript), `read-file`, `locate`. TypeScript twin: `src/deputy/protocol.ts`.

## Tests

- `test/unit/deputy-routing.test.ts` — routing/bridge/facade against a mock broker (any platform; runs in CI's ubuntu job).
- `test/deputy/broker-integration.test.ts` — the REAL binary end-to-end (synthetic DB, stub osascript). Gated by `THINGS_DEPUTY_LIVE=1` + macOS + swiftc; CI's `deputy-macos` job runs it on every push. The gate exists because managed dev machines with EDR may refuse to execute freshly built unknown binaries (observed 2026-08-19: Cylance `execution_control` auto-quarantine, score −1000) — hosted runners are clean.
