#!/usr/bin/env bash
# Creates (or re-configures) the GitHub repository for this bot with the same
# rules as the other FoundryVTT-… repositories, pushes the code and publishes a
# release. Idempotent: safe to re-run to re-apply settings.
#
#   scripts/setup-repo.sh [--owner dxcufgb] [--repo FoundryVTT-discord-integration] [--release v1.0.0] [--no-release]
#
# Needs the GitHub CLI (https://cli.github.com) logged in as the repository owner
# (`gh auth login`) and git. Run it from inside this project folder.
#
# If this folder is a sub-folder of another git repository (the bot was first
# developed inside dxcufgb/FoundryVTT-Module-patches), the script extracts the
# bot's history with `git subtree split` so the new repository starts with a
# clean history containing only the bot.
set -euo pipefail

OWNER="dxcufgb"
REPO="FoundryVTT-discord-integration"
RELEASE="v1.0.0"
DO_RELEASE=1
DESCRIPTION="Discord bot for Foundry VTT v13: posts when the server goes down or comes back up, when a world is started, and when Foundry, systems or modules are updated. Scheduled restart windows, one channel per message type."

while [[ $# -gt 0 ]]; do
  case "$1" in
    --owner) OWNER="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --release) RELEASE="$2"; shift 2 ;;
    --no-release) DO_RELEASE=0; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

command -v gh >/dev/null || { echo "The GitHub CLI (gh) is required: https://cli.github.com" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Log in first: gh auth login" >&2; exit 1; }

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GIT_ROOT="$(cd "$PROJECT_DIR" && git rev-parse --show-toplevel)"
FULL="$OWNER/$REPO"
WORK="$PROJECT_DIR"

# --- 1. Make sure we have a repository whose root is the bot -------------------------
if [[ "$GIT_ROOT" != "$PROJECT_DIR" ]]; then
  PREFIX="${PROJECT_DIR#"$GIT_ROOT"/}"
  echo "Bot lives in sub-folder '$PREFIX' of $GIT_ROOT; extracting its history with git subtree split"
  SPLIT_BRANCH="split/$REPO-$(date +%s)"
  (cd "$GIT_ROOT" && git subtree split --prefix="$PREFIX" -b "$SPLIT_BRANCH" >/dev/null)
  WORK="$(mktemp -d)"
  git clone -q --branch "$SPLIT_BRANCH" "$GIT_ROOT" "$WORK"
  (cd "$WORK" && git branch -M main)
  (cd "$GIT_ROOT" && git branch -D "$SPLIT_BRANCH" >/dev/null)
  echo "Clean checkout of the bot's history is in $WORK"
fi
cd "$WORK"
git rev-parse --verify main >/dev/null 2>&1 || git branch -M main

# --- 2. Create the repository if needed and push main -------------------------------------
if gh repo view "$FULL" >/dev/null 2>&1; then
  echo "Repository $FULL already exists"
else
  echo "Creating $FULL"
  gh repo create "$FULL" --public --description "$DESCRIPTION"
fi
if git remote get-url origin >/dev/null 2>&1; then git remote set-url origin "https://github.com/$FULL.git"; else git remote add origin "https://github.com/$FULL.git"; fi
echo "Pushing main"
git push -u origin main

# --- 3. Repository settings: same as the other FoundryVTT-… repositories ---------------
echo "Applying repository settings"
gh repo edit "$FULL" \
  --description "$DESCRIPTION" \
  --visibility public --accept-visibility-change-consequences \
  --default-branch main \
  --enable-issues --enable-projects --enable-wiki \
  --enable-squash-merge --squash-merge-commit-message default \
  --enable-merge-commit=false --enable-rebase-merge=false \
  --enable-auto-merge --delete-branch-on-merge \
  --add-topic foundryvtt --add-topic foundry-vtt --add-topic discord-bot --add-topic discord-js >/dev/null
gh api -X PATCH "repos/$FULL" -F allow_update_branch=false \
  -f squash_merge_commit_title=COMMIT_OR_PR_TITLE -f squash_merge_commit_message=COMMIT_MESSAGES >/dev/null

# Security: secret scanning + push protection, Dependabot alerts and security updates,
# private vulnerability reporting, CodeQL default setup.
echo "Applying security settings"
gh api -X PATCH "repos/$FULL" --input - >/dev/null <<'JSON'
{"security_and_analysis": {"secret_scanning": {"status": "enabled"}, "secret_scanning_push_protection": {"status": "enabled"}}}
JSON
gh api -X PUT "repos/$FULL/vulnerability-alerts" >/dev/null
gh api -X PUT "repos/$FULL/automated-security-fixes" >/dev/null
gh api -X PUT "repos/$FULL/private-vulnerability-reporting" >/dev/null
gh api -X PATCH "repos/$FULL/code-scanning/default-setup" -f state=configured -f query_suite=default >/dev/null || \
  echo "  CodeQL default setup could not be enabled (needs a public repository)"

# --- 4. Ruleset "Protect main" -------------------------------------------------------------
RULESET_FILE="$WORK/.github/ruleset-protect-main.json"
EXISTING_ID="$(gh api "repos/$FULL/rulesets" --jq '.[] | select(.name | ascii_downcase == "protect main") | .id' 2>/dev/null | head -n1 || true)"
if [[ -n "$EXISTING_ID" ]]; then
  echo "Updating ruleset 'Protect main' ($EXISTING_ID)"
  gh api -X PUT "repos/$FULL/rulesets/$EXISTING_ID" --input "$RULESET_FILE" >/dev/null
else
  echo "Creating ruleset 'Protect main'"
  gh api -X POST "repos/$FULL/rulesets" --input "$RULESET_FILE" >/dev/null
fi

# --- 5. Release -----------------------------------------------------------------------------
if [[ $DO_RELEASE -eq 1 ]]; then
  if gh release view "$RELEASE" --repo "$FULL" >/dev/null 2>&1; then
    echo "Release $RELEASE already exists"
  else
    NOTES="$(mktemp)"
    VERSION="${RELEASE#v}"
    # The matching section of CHANGELOG.md (from its heading to the next version heading).
    awk -v v="$VERSION" '
      $0 ~ "^## \\[" v "\\]" { on=1; next }
      on && /^## \[/ { exit }
      on && !/^\[.*\]: http/ { print }
    ' CHANGELOG.md | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}' > "$NOTES"
    [[ -s "$NOTES" ]] || echo "Release $RELEASE." > "$NOTES"
    echo "Publishing release $RELEASE (the Release workflow will attach the Linux and Windows bundles)"
    gh release create "$RELEASE" --repo "$FULL" --target main --title "$RELEASE" --notes-file "$NOTES"
    rm -f "$NOTES"
  fi
fi

echo
echo "Done: https://github.com/$FULL"
[[ "$WORK" != "$PROJECT_DIR" ]] && echo "Clean clone of the new repository: $WORK"
exit 0
