#!/bin/bash
# ============================================================
# Publish the magic_site website to GitHub (repo: magic_site)
# Usage:
#   1) Authenticate with GitHub (once):
#         gh auth login
#   2) Run this script:
#         bash deploy.sh
# ============================================================
set -e
cd "$(dirname "$0")"

REPO_NAME="magic_site"
USER="${GH_USER:-heuryferr}"

echo "→ Checking GitHub authentication..."
gh auth status >/dev/null 2>&1 || { echo "❌ gh not authenticated. Run 'gh auth login' first."; exit 1; }

# 1) Ensure the origin remote exists
if ! git remote get-url origin >/dev/null 2>&1; then
  echo "→ Configuring origin remote..."
  git remote add origin "https://github.com/$USER/$REPO_NAME.git"
fi

# 2) Create the repository if it doesn't exist yet
if ! gh repo view "$USER/$REPO_NAME" >/dev/null 2>&1; then
  echo "→ Creating repository $USER/$REPO_NAME..."
  gh repo create "$REPO_NAME" --public --source=. --push \
    --description "Magic Stat institutional website" --remote=origin
else
  echo "→ Repository already exists; pushing changes..."
  git push -u origin main
fi

# 3) (Optional) Enable GitHub Pages from 'main'/'/'
echo "→ (Optional) Enabling GitHub Pages..."
gh api "repos/$USER/$REPO_NAME/pages" \
  -X POST -f "source[branch]=main" -f "source[path]=/" \
  >/dev/null 2>&1 && echo "  ✔ GitHub Pages enabled: https://$USER.github.io/$REPO_NAME/" \
  || echo "  · Pages already configured or unavailable."

echo ""
echo "✔ Site published: https://github.com/$USER/$REPO_NAME"
echo "  GitHub Pages (if enabled): https://$USER.github.io/$REPO_NAME/"
