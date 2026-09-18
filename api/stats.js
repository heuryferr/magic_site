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

// ── Redis: cliente SOB DEMANDA + CANDIDATOS ────────────────────────────
// A Vercel cria KV_REST_API_* quando o banco vem pela KV e
// UPSTASH_REDIS_REST_* quando vem pelo Marketplace Upstash — e as duas podem
// coexistir, com a de banco APAGADO entre elas (foi o incidente de 18/09/2026).
// Criar o cliente no topo do arquivo com o par fixo UPSTASH_* fazia ESTE
// relatorio inteiro morrer em silencio. Aqui testamos os candidatos com uma
// LEITURA REAL e ficamos com o que RESPONDE; o cliente bom fica em cache.
let _redis = null;

function redisCandidates() {
  const pares = [
    [process.env.KV_REST_API_URL, process.env.KV_REST_API_TOKEN],
    [process.env.UPSTASH_REDIS_REST_URL, process.env.UPSTASH_REDIS_REST_TOKEN],
  ];
  const vistos = new Set();
  return pares.filter(([url, token]) => {
    if (!url || !token || vistos.has(url)) return false;
    vistos.add(url);
    return true;
  });
}

async function getRedis() {
  if (_redis) return _redis;
  const cands = redisCandidates();
  let lastErr = null;
  for (const [url, token] of cands) {
    const client = new Redis({ url, token });
    try {
      await client.get("magicstat:probe");
      _redis = client;
      return client;
    } catch (err) {
      lastErr = err;
      console.error("Upstash: candidato falhou, tentando o proximo:", err?.message ?? err);
    }
  }
  throw lastErr || new Error("no redis credentials in the environment");
}

const FILES = ["macos", "windows", "linux"];
const REPORT_TZ_OFFSET_MINUTES = -180; // -180 = UTC-3 (Brasília)

// ── GitHub: downloads reais dos instaladores ───────────────────────────
const GITHUB_RELEASES_REPO =
  process.env.GITHUB_RELEASES_REPO || "heuryferr/MagicStat-Releases";
const GITHUB_CACHE_SECONDS = 300; // 5 min de cache (protege o rate limit)

// ── Link privado do dono (segunda porta) ───────────────────────────────
// O Vercel NÃO permite reler um segredo já salvo: se o STATS_TOKEN for
// esquecido, o relatório fica inacessível (foi o que aconteceu). Esta porta
// aceita o link de baixo — o segredo É a própria URL, como o "qualquer um com
// o link" do Google Docs. NÃO COMPARTILHE: quem tem o link vê as contagens.
// Aqui só há número agregado (cliques/visitas/trials/vendas) e as SUAS contas
// de disparo — nunca e-mail de comprador, chave ou dado de cliente.
const LINK_TOKEN = "ms-aeb509acecfb305a6173a871";

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
    const redis = await getRedis();
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
    const redis = await getRedis();
    await redis.set(cacheKey, JSON.stringify(data), { ex: GITHUB_CACHE_SECONDS });
  } catch (err) {
    console.error("gh cache write error:", err?.message ?? err);
  }
  return data;
}

// ── LOG das últimas requisições de download (gravadas pelo api/download) ─
// Lista curta com hora + arquivo + país/estado/cidade + navegador + conta +
// referrer. É o que
// responde "quem baixou o quê, quando" sem depender do GitHub (que não expõe
// nada disso). Mais recente primeiro.
async function logWindow(limit = 500) {
  const redis = await getRedis();
  const linhas = await redis.lrange("downloads:log", 0, limit - 1);
  const itens = (linhas || [])
    .map((s) => {
      try {
        return typeof s === "string" ? JSON.parse(s) : s;
      } catch (err) {
        return null;
      }
    })
    .filter(Boolean);
  return { ok: true, itens };
}

function htmlLog(log) {
  if (!log || !log.ok) {
    return [
      '<h1 style="margin-top:42px">Last downloads (live log)</h1>',
      '<p class="sub">Unavailable' +
        (log && log.error ? ": " + esc(log.error) : "") +
        ".</p>",
    ].join("");
  }
  const linhas = (log.itens || [])
    .map(
      (e) =>
        `<tr><td>${esc(String(e.t || "").replace("T", " ").replace(/\.\d+Z$/, ""))}</td>` +
        `<td>${esc(e.f || "")}</td><td>${esc(e.cc || "")}</td>` +
        `<td>${esc(e.rg || "")}</td><td>${esc(e.ct || "")}</td>` +
        `<td>${esc(e.ua || "")}</td><td>${esc(e.conta || "")}</td>` +
        `<td>${esc(e.ref || "")}</td></tr>`
    )
    .join("");
  return `
<h1 style="margin-top:42px">Last downloads (live log)</h1>
<p class="sub">Every request that passed the gate, newest first (last ${(log.itens || []).length}). Times are UTC. <b>Cross-check:</b> what appears here went through <b>our site</b>; what GitHub gains <b>without</b> appearing here did <b>not</b> come from the site (updater/robot/direct link).</p>
<table>
<thead><tr><th>Time (UTC)</th><th>File</th><th>Country</th><th>State</th><th>City</th><th>Browser</th><th>Account</th><th>Referrer</th></tr></thead>
<tbody>${linhas || `<tr><td colspan="8">No downloads logged yet.</td></tr>`}</tbody>
</table>`;
}

function htmlPage(rows, totals, days, github, visits, origin, trials, sales, log) {
  const body = rows.length
    ? rows
        .map(
          (r) =>
            `<tr><td>${esc(r.date)}</td>` +
            FILES.map((f) => `<td>${r[f] || 0}</td>`).join("") +
            `<td><b>${r.total || 0}</b></td>` +
            `<td>${r.people || 0}</td>` +
            `<td>${r.multi || 0}</td>` +
            `<td>${r.bots || 0}</td></tr>`
        )
        .join("")
    : `<tr><td colspan="8">No clicks recorded in this window.</td></tr>`;

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
<title>Magic Stat — Report</title>
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
<p class="sub">Last ${days} day(s). <b>People</b> = distinct visitors who clicked a download button (1 per IP+UA hash) — <b>this is the real number</b>. <b>Total</b> counts every click, and e-mail link scanners ("detonators") hit all three buttons, so it runs high. <b>Multi-OS</b> = clicks from a visitor who had already taken another OS — that lockstep is why the counts move "3 in 3". <b>Blocked</b> = requests rejected as robots (they never reached GitHub).</p>
<table>
<thead><tr><th>Date</th>${FILES.map((f) => `<th>${esc(f)}</th>`).join("")}<th>Total</th><th>People</th><th>Multi-OS</th><th>Blocked</th></tr></thead>
<tbody>${body}</tbody>
<tfoot><tr><td>All time</td>${FILES.map((f) => `<td>${totals[f] || 0}</td>`).join("")}<td>${totals.total || 0}</td><td>${totals.people || 0}</td><td>—</td><td>${totals.bots || 0}</td></tr></tfoot>
</table>
${gh}
${htmlLog(log)}
${htmlVisits(visits)}
${htmlOrigin(origin)}
${htmlTrials(trials)}
${htmlSales(sales)}
</body></html>`;
}


// ── VISITAS do site (gravadas pelo api/visit) ──────────────────────────
async function visitsWindow(days) {
    const redis = await getRedis();
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
    const redis = await getRedis();
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
    const redis = await getRedis();
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
    const redis = await getRedis();
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
// ── TRIALS começados (beacon /api/trial-start) ─────────────────────────
// Uma linha por instalação, quando o trial de 7 dias começa. É ANÔNIMO: sem
// email, sem IP, sem hardware — só plataforma + versão (ver api/trial-start.js).
async function trialsWindow(days) {
  const redis = await getRedis();
  const dias = [];
  for (let i = days - 1; i >= 0; i--) dias.push(localDayKey(-i));
  const p = redis.pipeline();
  dias.forEach((d) => {
    FILES.forEach((f) => p.get(`stats:trial:${d}:${f}`));
    p.get(`stats:trial:${d}:total`);
  });
  const res = await p.exec();
  const porDia = FILES.length + 1;
  const rows = dias.map((d, i) => {
    const base = i * porDia;
    const row = { date: d };
    FILES.forEach((f, fi) => (row[f] = Number(res[base + fi] || 0)));
    row.total = Number(res[base + FILES.length] || 0);
    return row;
  });
  const totals = { total: 0 };
  FILES.forEach((f) => (totals[f] = 0));
  rows.forEach((r) => {
    FILES.forEach((f) => (totals[f] += r[f]));
    totals.total += r.total;
  });
  return { ok: true, window_days: days, rows, totals };
}

// ── VENDAS/ATIVAÇÕES (analytics:sales:<dia> — SADD de um JSON por ativação) ──
async function salesWindow(days) {
  const redis = await getRedis();
  const dias = [];
  for (let i = days - 1; i >= 0; i--) dias.push(localDayKey(-i));

  // Detalhe por plataforma/país. O volume é pequeno, então UM smembers por dia
  // basta. IMPORTANTE: cada registro é uma VALIDAÇÃO de licença, e o mesmo app
  // revalida de tempos em tempos — isso NÃO é venda nova. Por isso contamos
  // licenças DISTINTAS (`license_key`), não eventos. Registro sem chave conta
  // como um (não dá para deduplicar).
  const q = redis.pipeline();
  dias.forEach((d) => q.smembers(`analytics:sales:${d}`));
  const membros = await q.exec();
  const porPlataforma = {};
  const porPais = {};
  const vistas = new Set();
  const porDia = dias.map(() => new Set());
  let total = 0;
  membros.forEach((lista, i) => {
    (Array.isArray(lista) ? lista : []).forEach((bruto) => {
      let reg = null;
      try {
        reg = typeof bruto === "string" ? JSON.parse(bruto) : bruto;
      } catch (err) {
        reg = null;
      }
      if (!reg || typeof reg !== "object") return;
      const chave = String(reg.license_key || "").trim();
      if (chave) {
        if (vistas.has(chave)) return;   // revalidação: não é venda nova
        vistas.add(chave);
      }
      total += 1;
      porDia[i].add(chave || `sem-chave:${i}:${bruto}`);
      const plat = String(reg.platform || "unknown");
      const pais = String(reg.country || "??");
      porPlataforma[plat] = (porPlataforma[plat] || 0) + 1;
      porPais[pais] = (porPais[pais] || 0) + 1;
    });
  });
  const rows = dias.map((d, i) => ({ date: d, sales: porDia[i].size }));
  const ordena = (obj) =>
    Object.entries(obj)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  return {
    ok: true,
    window_days: days,
    rows,
    window_total: rows.reduce((acc, r) => acc + r.sales, 0),
    total,
    by_platform: ordena(porPlataforma),
    by_country: ordena(porPais),
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

function htmlTrials(trials) {
  if (!trials || !trials.ok) {
    return [
      '<h1 style="margin-top:42px">Trials started</h1>',
      '<p class="sub">Unavailable' +
        (trials && trials.error ? ": " + esc(trials.error) : "") +
        ".</p>",
    ].join("");
  }
  const linhas = (trials.rows || [])
    .filter((r) => r.total)
    .map(
      (r) =>
        `<tr><td>${esc(r.date)}</td>` +
        FILES.map((f) => `<td>${r[f] || 0}</td>`).join("") +
        `<td><b>${r.total || 0}</b></td></tr>`
    )
    .join("");
  const t = trials.totals || {};
  return `
<h1 style="margin-top:42px">Trials started (7-day trial)</h1>
<p class="sub">One per installation, pinged by the app when the trial begins (<code>/api/trial-start</code>). Anonymous: no email, no IP.</p>
<table>
<thead><tr><th>Date</th>${FILES.map((f) => `<th>${esc(f)}</th>`).join("")}<th>Total</th></tr></thead>
<tbody>${linhas || `<tr><td colspan="${FILES.length + 2}">No trials started in this window.</td></tr>`}</tbody>
<tfoot><tr><td>Window</td>${FILES.map((f) => `<td>${t[f] || 0}</td>`).join("")}<td>${t.total || 0}</td></tr></tfoot>
</table>`;
}

function htmlSales(sales) {
  if (!sales || !sales.ok) {
    return [
      '<h1 style="margin-top:42px">Sales / activations</h1>',
      '<p class="sub">Unavailable' +
        (sales && sales.error ? ": " + esc(sales.error) : "") +
        ".</p>",
    ].join("");
  }
  const linhas = (sales.rows || [])
    .filter((r) => r.sales)
    .map((r) => `<tr><td>${esc(r.date)}</td><td>${r.sales || 0}</td></tr>`)
    .join("");
  const bloco = (titulo, lista) => {
    const rows = (lista || [])
      .map((r) => `<tr><td>${esc(r.name)}</td><td>${r.count || 0}</td></tr>`)
      .join("");
    return `<h2 style="font-size:15px;margin:24px 0 6px">${esc(titulo)}</h2>
<table><thead><tr><th>${esc(titulo)}</th><th>Activations</th></tr></thead>
<tbody>${rows || `<tr><td colspan="2">No data.</td></tr>`}</tbody></table>`;
  };
  return `
<h1 style="margin-top:42px">Sales / activations (licensed)</h1>
<p class="sub">A license valid and registered on our server &middot; window total: <b>${sales.window_total || 0}</b>.</p>
<table>
<thead><tr><th>Date</th><th>Activations</th></tr></thead>
<tbody>${linhas || `<tr><td colspan="2">No activations in this window.</td></tr>`}</tbody>
<tfoot><tr><td>Window</td><td>${sales.window_total || 0}</td></tr></tfoot>
</table>
${bloco("By platform", sales.by_platform)}
${bloco("By country", sales.by_country)}`;
}

export default async function handler(req, res) {
  const expected = process.env.STATS_TOKEN;
  const token = String(req.query.token || req.headers["x-stats-token"] || "");

  // O link privado do dono vale sempre (porta de emergência); o token do
  // Vercel continua valendo como antes.
  const viaLink = Boolean(token) && token === LINK_TOKEN;
  if (!viaLink) {
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
  }

  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);

  try {
    const redis = await getRedis();
    // ── 1) Nosso contador: cliques (GET) + únicos (SCARD) por dia ───────
    const pipe = redis.pipeline();
    const plan = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = localDayKey(-i);
      const row = { date, total: 0, unique: 0, bots: 0, people: 0, multi: 0 };
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

    // cliques BLOQUEADOS (robô óbvio, sem página, multi-OS) — à parte
    const botPipe = redis.pipeline();
    plan.forEach((p) =>
      FILES.forEach((f) => botPipe.get(`downloads:bot:${f}:${p.date}`)));
    const botResults = await botPipe.exec();

    // PESSOAS (1 hash por dia) e multi-OS (máquina) — réguas à parte
    const pessPipe = redis.pipeline();
    plan.forEach((p) => {
      pessPipe.scard(`downloads:pessoas:${p.date}`);
      pessPipe.get(`downloads:multi:${p.date}`);
    });
    const pessResults = await pessPipe.exec();

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
      p.row.bots = FILES.reduce(
        (acc, _f, fi) => acc + Number(botResults[off + fi] || 0), 0);
      p.row.people = Number(pessResults[pi * 2] || 0);
      p.row.multi = Number(pessResults[pi * 2 + 1] || 0);
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
    const botTotPipe = redis.pipeline();
    FILES.forEach((f) => botTotPipe.get(`downloads:bot:${f}`));
    const botTotRes = await botTotPipe.exec();
    totals.bots = FILES.reduce(
      (acc, _f, i) => acc + Number(botTotRes[i] || 0), 0);
    // PESSOAS distintas desde sempre (1 hash por pessoa, sem recorte de dia)
    totals.people = Number((await redis.scard("downloads:pessoas")) || 0);

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

    // ── 4) Trials iniciados + vendas/ativações (nunca derruba o resto) ──
    let trials = null;
    let sales = null;
    try {
      trials = await trialsWindow(days);
    } catch (err) {
      console.error("trials stats error:", err?.message ?? err);
      trials = { ok: false, error: String(err?.message ?? err) };
    }
    try {
      sales = await salesWindow(days);
    } catch (err) {
      console.error("sales stats error:", err?.message ?? err);
      sales = { ok: false, error: String(err?.message ?? err) };
    }
    try {
      const ccf = await ccfWindow(days);
      if (origin && origin.ok) origin = { ...origin, ...ccf };
    } catch (err) {
      console.error("ccf stats error:", err?.message ?? err);
    }

    // ── 5) LOG das últimas requisições de download (best-effort) ────────
    let log = null;
    try {
      log = await logWindow();
    } catch (err) {
      console.error("log stats error:", err?.message ?? err);
      log = { ok: false, error: String(err?.message ?? err) };
    }

    if (req.query.format === "html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).send(
        htmlPage(rows, totals, days, github, visits, origin, trials, sales, log)
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
      trials,
      sales,
      log,
    });
  } catch (err) {
    console.error("stats error:", err?.message ?? err);
    return res.status(500).json({ ok: false, error: "server_error", message: String(err?.message ?? err) });
  }
}
