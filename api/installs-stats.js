// api/installs-stats.js
// ======================================================================
// Magic Stat — QUANTAS PESSOAS INSTALARAM (trial iniciado = instalou e abriu).
// ----------------------------------------------------------------------
// Pedido do dono (2026-09-23): *"exatamente quantas pessoas instalaram ... o
// cara instalou, entra, trial de 48h ja e ativada, ai conta 1 ... se puder
// dizer mais: sistema operacional, pais cidade, etc"*.
//
// POR QUE ESTE NÚMERO É MAIS CONFIÁVEL QUE O DE DOWNLOADS:
//   * o app manda UM beacon anonimo quando o TRIAL COMECA — ou seja, a pessoa
//     instalou, abriu e o app ficou utilizavel;
//   * o banco tem indice UNICO em `install_id`: a MESMA instalacao conta UMA
//     vez, por mais que o app abra 100 vezes;
//   * robo que so baixou o arquivo NAO entra aqui (nao abre o app).
//
//   GET /api/installs-stats?token=STATS_TOKEN
//   GET /api/installs-stats?token=STATS_TOKEN&format=html
//
// Token: o MESMO `STATS_TOKEN` de /api/stats.
// Fonte: Postgres (Neon) — SEM Redis (o Upstash ficou reservado à licença, e a
// cota dele já derrubou o /api/stats uma vez).
//
// SEM dados pessoais: sem email, sem IP, sem hardware_id. Pais/estado/cidade
// veem dos cabecalhos do Vercel e sao COARSE (a cidade pode ser aproximada).
// ======================================================================

import { contagemInstalacoes } from "./_db.js";

const json = (res, status, body) => res.status(status).json(body);

function tabela(titulo, linhas, chaves) {
  return (
    `<h4>${titulo}</h4>` +
    `<table border="1" cellpadding="6" cellspacing="0"><tr>` +
    chaves.map((c) => `<th>${c}</th>`).join("") +
    `</tr>` +
    (linhas || [])
      .map(
        (r) =>
          "<tr>" + chaves.map((c) => `<td>${r[c] ?? ""}</td>`).join("") + "</tr>"
      )
      .join("") +
    `</table>`
  );
}

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

  const dados = await contagemInstalacoes();
  if (dados === null) {
    return json(res, 503, {
      success: false,
      error: "installs_registry_unavailable",
      message: "Falha ao ler as instalacoes.",
    });
  }

  if (String((req.query && req.query.format) || "") === "html") {
    res.setHeader("content-type", "text/html; charset=utf-8");
    return res.status(200).send(
      `<html><body style="font-family:system-ui;padding:24px">` +
        `<h2>Instalacoes (trial iniciado) — total ${dados.total}</h2>` +
        `<p>primeira: ${dados.primeiro || "—"} &nbsp;·&nbsp; ultima: ` +
        `${dados.ultimo || "—"}</p>` +
        tabela("Por sistema", dados.por_sistema, ["plataforma", "n"]) +
        tabela("Por pais", dados.por_pais, ["cc", "n"]) +
        tabela("Por cidade", dados.por_cidade, ["cidade", "cc", "n"]) +
        tabela("Por dia (30 mais recentes)", (dados.por_dia || []).slice(0, 30),
               ["dia", "n"]) +
        `<p style="color:#666">Conta UMA vez por instalacao (trial iniciado). ` +
        `Pais/cidade sao aproximados (cabecalho do Vercel).</p></body></html>`
    );
  }

  return json(res, 200, { success: true, ...dados });
}
