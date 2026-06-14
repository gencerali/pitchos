#!/usr/bin/env bash
#
# deploy.sh — one-command deploy for Kartalix (main worker + Method B shadow worker).
#
# What it automates:  the two `wrangler deploy` calls (and, optionally, secrets + KV arming).
# What it can't:       the Supabase migration (run the SQL by hand — printed below) and
#                      `wrangler login` (do that once if prompted).
#
# Usage:
#   ./deploy.sh            # full guided flow (first-time: secrets + arming prompts)
#   ./deploy.sh --quick    # just redeploy both workers (the common case after setup)
#
# Safe by design: Method B stays inert until you arm `methodb:enabled=1`, and the homepage
# keeps serving legacy until you flip `pipeline:active` on /admin/config.

set -euo pipefail

KV_NS="dedaea653ed542cca25e6cc2551dd1c3"   # PITCHOS_CACHE namespace id
BRANCH="claude/github-file-access-Zqttd"
STORY_CFG="wrangler-story.toml"
QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1

say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ask()  { read -r -p "$* [y/N] " a; [ "$a" = "y" ] || [ "$a" = "Y" ]; }

# ── 0. Up to date ────────────────────────────────────────────────────────────
say "0. Sync branch ($BRANCH)"
git rev-parse --abbrev-ref HEAD | grep -qx "$BRANCH" || echo "  (note: not on $BRANCH — deploying current checkout)"
git pull --ff-only origin "$(git rev-parse --abbrev-ref HEAD)" 2>/dev/null || echo "  (skipped pull)"

# ── 1. Auth ──────────────────────────────────────────────────────────────────
say "1. Cloudflare auth"
if ! npx wrangler whoami >/dev/null 2>&1; then
  echo "  Not logged in — running 'wrangler login' (opens a browser)…"
  npx wrangler login
fi
npx wrangler whoami | sed 's/^/  /' || true

# ── 2. Secrets (first-time only) ─────────────────────────────────────────────
if [ "$QUICK" -eq 0 ]; then
  say "2. Secrets for the Method B worker ($STORY_CFG)"
  if ask "Set SUPABASE_SERVICE_KEY + ANTHROPIC_API_KEY now? (skip if already set)"; then
    npx wrangler secret put SUPABASE_SERVICE_KEY -c "$STORY_CFG"
    npx wrangler secret put ANTHROPIC_API_KEY    -c "$STORY_CFG"
  else
    echo "  Skipped — assuming secrets already exist."
  fi
else
  say "2. Secrets — skipped (--quick)"
fi

# ── 3. Deploy main worker (adds /admin/pipeline + config toggle + cutover seam) ─
SHA="$(git rev-parse --short HEAD)"
say "3. Deploy main worker (pitchos-fetch-agent) @ $SHA"
npx wrangler deploy --var BUILD_SHA:"$SHA"

# ── 4. Deploy Method B shadow worker ─────────────────────────────────────────
say "4. Deploy Method B worker (pitchos-story-agent) @ $SHA"
npx wrangler deploy -c "$STORY_CFG" --var BUILD_SHA:"$SHA"

# Tag this deploy so you can map a live version back to the exact code (git checkout deploy-…).
git tag -f "deploy-$(date -u +%Y%m%d-%H%M)-$SHA" >/dev/null 2>&1 && echo "  tagged deploy-…-$SHA (push tags: git push --tags)"

# ── 5. Migration (manual — cannot be automated here) ─────────────────────────
say "5. Supabase migration — RUN THIS BY HAND"
cat <<EOF
  Open Supabase → SQL Editor → paste & run:
    docs/migrations/0014_method_b.sql
  (additive: creates topics / topic_edges / phases + 3 columns on content_items.)
  ⚠  Do this BEFORE arming Method B (step 6) or the first run will error.
EOF

# ── 6. Arm Method B + admin key (first-time only) ────────────────────────────
if [ "$QUICK" -eq 0 ]; then
  say "6. Arm Method B (optional — leave OFF until the migration is applied)"
  if ask "Set methodb:enabled = 1 now? (the shadow worker starts producing)"; then
    npx wrangler kv key put --namespace-id="$KV_NS" methodb:enabled 1
    KEY="$(openssl rand -hex 16 2>/dev/null || echo devkey-$RANDOM$RANDOM)"
    npx wrangler kv key put --namespace-id="$KV_NS" methodb:admin_key "$KEY"
    echo "  methodb:admin_key = $KEY   (for the story worker's POST /run)"
  else
    echo "  Left inert. Arm later with:"
    echo "    npx wrangler kv key put --namespace-id=$KV_NS methodb:enabled 1"
  fi
fi

say "Done"
cat <<EOF
  Next:
   • Compare:  https://kartalix.com/admin/pipeline   (legacy vs Method B side-by-side)
   • Toggle:   https://kartalix.com/admin/config      ("0. Pipeline (serving)" card)
   • Pause Method B anytime:
       npx wrangler kv key put --namespace-id=$KV_NS methodb:enabled 0
   • Roll the homepage back to legacy: flip on /admin/config (instant).
EOF
