#!/usr/bin/env bash
# One-time ceremony: mint the persistent self-signed code-signing certificate
# ("things-deputy-signing") that scripts/build-helpers.sh signs the deputy with.
#
# WHY A PERSISTENT CERT: macOS attaches Automation/Accessibility/file grants to
# the responsible process's code signature. A stable certificate means every
# rebuild of the deputy keeps the same identity — grants survive. Ad-hoc
# signing mints a fresh identity per build, which silently re-introduces the
# grant churn the deputy exists to end, so it is deliberately not supported.
#
# INTERACTIVE: importing trust settings prompts for your login-keychain
# password / an authorization dialog. Run this yourself at the machine; it is
# not for unattended execution. Everything stays in your login keychain —
# nothing is written to the repository.
#
# Re-running is safe: if the identity already exists, the script leaves it be.
set -euo pipefail

IDENTITY="things-deputy-signing"

if security find-identity -v -p codesigning 2>/dev/null | grep -q "$IDENTITY"; then
  echo "signing identity '$IDENTITY' already exists — nothing to do."
  exit 0
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cat >"$WORK/ext.cnf" <<'EOF'
[ req ]
distinguished_name = dn
x509_extensions = codesign_ext
prompt = no
[ dn ]
CN = things-deputy-signing
[ codesign_ext ]
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
basicConstraints = critical,CA:false
EOF

# 10-year self-signed code-signing cert + key, bundled as a throwaway p12.
openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" -config "$WORK/ext.cnf" >/dev/null 2>&1
openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
  -name "$IDENTITY" -passout pass:transient -out "$WORK/bundle.p12" >/dev/null 2>&1

echo "importing '$IDENTITY' into the login keychain (codesign is granted access)..."
security import "$WORK/bundle.p12" -k "$HOME/Library/Keychains/login.keychain-db" \
  -P transient -T /usr/bin/codesign

echo "marking the certificate trusted for code signing (this may prompt)..."
security add-trusted-cert -p codeSign \
  -k "$HOME/Library/Keychains/login.keychain-db" "$WORK/cert.pem"

echo
echo "done. Next:"
echo "  bash scripts/build-helpers.sh   # now signs with $IDENTITY"
echo "  things deputy install          # (re)install the signed helper"
echo "  things deputy status           # verify signing: signed ($IDENTITY)"
