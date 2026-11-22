#!/usr/bin/env bash
# Moves the keeper to GitHub Actions (free; it runs while this machine is off).
# It asks GitHub for the 'workflow' scope, stores the secrets as repository secrets, pushes the code and runs the keeper once.
# The secret key is never written to a file; it goes straight to GitHub's encrypted secrets.
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

command -v gh > /dev/null || { echo "First: bash scripts/github-backup.sh"; exit 1; }
gh auth status > /dev/null 2>&1 || { echo "First: bash scripts/github-backup.sh"; exit 1; }

# 1) The 'workflow' scope, needed to push a workflow file
if ! gh auth status 2>&1 | grep -q "workflow"; then
  echo
  echo "GitHub will be given the workflow scope. If a code appears below, enter it at"
  echo "https://github.com/login/device and press Enter if asked."
  echo
  gh auth refresh -h github.com -s workflow || { echo "The scope was not granted"; exit 1; }
fi

# 2) Put the workflow file in place and push the code
mkdir -p .github/workflows && cp scripts/keeper-workflow.yml .github/workflows/keeper.yml
bash scripts/github-backup.sh || exit 1
LOGIN=$(gh api user --jq .login)
REPO="$LOGIN/iora"

# 3) Secrets
SECRET=""
for c in "stellar keys secret keeper" "stellar keys show keeper"; do
  S=$($c 2>/dev/null | grep -oE 'S[A-Z2-7]{55}' | head -1)
  [ -n "$S" ] && { SECRET="$S"; break; }
done
[ -z "$SECRET" ] && { echo "could not read the keeper secret key"; exit 1; }
setsecret() { printf '%s' "$2" | gh secret set "$1" -R "$REPO" > /dev/null && echo "$1 saved." || { echo "$1 could not be saved"; exit 1; }; }
envval() { grep -E "^$1=" keeper/.env | head -1 | cut -d= -f2- | tr -d '\r' | sed -e 's/^["'"'"']//' -e 's/["'"'"']$//'; }
setsecret KEEPER_SECRET "$SECRET"
if [ -f keeper/.env ]; then
  T=$(envval TELEGRAM_BOT_TOKEN)
  C=$(envval TELEGRAM_CHAT_ID)
  [ -n "$T" ] && setsecret TELEGRAM_BOT_TOKEN "$T"
  [ -n "$C" ] && setsecret TELEGRAM_CHAT_ID "$C"
fi

# Turn on the scheduled cloud keeper (the workflow does not run on schedule without this variable)
gh variable set KEEPER_CLOUD -b 1 -R "$REPO" > /dev/null && echo "Cloud keeper schedule turned on." || { echo "The KEEPER_CLOUD variable could not be set"; exit 1; }

# 4) Visibility: GitHub Actions is free without limits for public repositories.
VIS=$(gh repo view "$REPO" --json visibility --jq .visibility)
# Before the repository is opened, the whole history is scanned for secret keys (one may remain in an old commit).
HISTLEAK=$(git log -p --all 2>/dev/null | grep -cE 'S[A-Z2-7]{55}|[0-9]{8,10}:[A-Za-z0-9_-]{35}|IORA_ACCESS_SECRET=[A-Za-z0-9]{8,}')
if [ "$VIS" != "PUBLIC" ] && [ "${HISTLEAK:-0}" != "0" ]; then
  echo "The repository history has $HISTLEAK lines that may contain a secret key; it will not be made public."
  VIS=PUBLIC_SKIP
fi
# If internal notes are in the history, this script does not open the repository: prepare a clean one without history first.
if [ "$VIS" != "PUBLIC" ] && [ -n "$(git log --all --oneline -- NOTLAR.md 2>/dev/null | head -1)" ]; then
  echo "The repository history contains internal notes (NOTLAR.md); it must not be opened like this."
  echo "First:  bash scripts/github-publish.sh   (prepares a clean repository without history), then run this script again."
  VIS=PUBLIC_SKIP
fi
if [ "$VIS" != "PUBLIC" ] && [ "$VIS" != "PUBLIC_SKIP" ]; then
  echo
  echo "The repository is private. For the keeper to run every 5 minutes for free it has to be public"
  echo "(in a private repository the free monthly minutes run out in about a week and the keeper stops; nothing is charged)."
  echo "There are no secret keys in the code; still, decide knowing that the code becomes public."
  read -r -p "Make the repository public? (y/N) " ANS
  if [ "$ANS" = "y" ] || [ "$ANS" = "Y" ]; then
    gh repo edit "$REPO" --visibility public --accept-visibility-change-consequences && echo "The repository is public."
  else
    echo "The repository stayed private."
  fi
fi

# 5) Run once
gh workflow enable keeper -R "$REPO" > /dev/null 2>&1
STARTED=""
for i in 1 2 3 4 5 6; do
  if gh workflow run keeper -R "$REPO" > /dev/null 2>&1; then STARTED=1; echo "The keeper was started once."; break; fi
  sleep 5   # it can take a few seconds for GitHub to see the new workflow
done
[ -z "$STARTED" ] && echo "The keeper could not be started right away; it will run by itself within 5 minutes."
echo
echo "Status: https://github.com/$REPO/actions/workflows/keeper.yml"
echo "From now on the keeper runs by itself about every 5 minutes."
echo "Stop the keeper on this machine now; two keepers with the same key collide."
echo "To turn the cloud keeper off: gh variable delete KEEPER_CLOUD -R $REPO"
