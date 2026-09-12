# 🎩 Magic Stat — Official website

Institutional website for **Magic Stat** — statistical analysis software with
publication-quality output, built-in AI and scientific reports ready for your
paper.

## ✨ Highlights

- **AI data scientist** — plug your favorite language model via API (BYOK:
  OpenAI, Claude, Gemini, DeepSeek, OpenRouter or local) and **operate the
  whole program by conversation**: it runs real analyses, creates figures and
  tables, and discusses the results.
- **Carousel** of real screenshots of figures generated inside the app, plus a
  fullscreen lightbox that shows each figure at its **original resolution**.
- **Differentiated scientific reports** — tables in APA/editorial format and
  commented by AI.
- **Twelve feature domains**: SEM/PLS, Psychometrics, Ecology, Time series,
  Mixed models, Medical statistics, Multivariate, Meta-analysis, Power
  analysis, Bayesian, Regression & correlation, and classics.
- Modern dark visual (glassmorphism, gradients, animations) — built in clean
  **HTML/CSS/JS**, no frameworks.

## 📁 Structure

```
magic_site/
├── index.html
├── deploy.sh
├── assets/
│   ├── css/style.css
│   ├── js/main.js
│   ├── img/        (top-hat logo + favicon)
│   └── screenshots (real figures from the app)
└── README.md
```

## 🚀 Run locally

Open `index.html` in the browser, or serve it:

```bash
cd magic_site
python -m http.server 8080
# → http://localhost:8080
```

## 📦 Download

The "Download" button expects the `MagicStat.pkg` installer in the site root
(or a configured path in `index.html`). Copy the `.pkg` here before publishing:

```bash
cp ~/Desktop/MagicStat.pkg ./MagicStat.pkg
```

> Note: GitHub Pages limits files over 100 MB. For the ~260 MB `.pkg`, host it
> via GitHub Releases or elsewhere and point the button to that URL.

## 📊 Download analytics (Vercel + Upstash Redis)

Two serverless functions keep a **daily count of downloads**:

- `api/download.js` — counts the click (per day + unique visitors) and
  redirects to the real installer. Wire a button with:
  ```html
  <a href="/api/download?file=macos" class="btn btn-primary">Download for macOS</a>
  ```
  Update the installer URL in `FILES` (single place) on every release.
- `api/stats.js` — daily report, protected by a token:
  ```
  /api/stats?token=YOUR_TOKEN              # JSON
  /api/stats?token=YOUR_TOKEN&format=html  # table in the browser
  /api/stats?token=YOUR_TOKEN&days=90      # window (default 30, max 365)
  ```

### Environment variables (Vercel → Settings → Environment Variables)

| Variable | Purpose |
|----------|---------|
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Already set (license server) |
| `DOWNLOAD_ENABLED` | `1` opens downloads; anything else keeps 404 (pre-launch) |
| `STATS_TOKEN` | Secret required by `/api/stats` |
| `DOWNLOAD_IP_SALT` *(optional)* | Salt for the visitor hash (unique counts) |

Counting is best-effort: if Redis fails, the download still works.

## 🧙 Publish

```bash
bash deploy.sh
```
