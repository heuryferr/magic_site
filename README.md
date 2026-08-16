# 🎩 Magic Stat — Site institucional

Site de divulgação do **Magic Stat**, software de análise estatística com
qualidade de publicação, IA acoplada e relatórios científicos prontos para a
sua paper.

## ✨ Destaques

- **Carrossel** de screenshots reais de gráficos gerados no app.
- **Assistente de IA** destacado como o grande diferencial (BYOK — OpenAI,
  Claude, Gemini, DeepSeek, OpenRouter ou modelos locais).
- **Relatórios científicos diferenciados** — tabelas no formato APA/editorial e
  comentadas por IA.
- **Doze domínios de funcionalidades**: SEM/PLS, Psicometria, Ecologia, Séries
  temporais, Modelos mistos, Estatística médica, Multivariada, Meta-análise,
  Análise de poder, Bayesiana, Regressão & correlação e análises clássicas.
- Visual dark moderno (glassmorphism, gradientes, animações) — feito com
  **HTML/CSS/JS puro**, sem frameworks.

## 📁 Estrutura

```
magic_site/
├── index.html
├── assets/
│   ├── css/style.css
│   ├── js/main.js
│   ├── img/        (logo cartola + favicon)
│   └── screenshots (gráficos reais do app)
└── README.md
```

## 🚀 Como rodar localmente

Abra o `index.html` no navegador, ou suba um servidor simples:

```bash
cd magic_site
python -m http.server 8080
# → http://localhost:8080
```

## 📦 Download do app

O botão "Baixar" espera o instalador `MagicStat.pkg` no diretório raiz do site
(ou um caminho configurado no `index.html`). Copie o `.pkg` para cá antes de
publicar:

```bash
cp ~/Desktop/MagicStat.pkg ./MagicStat.pkg
```

## 🧙 GitHub Pages

Para publicar como o GitHub Pages, coloque `MagicStat.pkg` na raiz e ajuste o
hyperlink "Baixar" no `index.html` para o endereço do arquivo (GitHub Pages
costuma limitar grandes binários — verifique a política de repositório para
arquivos >100 MB).
