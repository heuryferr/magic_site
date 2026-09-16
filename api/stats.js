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

function htmlPage(rows, totals, days, github, visits, origin) {
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
${htmlVisits(visits)}
${htmlOrigin(origin)}
</body></html>`;
}


// ── VISITAS do site (gravadas pelo api/visit) ──────────────────────────
async function visitsWindow(days) {
  const dias = [];
  for (let i = days - 1; i >= 0; i--) dias.push(localDayKey(-i));
  const p = redis.pipeline();
  dias.forEach((d) => {
    p.get(`visits:${d}`);
    p.scard(`visits:uniq:${d}`);
    p.get(`visits:bots:${d}`);
  });
  p.get("visits:total");
  const res = await p.exec();
  const rows = dias.map((d, i) => ({
    date: d,
    views: Number(res[i * 3] || 0),
    unique: Number(res[i * 3 + 1] || 0),
    bots: Number(res[i * 3 + 2] || 0),
  }));
  return {
    ok: true,
    window_days: days,
    rows,
    totals: {
      views: rows.reduce((a, r) => a + r.views, 0),
      uniques: rows.reduce((a, r) => a + r.unique, 0),
      bots: rows.reduce((a, r) => a + r.bots, 0),
      all_time_views: Number(res[dias.length * 3] || 0),
    },
  };
}

// ── De onde veio: país (x-vercel-ip-country) e conta (utm_content) ─────
async function origemWindow(days) {
  const dias = [];
  for (let i = days - 1; i >= 0; i--) dias.push(localDayKey(-i));

  // 1) quais países/contas apareceram em cada dia
  const p = redis.pipeline();
  dias.forEach((d) => {
    p.smembers(`visits:ccs:${d}`);
    p.smembers(`visits:utms:${d}`);
    p.smembers(`downloads:ccs:${d}`);
    p.smembers(`downloads:utms:${d}`);
  });
  const achados = await p.exec();
  const ccV = new Set(), utmV = new Set(), ccC = new Set(), utmC = new Set();
  achados.forEach((v, i) => {
    const arr = Array.isArray(v) ? v : [];
    const slot = i % 4;
    if (slot === 0) arr.forEach((x) => ccV.add(x));
    else if (slot === 1) arr.forEach((x) => utmV.add(x));
    else if (slot === 2) arr.forEach((x) => ccC.add(x));
    else arr.forEach((x) => utmC.add(x));
  });

  // 2) soma os contadores dia a dia
  const q = redis.pipeline();
  const jobs = [];
  const somar = (pref, chave, valores) => {
    valores.forEach((valor) => {
      dias.forEach((d) => {
        q.get(`${pref}:${chave}:${valor}:${d}`);
        jobs.push({ destino: `${pref}_${chave}`, nome: valor });
      });
    });
  };
  somar("visits", "cc", ccV);
  somar("visits", "utm", utmV);
  somar("downloads", "cc", ccC);
  somar("downloads", "utm", utmC);
  // O Upstash recusa pipeline vazio — e é o caso normal no começo, quando
  // nenhum país/conta foi registrado ainda.
  const res2 = jobs.length ? await q.exec() : [];
  const acc = {};
  res2.forEach((v, i) => {
    const job = jobs[i];
    if (!job) return;
    const n = Number(v || 0);
    if (!n) return;
    acc[job.destino] = acc[job.destino] || {};
    acc[job.destino][job.nome] = (acc[job.destino][job.nome] || 0) + n;
  });
  const lista = (chave) =>
    Object.entries(acc[chave] || {})
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

  return {
    ok: true,
    window_days: days,
    clicks_country: lista("downloads_cc"),
    clicks_utm: lista("downloads_utm"),
    visits_country: lista("visits_cc"),
    visits_utm: lista("visits_utm"),
  };
}

// ── Dimensões extras (um hash por dia): navegador, origem, página, país×conta
async function extraWindow(days) {
  const dias = [];
  for (let i = days - 1; i >= 0; i--) dias.push(localDayKey(-i));
  const p = redis.pipeline();
  dias.forEach((d) => {
    p.hgetall(`visits:x:${d}`);
    p.hgetall(`downloads:x:${d}`);
  });
  const res = await p.exec();
  const acc = {
    visits_ua: {}, visits_ref: {}, visits_path: {}, visits_ccut: {},
    clicks_ua: {}, clicks_ref: {}, clicks_path: {}, clicks_ccut: {},
  };
  res.forEach((hash, i) => {
    if (!hash || typeof hash !== "object") return;
    const destino = i % 2 === 0 ? "visits" : "clicks";
    Object.entries(hash).forEach(([campo, valor]) => {
      const corte = String(campo).indexOf(":");
      if (corte < 0) return;
      const chave = `${destino}_${String(campo).slice(0, corte)}`;
      if (!acc[chave]) return;
      const nome = String(campo).slice(corte + 1);
      acc[chave][nome] = (acc[chave][nome] || 0) + Number(valor || 0);
    });
  });
  const lista = (chave) =>
    Object.entries(acc[chave] || {})
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  return {
    ok: true,
    window_days: days,
    visits_ua: lista("visits_ua"),
    visits_ref: lista("visits_ref"),
    visits_path: lista("visits_path"),
    visits_ccut: lista("visits_ccut"),
    clicks_ua: lista("clicks_ua"),
    clicks_ref: lista("clicks_ref"),
    clicks_path: lista("clicks_path"),
    clicks_ccut: lista("clicks_ccut"),
  };
}

// ── Quadros extras do relatório HTML ───────────────────────────────────

// ── Clique por país × sistema (índice gravado pelo api/download) ────────
// O GitHub não diz QUEM nem ONDE baixou; o clique no botão diz — e é ele que
// leva ao arquivo. Gravado POR DIA (`downloads:ccf:{cc}:{file}:{dia}` e o
// índice `downloads:ccfs:{dia}`), então dá para somar qualquer período.
async function ccfWindow(days) {
  const dias = [];
  for (let i = days - 1; i >= 0; i--) dias.push(localDayKey(-i));

  const p = redis.pipeline();
  dias.forEach((d) => p.smembers(`downloads:ccfs:${d}`));
  const achados = await p.exec();

  const q = redis.pipeline();
  const jobs = [];
  achados.forEach((v, i) => {
    const dia = dias[i];
    (Array.isArray(v) ? v : []).forEach((chave) => {
      const [cc, file] = String(chave).split("|");
      if (!cc || !FILES.includes(file)) return;
      q.get(`downloads:ccf:${cc}:${file}:${dia}`);
      jobs.push({ dia, nome: `${cc}|${file}` });
    });
  });
  const res = jobs.length ? await q.exec() : [];

  const porDia = [];
  const total = {};
  res.forEach((v, i) => {
    const job = jobs[i];
    if (!job) return;
    const n = Number(v || 0);
    if (!n) return;
    porDia.push({ day: job.dia, name: job.nome, count: n });
    total[job.nome] = (total[job.nome] || 0) + n;
  });

  return {
    ok: true,
    window_days: days,
    clicks_ccf: Object.entries(total)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    clicks_ccf_dias: porDia,
  };
}
function htmlVisits(visits) {
  if (!visits || !visits.ok) return "";
  const linhas = (visits.rows || [])
    .filter((r) => r.views || r.unique || r.bots)
    .map((r) => `<tr><td>${esc(r.date)}</td><td>${r.views || 0}</td>` +
                `<td>${r.unique || 0}</td><td>${r.bots || 0}</td></tr>`)
    .join("");
  const t = visits.totals || {};
  return `
<h1 style="margin-top:42px">Site visits (our counter)</h1>
<p class="sub">Page views recorded by <code>/api/visit</code> in the window &middot; "unique" = distinct visitor (IP+UA hash) &middot; robots are counted apart.</p>
<table>
<thead><tr><th>Date</th><th>Views</th><th>Unique</th><th>Robots</th></tr></thead>
<tbody>${linhas || `<tr><td colspan="4">No visits recorded in this window.</td></tr>`}</tbody>
<tfoot><tr><td>Window</td><td>${t.views || 0}</td><td>${t.uniques || 0}</td><td>${t.bots || 0}</td></tr></tfoot>
</table>`;
}

function htmlOrigin(origin) {
  if (!origin || !origin.ok) return "";
  const bloco = (titulo, lista) => {
    const linhas = (lista || []).slice(0, 12)
      .map((r) => `<tr><td>${esc(r.name)}</td><td>${r.count || 0}</td></tr>`)
      .join("");
    return `<h2 style="font-size:15px;margin:24px 0 6px">${esc(titulo)}</h2>
<table><thead><tr><th>${esc(titulo)}</th><th>Total</th></tr></thead>
<tbody>${linhas || `<tr><td colspan="2">No data.</td></tr>`}</tbody></table>`;
  };
  return `
<h1 style="margin-top:42px">Where it came from</h1>
<p class="sub">Country = <code>x-vercel-ip-country</code> &middot; account = <code>utm_content</code> (the Magic Stat Mail sending account).</p>
${bloco("Clicks by country", origin.clicks_country)}
${bloco("Clicks by account", origin.clicks_utm)}
${bloco("Visits by country", origin.visits_country)}
${bloco("Visits by account", origin.visits_utm)}
${bloco("Visits by country · account", origin.visits_ccut)}
${bloco("Visits by browser / OS", origin.visits_ua)}
${bloco("Visits by referrer", origin.visits_ref)}
${bloco("Visits by page", origin.visits_path)}
${bloco("Clicks by country · installer", origin.clicks_ccf)}
${bloco("Clicks by browser / OS", origin.clicks_ua)}
${bloco("Clicks by country · account", origin.clicks_ccut)}`;
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

    // ── 3) Visitas do site + de onde vieram (nunca derruba o resto) ─────
    let visits = null;
    let origin = null;
    try {
      visits = await visitsWindow(days);
    } catch (err) {
      console.error("visits stats error:", err?.message ?? err);
      visits = { ok: false, error: String(err?.message ?? err) };
    }
    try {
      origin = await origemWindow(days);
    } catch (err) {
      console.error("origin stats error:", err?.message ?? err);
      origin = { ok: false, error: String(err?.message ?? err) };
    }
    try {
      const extra = await extraWindow(days);
      if (origin && origin.ok) origin = { ...origin, ...extra };
    } catch (err) {
      console.error("extra stats error:", err?.message ?? err);
    }
    try {
      const ccf = await ccfWindow(days);
      if (origin && origin.ok) origin = { ...origin, ...ccf };
    } catch (err) {
      console.error("ccf stats error:", err?.message ?? err);
    }

    if (req.query.format === "html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).send(
        htmlPage(rows, totals, days, github, visits, origin)
      );
    }

    return res.status(200).json({
      ok: true,
      days,
      generated_at: new Date().toISOString(),
      clicks: {
        totals,
        rows,
        by_country: (origin && origin.clicks_country) || [],
        by_utm: (origin && origin.clicks_utm) || [],
      },
      visits,
      origin,
      github,
    });
  } catch (err) {
    console.error("stats error:", err?.message ?? err);
    return res.status(500).json({ ok: false, error: "server_error", message: String(err?.message ?? err) });
  }
}
