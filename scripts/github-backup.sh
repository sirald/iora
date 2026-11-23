#!/usr/bin/env bash
# Backs the project up to a private GitHub repository. Run again to push new changes.
cd "$(dirname "$0")/.." || exit 1
REPO="iora"

# 1) GitHub CLI
if ! command -v gh > /dev/null; then
  echo "Installing the GitHub CLI (you may be asked for your password)..."
  sudo apt-get update -qq && sudo apt-get install -y -qq gh || { echo "gh could not be installed"; exit 1; }
fi

# 2) Login
if ! gh auth status > /dev/null 2>&1; then
  echo
  echo "GitHub login: an 8-character code will appear below."
  echo "Open https://github.com/login/device in a browser and enter that code."
  echo "Press Enter if you are asked a question."
  echo
  gh auth login --hostname github.com --git-protocol https --web || { echo "Login failed"; exit 1; }
fi
gh auth setup-git > /dev/null 2>&1
# Workflow files (.github/workflows) need the 'workflow' scope
if [ -d .github/workflows ] && ! gh auth status 2>&1 | grep -q "workflow"; then
  echo "GitHub will be given the workflow scope; if a code appears, enter it at https://github.com/login/device."
  gh auth refresh -h github.com -s workflow || echo "Warning: the scope was not granted; the workflow file may not be pushed."
fi

# 3) Git identity (GitHub's noreply address is used so the e-mail stays private)
LOGIN=$(gh api user --jq .login)
UID_=$(gh api user --jq .id)
git config --global user.name > /dev/null || git config --global user.name "$LOGIN"
git config --global user.email > /dev/null || git config --global user.email "${UID_}+${LOGIN}@users.noreply.github.com"

# 4) Repository
[ -d .git ] || git init -q -b main
git add -A
# Files with old names and the local backup folder leave the repository (they stay on this machine)
git rm -r -q --cached --ignore-unmatch backups berthly.sh moor.sh NOTES.md web/dist > /dev/null 2>&1
# Anything that .gitignore excludes now but was committed earlier also leaves the repository (testnet run logs, old backups)
git ls-files -ci --exclude-standard -z | xargs -0 -r git rm -q --cached -- > /dev/null 2>&1

# 5) Secret check: stop if a file about to be pushed contains a key.
# Stellar secret key, Telegram bot token (even inside a URL), the access secret and key files.
LEAK=$(git diff --cached --name-only --diff-filter=ACMR -z | xargs -0 -r grep -lE 'S[A-Z2-7]{55}|[0-9]{8,10}:[A-Za-z0-9_-]{35}|TELEGRAM_BOT_TOKEN=[0-9]|IORA_ACCESS_SECRET=[A-Za-z0-9]{8,}|KEEPER_SECRET=[S]|DISCORD_TOKEN=[A-Za-z0-9]|[MNO][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}' 2>/dev/null)
LEAK="$LEAK$(git diff --cached --name-only --diff-filter=ACMR | grep -E '(^|/)(\.env[^/]*|access\.env[^/]*|server\.env|[^/]*\.(pem|key))$' )"
if [ -n "$LEAK" ]; then
  echo "STOPPED: these files may contain a secret key; nothing was pushed:"
  echo "$LEAK"
  git reset -q
  exit 1
fi

if git diff --cached --quiet; then
  echo "No new changes."
else
  git commit -q -F - <<MSG
Iora: update $(date +%F)

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KvUZJ22R9Nf5uMwS9f5GYk
MSG
  echo "Commit created: $(git log -1 --format=%h)"
fi

# 6) Push (if the repository still has an old name, rename it to "iora")
if git remote get-url origin 2>/dev/null | grep -qE "/(moor|berthly)(\.git)?$"; then
  gh repo rename "$REPO" --yes > /dev/null 2>&1 && echo "The GitHub repository was renamed to 'iora'."
  git remote set-url origin "https://github.com/$LOGIN/$REPO.git"
fi
if git remote get-url origin > /dev/null 2>&1; then
  git push -q origin main && echo "Pushed." || { echo "Push failed."; exit 1; }
elif gh repo view "$LOGIN/$REPO" > /dev/null 2>&1; then
  git remote add origin "https://github.com/$LOGIN/$REPO.git"
  git push -q -u origin main && echo "Pushed." || { echo "Push failed."; exit 1; }
else
  gh repo create "$REPO" --private --source . --remote origin --push > /dev/null && echo "Private repository created and pushed." || { echo "The repository could not be created."; exit 1; }
fi

echo
echo "Repository: https://github.com/$LOGIN/$REPO"
echo "Run the same command again for later backups."
