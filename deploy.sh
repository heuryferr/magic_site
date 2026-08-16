#!/bin/bash
# ============================================================
# Publica o site magic_site no GitHub (repo: magic_site)
# Uso:
#   1) Autentique o GitHub (uma vez):
#         gh auth login
#   2) Rode este script:
#         bash deploy.sh
# ============================================================
set -e
cd "$(dirname "$0")"

REPO_NAME="magic_site"
USER="${GH_USER:-heuryfer}"

echo "→ Verificando autenticacao do GitHub..."
gh auth status >/dev/null 2>&1 || { echo "❌ gh não autenticado. Rode 'gh auth login' primeiro."; exit 1; }

# 1) Garante o remote origin
if ! git remote get-url origin >/dev/null 2>&1; then
  echo "→ Configurando remote origin..."
  git remote add origin "https://github.com/$USER/$REPO_NAME.git"
fi

# 2) Cria o repositório, se ainda não existir
if ! gh repo view "$USER/$REPO_NAME" >/dev/null 2>&1; then
  echo "→ Criando repositório $USER/$REPO_NAME..."
  gh repo create "$REPO_NAME" --public --source=. --push \
    --description "Site institucional do Magic Stat" --remote=origin
else
  echo "→ Repositório já existe; enviando alterações..."
  git push -u origin main
fi

# 3) (Opcional) Ativa o GitHub Pages a partir de 'main'/'/' (branch raiz)
echo "→ (Opcional) Ativando GitHub Pages..."
gh api "repos/$USER/$REPO_NAME/pages" \
  -X POST -f "source[branch]=main" -f "source[path]=/" \
  >/dev/null 2>&1 && echo "  ✔ GitHub Pages ativado: https://$USER.github.io/$REPO_NAME/" \
  || echo "  · Paginas já configuradas ou indisponíveis."

echo ""
echo "✔ Site publicado: https://github.com/$USER/$REPO_NAME"
echo "  GitHub Pages (se ativado): https://$USER.github.io/$REPO_NAME/"
