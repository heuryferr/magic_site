// api/stats.js
// ======================================================================
// Magic Stat — contabilidade DIÁRIA dos downloads (relatório).
// ----------------------------------------------------------------------
// Protegido por token. Configure no Vercel:
//     Settings → Environment Variables → STATS_TOKEN = (um segredo seu)
//
// Como consultar:
//     /api/stats?token=SEU_TOKEN              → JSON
//     /api/stats?token=SEU_TOKEN&format=html  → tabela para ler no navegador
//     &days=30                                → janela (padrão 30, máx 365)
//
// O contador é alimentado por /api/download (cliques) e conta também os
// visitantes ÚNICOS por dia (hash do IP+user-agent, sem guardar o IP cru).
// ======================================================================

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const FILES = ["macos", "windows", "linux"];
const REPORT_TZ_OFFSET_MINUTES = -180; // -180 = UTC-3 (Brasília)

function localDayKey(offsetDays = 0) {
  const now = Date.now() + REPORT_TZ_OFFSET_MINUTES * 60 * 1000;
  const d = new Date(now + offsetDays * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function esc(v) {
  return String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function htmlPage(rows, totals, days) {
  const head = rows.length
    ? rows
        .map(
          (r) =>
            `<tr><td>${esc(r.date)}</td>` +
            FILES.map((f) => `<td>${r[f] || 0}</td>`).join("") +
            `<td><b>${r.total || 0}</b></td>` +
            `<td>${r.unique || 0}</td></tr>`
        )
        .join("")
    : `<tr><td colspan="6">Sem downloads registrados na janela.</td></tr>`;
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
<h1>Magic Stat — daily downloads</h1>
<p class="sub">Last ${days} day(s) &middot; "unique" = distinct visitors (IP+UA hash), not raw IPs.</p>
<table>
<thead><tr><th>Date</th>${FILES.map((f) => `<th>${esc(f)}</th>`).join("")}<th>Total</th><th>Unique</th></tr></thead>
<tbody>${head}</tbody>
<tfoot><tr><td>All time</td>${FILES.map((f) => `<td>${totals[f] || 0}</td>`).join("")}<td>${totals.total || 0}</td><td>—</td></tr></tfoot>
</table></body></html>`;
}

export default async function handler(req, res) {
  const expected = process.env.STATS_TOKEN;
  const token = String(req.query.token || req.headers["x-stats-token"] || "");

  if (!expected) {
    return res
      .status(500)
      .json({ ok: false, error: "stats_token_not_configured", message: "Set STATS_TOKEN in Vercel → Environment Variables." });
  }
  if (token !== expected) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);

  try {
    // Pipeline: cliques (GET) + únicos (SCARD) de cada dia/plataforma.
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

    // exec() devolve só os GETs; os únicos vêm num segundo pipeline.
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

    // Totais gerais (all-time).
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

    if (req.query.format === "html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).send(htmlPage(rows, totals, days));
    }

    return res.status(200).json({ ok: true, days, generated_at: new Date().toISOString(), totals, rows });
  } catch (err) {
    console.error("stats error:", err?.message ?? err);
    return res.status(500).json({ ok: false, error: "server_error", message: String(err?.message ?? err) });
  }
}
