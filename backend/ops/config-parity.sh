#!/bin/sh
# Backend configuration parity report (PLAID_KEY_ROTATION_V2_TO_V3.md §5.2). READ-ONLY.
#
# Run it, or paste it, in a shell INSIDE each backend deployment (a Railway shell and a Render shell),
# from the repository root, and compare the two reports line by line against the parity matrix.
#
# Prints the values of NON-SECRET settings only (URLs, environment names, product lists, key IDS).
# For secrets it prints only "<set>" or "<unset>": never a value, a length, a prefix or a hash.
# It reads the environment and the file system; it writes nothing and contacts nothing.

show() { # name — a non-secret value, or <unset>
  if v="$(printenv "$1")"; then printf '%s=%s\n' "$1" "$v"; else printf '%s=<unset>\n' "$1"; fi
}
presence() { # name — a secret: presence only
  if [ -n "$(printenv "$1")" ]; then printf '%s=<set>\n' "$1"; else printf '%s=<unset>\n' "$1"; fi
}
effective() { # name default — what the backend will actually use (config/env.ts defaults)
  if v="$(printenv "$1")" && [ -n "$v" ]; then printf 'effective %s=%s\n' "$1" "$v"; else printf 'effective %s=%s (DEFAULT: variable unset)\n' "$1" "$2"; fi
}

echo "== non-secret settings"
for n in FRONTEND_URL BACKEND_PUBLIC_URL SUPABASE_URL PLAID_ENV PLAID_PRODUCTS PLAID_COUNTRY_CODES \
         PLAID_HOSTED_LINK_COMPLETION_REDIRECT_URI PLAID_TOKEN_CURRENT_KEY_ID NODE_VERSION PORT; do
  show "$n"
done

echo "== effective values (after the backend's own defaults)"
effective PLAID_ENV sandbox
effective PLAID_PRODUCTS transactions,auth
effective PLAID_COUNTRY_CODES US
frontend="$(printenv FRONTEND_URL | sed 's:/*$::')"
effective PLAID_HOSTED_LINK_COMPLETION_REDIRECT_URI "${frontend}/plaid-link-complete.html"
if public="$(printenv BACKEND_PUBLIC_URL)" && [ -n "$public" ]; then
  echo "webhook registered on NEW Link tokens=${public}/api/webhooks/plaid"
else
  echo "webhook registered on NEW Link tokens=<NONE: BACKEND_PUBLIC_URL unset, new Items get no webhook>"
fi

echo "== secrets (presence only)"
for n in SUPABASE_SERVICE_ROLE_KEY PLAID_CLIENT_ID PLAID_SECRET; do
  presence "$n"
done

echo "== token key ring (key ids only)"
printenv | sed -n 's/^PLAID_TOKEN_KEY_\([A-Za-z0-9_]*\)=.*$/key id configured: \1/p' | sort

echo "== runtime and build artifacts"
echo "node=$(node --version 2>/dev/null || echo '<node not found>')"
echo "cwd=$(pwd)"
for f in backend/dist/index.js backend/dist/scripts/rotatePlaidTokenKeyV2ToV3.js backend/dist/scripts/updatePlaidItemWebhooks.js; do
  if [ -f "$f" ]; then echo "present: $f"; else echo "MISSING: $f"; fi
done
