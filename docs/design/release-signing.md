# Release signing — the one-time maintainer setup

The release workflow (`.github/workflows/release.yml`, job `build-helpers`) signs and notarizes `Things API Helper.app` on a macOS runner and stages it into the npm tarball at `deputy/prebuilt/`, so `things helpers install` works from a plain `npm install` with no Xcode, no certificate, and no build step on the consumer's machine. Design of record: [agent-daemon.md](agent-daemon.md) §3 (Distribution).

This document is the click-path for the five repository secrets that job reads. **Nothing here is ever committed** — the repository holds the workflow and this runbook, never a certificate, a key, or a passphrase.

The five secrets:

| Secret | What it is |
|---|---|
| `APPLE_CERT_P12` | base64 of the Developer ID Application identity (certificate + private key) exported as `.p12` |
| `APPLE_CERT_PASSPHRASE` | the passphrase set on that `.p12` |
| `ASC_KEY_ID` | App Store Connect API key id (the 10-character string in the key's filename) |
| `ASC_ISSUER_ID` | App Store Connect issuer id (a UUID, shown once per team above the key list) |
| `ASC_KEY_P8` | the contents of the downloaded `AuthKey_<KEYID>.p8`, verbatim |

## 1. Export the Developer ID Application identity

Prerequisite: a paid Apple Developer membership, with a **Developer ID Application** certificate already created and its private key in the login keychain (this repo's team is `VNJWARH2W7`). Developer ID certificates last five years; only this class is notarizable, and notarization is what lets a downloaded bundle launch without a Gatekeeper prompt.

1. Open **Keychain Access** → *login* keychain → **My Certificates**.
2. Find `Developer ID Application: <name> (<TEAMID>)`. It must have a disclosure triangle — that triangle is the private key. Without it you have only the public certificate and must re-create the identity (or import it from the Mac that made it).
3. Right-click the certificate → **Export "Developer ID Application: …"** → format **Personal Information Exchange (.p12)** → save as `~/Desktop/developer-id.p12`.
4. Set a passphrase when prompted (generate one; you will paste it into `APPLE_CERT_PASSPHRASE`). macOS then asks for your *login* password to release the key — that is the keychain, not the export passphrase.
5. Base64 it:

   ```sh
   base64 -i ~/Desktop/developer-id.p12 | pbcopy
   ```

   (macOS `base64` emits one long line; the workflow decodes with `openssl base64 -d -A`, which accepts the value wrapped or unwrapped — `base64`'s own decode flag is spelled differently on BSD and GNU, so it is deliberately not used.)

**Chain note:** the CI job also imports Apple's `DeveloperIDG2CA` / `DeveloperIDCA` intermediates from `https://www.apple.com/certificateauthority/`, because `security find-identity -v` — which `scripts/build-helpers.sh` uses to pick an identity — counts a leaf as *valid* only when its chain resolves. If those intermediates cannot be fetched and the `.p12` does not carry them, the job fails loudly rather than producing an unsigned bundle.

## 2. Create the App Store Connect API key (notarization credentials)

`notarytool` authenticates with an API key, not with an Apple ID + app-specific password. The key is issued once and reused for every release.

1. Go to <https://appstoreconnect.apple.com> → **Users and Access** → **Integrations** → **Team Keys**.
2. Click **+**, name it (e.g. `things-api notarization`), role **Developer** (the minimum role notarization accepts).
3. **Download** the `AuthKey_<KEYID>.p8` immediately — Apple serves it exactly once.
4. From that page collect the three values:
   - **Key ID** — the 10-character id in the key's row, and in the filename.
   - **Issuer ID** — the UUID shown above the key list (per team, not per key).
   - **The `.p8` file itself** — its full contents including the `-----BEGIN PRIVATE KEY-----` / `-----END PRIVATE KEY-----` lines.

## 3. Set the five repository secrets

From a checkout of this repository, with `gh` authenticated as the repository owner:

```sh
gh secret set APPLE_CERT_P12 < <(base64 -i ~/Desktop/developer-id.p12)
gh secret set APPLE_CERT_PASSPHRASE          # prompts; paste the .p12 passphrase
gh secret set ASC_KEY_ID                     # prompts; paste the 10-char key id
gh secret set ASC_ISSUER_ID                  # prompts; paste the issuer UUID
gh secret set ASC_KEY_P8 < ~/Downloads/AuthKey_XXXXXXXXXX.p8
```

Then delete the local copies — they exist nowhere else that matters:

```sh
rm -P ~/Desktop/developer-id.p12 ~/Downloads/AuthKey_XXXXXXXXXX.p8
```

Verify the names are all present (values are never readable again):

```sh
gh secret list
```

**Fork-PR safety.** GitHub withholds secrets from workflows triggered by a fork's pull request, by design, and this job runs only on a `v*` tag push in this repository — so a fork can neither read nor exercise the signing material. That is also why signing lives in the release workflow and not in CI: `.github/workflows/ci.yml` must stay runnable by anyone.

## 4. What a release run looks like

`git push origin v<version>` starts three jobs in sequence:

1. **`build-helpers`** (macOS 14) — checks all five secrets are present (missing ⇒ the release fails here, deliberately), creates a throwaway keychain in `$RUNNER_TEMP`, imports the `.p12` with `codesign` in the key's partition list, makes it the default keychain for the job, then runs `scripts/build-helpers.sh` (which auto-selects `Developer ID Application`, hardened runtime + secure timestamp, nested reader signed first). It zips the bundle with `ditto -c -k`, submits it to `notarytool --wait`, requires the verdict `Accepted`, staples the ticket into the bundle, and asserts `stapler validate` + `spctl --assess`. The stapled bundle is uploaded as a **tar.gz** artifact — `upload-artifact` does not preserve the executable bit, and a helper whose main executable arrives `0644` is a bundle launchd cannot start. The keychain is deleted in an `always()` step.
2. **`publish`** (Ubuntu) — the usual tag/version check, `npm run check`, build, skill stamp; then it downloads the artifact, unpacks it into `deputy/prebuilt/`, asserts both executables are present and executable, asserts they appear in `npm pack --dry-run --json`, and publishes with npm trusted publishing.
3. **`github-release`** — unchanged.

To ship a release **without** prebuilt helpers you must remove `publish`'s `needs: build-helpers` edge: a missing secret can never do it silently.

The bundle's version line is `deputy/VERSION`, deliberately decoupled from the package version — a release whose helper sources did not change produces an equivalently versioned bundle and does not nag for a reinstall.

## 5. Troubleshooting

**`no VALID 'Developer ID Application' identity after import`** — the `.p12` carries the leaf but no intermediate *and* the runner could not fetch Apple's CA files, or the certificate has expired. Re-export from Keychain Access (§1); confirm locally with `security find-identity -v -p codesigning`, which must list the identity under *Valid identities only*. A cert that shows only under *Matching identities* with `CSSMERR_TP_NOT_TRUSTED` is exactly this failure.

**`errSecInternalComponent` from codesign, or the job hanging at the signing step** — the key's partition list was not set, so the keychain is asking a GUI for permission that no runner can answer. The `security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k <pass> <keychain>` call must run *after* `security import`, with the keychain's own password.

**`Invalid credentials`/`HTTP 401` from notarytool** — one of the three App Store Connect values is wrong or crossed: `ASC_KEY_ID` is the 10-character key id (not the issuer), `ASC_ISSUER_ID` is the team-wide UUID, and `ASC_KEY_P8` must be the whole file including the BEGIN/END lines and its trailing newline. Also check the key's role is at least *Developer* and that the key has not been revoked.

**Notarization status `Invalid`** — the job prints `notarytool log` for the submission. The usual causes: a binary without the hardened runtime (`--options runtime`), a missing secure timestamp (`--timestamp`), or a nested executable that was not signed. All three are handled by `scripts/build-helpers.sh`; a failure here means something new entered the bundle.

**`The staple and validate action failed! Error 65`** — the ticket was not yet published when stapling ran. Re-running the job is the fix; Apple's ticket distribution occasionally lags the `Accepted` verdict by a minute.

**Local rehearsal.** The keychain ceremony can be rehearsed end-to-end with a throwaway self-signed certificate (create keychain → import → `set-key-partition-list` → search list → `codesign`), which proves the command sequence without touching the real identity. What cannot be rehearsed off-CI is the notarization leg: it needs Apple's service and the real credentials, so its first proof is the first tagged release.
