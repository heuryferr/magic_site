// api/update-notice-stats.js
// ======================================================================
// Magic Stat — QUANTAS INSTALAÇÕES VIRAM O AVISO DE ATUALIZAÇÃO.
// ----------------------------------------------------------------------
// Responde a pergunta do dono (2026-09-23): *"so quero saber quantas foram
// avisadas"*. O app manda o evento para /api/update-notice quando MOSTRA o
// diálogo de atualização (aquele que carrega o aviso/promoção); aqui a gente lê
// a contagem no Postgres e devolve o número — por versão oferecida, por
// plataforma e por VERSÃO DE ORIGEM (de onde o cliente veio, "quem está atrás").
//
//   GET /api/update-notice-stats?token=STATS_TOKEN
//   GET /api/update-notice-stats?token=STATS_TOKEN&format=html
//
// Token: o MESMO `STATS_TOKEN` de /api/stats (Vercel → Environment Variables).
//
// SEM dados pessoais: só contadores agregados. O install_id NUNCA sai daqui.
// ======================================================================

import { contagemAvisos } from "./_db.js";

const json = (res, status, body) => res.status(status).json(body);

export default async function handler(req, res) {
  const expected = process.env.STATS_TOKEN;
  const given = String((req.query && req.query.token) || "").trim();
  if (!expected || given !== expected) {
    return json(res, 401, {
      success: false,
      error: "unauthorized",
      message: expected
        ? "Token invalido (use ?token=STATS_TOKEN)."
        : "Set STATS_TOKEN in Vercel -> Environment Variables.",
    });
  }

  const linhas = await contagemAvisos();
  if (linhas === null) {
    return json(res, 503, {
      success: false,
      error: "notice_registry_unavailable",
      message: "Falha ao ler a contagem de avisos.",
    });
  }

  const total = linhas.reduce((s, r) => s + Number(r.total || 0), 0);
  const payload = {
    success: true,
    generated_at: new Date().toISOString(),
    grand_total: total,
    versions: linhas,
    note:
      "Cada linha = instalacoes que VIRAM o aviso daquela versao, uma vez por " +
      "(instalacao, versao oferecida). 'from' = de qual versao o cliente veio.",
  };

  if (String((req.query && req.query.format) || "") === "html") {
    const corpo = linhas
      .map((r) => {
        const from = Object.entries(r.from || {})
          .map(([k, n]) => `${k}: ${n}`)
          .join("<br>");
        return (
          `<tr><td><b>${r.offered_version}</b></td><td>${r.total}</td>` +
          `<td>${r.macos || 0}</td><td>${r.windows || 0}</td><td>${r.linux || 0}</td>` +
          `<td>${from}</td></tr>`
        );
      })
      .join("");
    res.setHeader("content-type", "text/html; charset=utf-8");
    return res.status(200).send(
      `<html><body style="font-family:system-ui;padding:24px">` +
        `<h2>Avisos de atualizacao vistos — total ${total}</h2>` +
        `<table border="1" cellpadding="8" cellspacing="0">` +
        `<tr><th>Versao oferecida</th><th>Total</th><th>macOS</th>` +
        `<th>Windows</th><th>Linux</th><th>De onde vieram</th></tr>` +
        corpo +
        `</table><p style="color:#666">${payload.note}</p>` +
        `</body></html>`
    );
  }

  return json(res, 200, payload);
}
