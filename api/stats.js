// api/stats.js
// ======================================================================
// Magic Stat — contabilidade de downloads (relatório).
// ----------------------------------------------------------------------
// Duas fontes, para comparar "clicaram" vs "baixaram de fato":
//   1. NOSSO contador (api/download)  → cliques por dia + visitantes únicos;
//   2. GITHUB (download_count real)   → downloads concluídos de cada asset.
//
// Protegido por token. Configure no Vercel:
//     Settings → Environment Variables → STATS_TOKEN = (um segredo seu)
//
// Como consultar:
//     /api/stats?token=SEU_TOKEN              → JSON
//     /api/stats?token=SEU_TOKEN&format=html  → tabela para ler no navegador
//     &days=30                                → janela (padrão 30, máx 365)
//
// Opcional:
//     GITHUB_TOKEN        → aumenta o limite da API do GitHub (recomendado)
//     GITHUB_RELEASES_REPO → padrão "heuryferr/MagicStat-Releases"
// ======================================================================

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const FILES = ["macos", "windows", "linux"];
const REPORT_TZ_OFFSET_MINUTES = -180; // -180 = UTC-3 (Brasília)

// ── GitHub: downloads reais dos instaladores ───────────────────────────
const GITHUB_RELEASES_REPO =
  process.env.GITHUB_RELEASES_REPO || "heuryferr/MagicStat-Releases";
const GITHUB_CACHE_SECONDS = 300; // 5 min de cache (protege o rate limit)

function localDayKey(offsetDays = 0) {
  const now = Date.now() + REPORT_TZ_OFFSET_MINUTES * 60 * 1000;
  const d = new Date(now + offsetDays * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function esc(v) {
  return String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function classify(name) {
  const n = String(name).toLowerCase();
  if (n.endsWith(".pkg") || n.endsWith(".dmg")) return "macos";
  if (n.endsWith(".exe") || n.endsWith(".msi")) return "windows";
  if (n.endsWith(".appimage") || n.endsWith(".deb") || n.endsWith(".rpm")) return "linux";
  return "other";
}

async function githubDownloads() {
  const cacheKey = `gh:releases:${GITHUB_RELEASES_REPO}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) return typeof cached === "string" ? JSON.parse(cached) : cached;
  } catch (err) {
    console.error("gh cache read error:", err?.message ?? err);
  }

  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "magic-stat-site",
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_RELEASES_REPO}/releases?per_page=100`,
    { headers }
  );
  if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
  const releases = await res.json();

  const totals = { macos: 0, windows: 0, linux: 0, other: 0, total: 0 };
  const assets = [];
  const relRows = [];
  for (const rel of releases) {
    let relTotal = 0;
    for (const a of rel.assets || []) {
      const count = Number(a.download_count || 0);
      const plat = classify(a.name);
      totals[plat] += count;
      totals.total += count;
      relTotal += count;
      assets.push({
        name: a.name,
        platform: plat,
        count,
        release: rel.tag_name,
        url: a.browser_download_url,
      });
    }
    relRows.push({
      tag: rel.tag_name,
      name: rel.name || rel.tag_name,
      published_at: rel.published_at,
      total: relTotal,
    });
  }

  const data = {
    ok: true,
    repo: GITHUB_RELEASES_REPO,
    totals,
    assets,
    releases: relRows,
    fetched_at: new Date().toISOString(),
  };
  try {
    await redis.set(cacheKey, JSON.stringify(data), { ex: GITHUB_CACHE_SECONDS });
  } catch (err) {
    console.error("gh cache write error:", err?.message ?? err);
  }
  return data;
}

function htmlPage(rows, totals, days, github) {
  const body = rows.length
    ? rows
        .map(
          (r) =>
            `<tr><td>${esc(r.date)}</td>` +
            FILES.map((f) => `<td>${r[f] || 0}</td>`).join("") +
            `<td><b>${r.total || 0}</b></td>` +
            `<td>${r.unique || 0}</td></tr>`
        )
        .join("")
    : `<tr><td colspan="6">No clicks recorded in this window.</td></tr>`;

  let gh = "";
  if (github && github.ok) {
    const relRows = (github.releases || [])
      .map(
        (r) =>
          `<tr><td>${esc(r.tag)}</td><td>${esc(r.name || "")}</td><td>${r.total || 0}</td></tr>`
      )
      .join("");
    gh = `
<h1 style="margin-top:42px">Installer downloads (GitHub · real)</h1>
<p class="sub">Completed downloads counted by GitHub for <b>${esc(github.repo)}</b> — assets older than the ones below also included in totals.</p>
<table>
<thead><tr><th>Release</th><th>Name</th><th>Downloads</th></tr></thead>
<tbody>${relRows || `<tr><td colspan="3">No releases found.</td></tr>`}</tbody>
<tfoot><tr><td>All releases</td><td>macOS ${github.totals.macos || 0} · Windows ${github.totals.windows || 0} · Linux ${github.totals.linux || 0}${github.totals.other ? ` · other ${github.totals.other}` : ""}</td><td>${github.totals.total || 0}</td></tr></tfoot>
</table>`;
  } else {
    gh = `<p class="sub" style="margin-top:30px">GitHub stats unavailable${github && github.error ? `: ${esc(github.error)}` : ""}.</p>`;
  }

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Magic Stat — Downloads</title>
<style>
 body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0e1a;color:#eef1ff;margin:0;padding:32px}
 h1{font-size:20px;font-weight:800;margin:0 0 6px}
 p.sub{color:#a6aed6;font-size:14px;margin:0 0 22px}
 table{border-collapse:collapse;width:100%;max-width:760px;font-size:14px}
 th,td{padding:9px 12px;border-bottom:1px solid rgba(255,255,255,.08);text-align:right}
 th:first-child,td:first-child{text-align:left}
 thead th{color:#b986ff;font-size:12px;letter-spacing:.06em;text-transform:uppercase}
 tfoot td{border-top:1px solid rgba(124,140,255,.5);font-weight:800;color:#fff}
</style></head><body>
<h1>Magic Stat — site clicks (our counter)</h1>
<p class="sub">Last ${days} day(s) &middot; "unique" = distinct visitors (IP+UA hash), not raw IPs.</p>
<table>
<thead><tr><th>Date</th>${FILES.map((f) => `<th>${esc(f)}</th>`).join("")}<th>Total</th><th>Unique</th></tr></thead>
<tbody>${body}</tbody>
<tfoot><tr><td>All time</td>${FILES.map((f) => `<td>${totals[f] || 0}</td>`).join("")}<td>${totals.total || 0}</td><td>—</td></tr></tfoot>
</table>
${gh}
</body></html>`;
}

export default async function handler(req, res) {
  const expected = process.env.STATS_TOKEN;
  const token = String(req.query.token || req.headers["x-stats-token"] || "");

  if (!expected) {
    return res.status(500).json({
      ok: false,
      error: "stats_token_not_configured",
      message: "Set STATS_TOKEN in Vercel → Environment Variables.",
    });
  }
  if (token !== expected) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);

  try {
    // ── 1) Nosso contador: cliques (GET) + únicos (SCARD) por dia ───────
    const pipe = redis.pipeline();
    const plan = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = localDayKey(-i);
      const row = { date, total: 0, unique: 0 };
      FILES.forEach((f) => (row[f] = 0));
      plan.push({ date, row, uniqueKeys: [] });
      FILES.forEach((f) => {
        pipe.get(`downloads:${f}:${date}`);
        plan[plan.length - 1].uniqueKeys.push(`downloads:uniq:${f}:${date}`);
      });
    }
    const results = await pipe.exec();

    const uniqPipe = redis.pipeline();
    plan.forEach((p) => p.uniqueKeys.forEach((k) => uniqPipe.scard(k)));
    const uniqResults = await uniqPipe.exec();

    let idx = 0;
    plan.forEach((p, pi) => {
      FILES.forEach((f) => {
        const v = Number(results[idx] || 0);
        idx += 1;
        p.row[f] = v;
        p.row.total += v;
      });
      const off = pi * FILES.length;
      p.row.unique = FILES.reduce((acc, _f, fi) => acc + Number(uniqResults[off + fi] || 0), 0);
    });
    const rows = plan.map((p) => p.row);

    const totPipe = redis.pipeline();
    FILES.forEach((f) => totPipe.get(`downloads:${f}:total`));
    const totRes = await totPipe.exec();
    const totals = {};
    let grand = 0;
    FILES.forEach((f, i) => {
      totals[f] = Number(totRes[i] || 0);
      grand += totals[f];
    });
    totals.total = grand;

    // ── 2) GitHub: downloads reais (best-effort, com cache) ─────────────
    let github = null;
    try {
      github = await githubDownloads();
    } catch (err) {
      console.error("github stats error:", err?.message ?? err);
      github = { ok: false, error: String(err?.message ?? err) };
    }

    if (req.query.format === "html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).send(htmlPage(rows, totals, days, github));
    }

    return res.status(200).json({
      ok: true,
      days,
      generated_at: new Date().toISOString(),
      clicks: { totals, rows },
      github,
    });
  } catch (err) {
    console.error("stats error:", err?.message ?? err);
    return res.status(500).json({ ok: false, error: "server_error", message: String(err?.message ?? err) });
  }
}
