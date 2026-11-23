#!/usr/bin/env bash
# Prepares the repository for going public: creates a clean repository WITHOUT history.
#
# Why: old commits contain internal notes (NOTES.md). If the repository were opened as it is, anyone could read them.
# What it does:
#   1) Renames the current GitHub repository to "<name>-archive". It stays private and keeps the full history as a backup.
#   2) Creates a new repository with the same name and pushes only the CURRENT STATE as a single commit (no history).
#   3) Asks whether the new repository should be public. Unless the answer is "y" it stays private; you can open it later.
# Nothing is deleted. The old history stays on this machine in the "old-main" branch (not pushed to GitHub).
#
# Usage (WSL Ubuntu, in the project folder):  bash scripts/github-publish.sh
# If the cloud keeper is used afterwards:     bash scripts/keeper-github.sh   (repository secrets are entered again in the new repository)
set -euo pipefail
cd "$(dirname "$0")/.."

command -v gh > /dev/null || { echo "gh (GitHub CLI) is not installed."; exit 1; }
gh auth status > /dev/null 2>&1 || { echo "Log in to GitHub first: gh auth login"; exit 1; }

REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
OWNER=${REPO%%/*}
NAME=${REPO##*/}
case "$NAME" in *-arsiv|*-archive) echo "This is already the archive repository ($REPO). Nothing was done."; exit 1 ;; esac

# 1) The working tree must be clean: take a backup first.
if [ -n "$(git status --porcelain)" ]; then
  echo "There are uncommitted changes. First:  bash scripts/github-backup.sh"
  exit 1
fi
[ "$(git branch --show-current)" = "main" ] || { echo "You are not on the main branch."; exit 1; }

# 2) Things that must not be in the published files.
BAD=$(git ls-files | grep -E '^(NOTES\.md|backups/|web/dist/|discord-bot/|scripts/archive/)|(^|/)(\.env[^/]*|access\.env[^/]*|server\.env|test-result\.txt|keeper\.log|status\.json|[^/]*\.(pem|key))$' || true)
if [ -n "$BAD" ]; then
  echo "STOPPED: these files must not be in the repository. Run  bash scripts/github-backup.sh  first:"
  echo "$BAD"
  exit 1
fi
LEAK=$(git ls-files -z | xargs -0 -r grep -lIE 'S[A-Z2-7]{55}|[0-9]{8,10}:[A-Za-z0-9_-]{35}|TELEGRAM_BOT_TOKEN=[0-9]|IORA_ACCESS_SECRET=[A-Za-z0-9]{8,}|KEEPER_SECRET=[S]|DISCORD_TOKEN=[A-Za-z0-9]|[MNO][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}' 2> /dev/null || true)
if [ -n "$LEAK" ]; then
  echo "STOPPED: these files may contain a secret key:"
  echo "$LEAK"
  exit 1
fi

echo "Repository: $REPO  ($(git ls-files | wc -l) files, $(git rev-list --count HEAD) old commits)"
echo
echo "What will happen:"
echo "  - $REPO  ->  $OWNER/$NAME-archive  (stays private, keeps the full history)"
echo "  - A new $REPO repository without history is created (private at first)"
echo "  - Actions secrets and settings of the old repository are NOT carried over (keeper-github.sh enters them again)"
read -r -p "Type OPEN in capitals to continue: " ANS
[ "$ANS" = "OPEN" ] || { echo "Cancelled. Nothing changed."; exit 0; }

# 3) The old repository becomes the archive.
gh repo rename "$NAME-archive" -R "$REPO" --yes
git remote rename origin archive
git remote set-url archive "https://github.com/$OWNER/$NAME-archive.git"

# 4) A single commit without history.
git branch -m main old-main
git checkout -q --orphan main
git add -A
git commit -q -F - <<MSG
Iora: first public version

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KvUZJ22R9Nf5uMwS9f5GYk
MSG

# 5) The new repository (private) and the push.
gh repo create "$REPO" --private --source . --remote origin --push
echo
echo "The new repository is ready and currently PRIVATE: https://github.com/$REPO  (1 commit)"
echo "Old history: https://github.com/$OWNER/$NAME-archive (private) and the 'old-main' branch on this machine."

# 6) Going public is asked separately.
echo
echo "Before opening, check: are the items under 'Known gaps' in docs/THREAT_MODEL.md acceptable to publish?"
read -r -p "Make the new repository public now? (y/N) " PUB
if [ "$PUB" = "y" ] || [ "$PUB" = "Y" ]; then
  gh repo edit "$REPO" --visibility public --accept-visibility-change-consequences && echo "The repository is public."
else
  echo "The repository stayed private. To open it later:  gh repo edit $REPO --visibility public --accept-visibility-change-consequences"
fi
