#!/usr/bin/env bash
# Backs up what is deliberately kept OUT of the main repository to a separate PRIVATE GitHub repository
# ("iora-private"): the internal notes (NOTES.md). Run again to push new changes.
# (The Discord bot is a separate project with its own backup.sh; an older copy of it here is removed.)
# Secrets are never included: .env files, node_modules and key files are left out, and the push stops if a
# file looks like it contains a key or token.
# Usage (WSL Ubuntu, in the project folder):  bash scripts/github-private.sh
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="iora-private"
DIR="$HOME/.iora-private"

command -v gh > /dev/null || { echo "gh (GitHub CLI) is not installed. Run  bash scripts/github-backup.sh  once first."; exit 1; }
gh auth status > /dev/null 2>&1 || { echo "Log in to GitHub first:  bash scripts/github-backup.sh"; exit 1; }
LOGIN=$(gh api user --jq .login)

# 1) The working copy lives outside the project folder so it never ends up in the main repository.
if [ ! -d "$DIR/.git" ]; then
  if gh repo view "$LOGIN/$REPO" > /dev/null 2>&1; then
    gh repo clone "$LOGIN/$REPO" "$DIR" -- -q
  else
    mkdir -p "$DIR" && git -C "$DIR" init -q -b main
  fi
fi

# 2) Copy the current files (the previous copy of each folder is replaced).
rm -rf "$DIR/discord-bot"
if [ -d discord-bot ]; then
  mkdir -p "$DIR/discord-bot"
  (cd discord-bot && tar cf - --exclude=node_modules --exclude=.git --exclude='.env' --exclude='.env.*' .) | tar xf - -C "$DIR/discord-bot"
  # .env.example carries no secret and documents the settings
  [ -f discord-bot/.env.example ] && cp discord-bot/.env.example "$DIR/discord-bot/.env.example"
fi
[ -f NOTES.md ] && cp NOTES.md "$DIR/NOTES.md"
cat > "$DIR/README.md" <<'TXT'
# Iora: private files

Kept out of the public repository on purpose: the internal notes (`NOTES.md`).
No secrets are stored here. Updated with `bash scripts/github-private.sh` from the main project folder.
TXT

# 3) Secret check, then commit and push.
cd "$DIR"
git add -A
LEAK=$(git diff --cached --name-only --diff-filter=ACMR -z | xargs -0 -r grep -lIE 'S[A-Z2-7]{55}|[0-9]{8,10}:[A-Za-z0-9_-]{35}|TELEGRAM_BOT_TOKEN=[0-9]|IORA_ACCESS_SECRET=[A-Za-z0-9]{8,}|KEEPER_SECRET=[S]|DISCORD_TOKEN=[A-Za-z0-9]|[MNO][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}' 2> /dev/null || true)
LEAK="$LEAK$(git diff --cached --name-only --diff-filter=ACMR | grep -E '(^|/)(\.env|\.env\.[^/]*|access\.env[^/]*|server\.env|[^/]*\.(pem|key))$' | grep -v '\.env\.example$' || true)"
if [ -n "$LEAK" ]; then
  echo "STOPPED: these files may contain a secret; nothing was pushed:"
  echo "$LEAK"
  git reset -q
  exit 1
fi
if git diff --cached --quiet; then
  echo "No new changes."
else
  git commit -q -F - <<MSG
Iora private files: update $(date +%F)

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KvUZJ22R9Nf5uMwS9f5GYk
MSG
  echo "Commit created: $(git log -1 --format=%h)"
fi
if git remote get-url origin > /dev/null 2>&1; then
  git push -q -u origin main && echo "Pushed."
else
  gh repo create "$REPO" --private --source . --remote origin --push > /dev/null && echo "Private repository created and pushed."
fi
echo "Repository: https://github.com/$LOGIN/$REPO (private)"
