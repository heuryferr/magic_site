// api/installs-stats.js
// ======================================================================
// Magic Stat — QUANTAS PESSOAS INSTALARAM (trial iniciado = instalou e abriu).
// ----------------------------------------------------------------------
// Pedido do dono (2026-09-23): *"exatamente quantas pessoas instalaram ... o
// cara instalou, entra, trial de 48h ja e ativada, ai conta 1 ... se puder
// dizer mais: sistema operacional, pais cidade, etc"*.
//
// POR QUE ESTE NÚMERO NÃO É O DE DOWNLOADS:
//   * o app manda UM beacon anonimo quando o TRIAL COMECA — ou seja, a pessoa
//     instalou, abriu e o app ficou utilizavel;
//   * o banco tem indice UNICO em `install_id`: a MESMA instalacao conta UMA
//     vez, por mais que o app abra 100 vezes;
//   * robo que so baixou o arquivo NAO entra aqui (nao abre o app).
//
//   GET /api/installs-stats?token=STATS_TOKEN
//   GET /api/installs-stats?token=STATS_TOKEN&format=html
//   GET /api/installs-stats?token=STATS_TOKEN&funnel=1   (cliques x instalacoes)
//   GET /api/installs-stats?token=STATS_TOKEN&rows=1     (auditoria: linhas cruas)
//
// Token: o MESMO `STATS_TOKEN` de /api/stats.
// Fonte: Postgres (Neon) — SEM Redis (o Upstash ficou reservado à licença).
//
// SEM dados pessoais: sem email, sem IP, sem hardware_id. Pais/estado/cidade
// veem dos cabecalhos do Vercel e sao COARSE (a cidade pode ser aproximada).
// ======================================================================

import { contagemInstalacoes, listarInstalacoes, agregados,
         contagemAberturas } from "./_db.js";

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

// Junta, POR DIA, os cliques em "baixar" (tabela clicks) com as instalacoes
// (trials). E a resposta honesta para "houve mil downloads e nada de
// instalacao?" — mostra as duas colunas lado a lado, da MESMA fonte (Postgres).
async function funilDiario(dados) {
  const agg = await agregados(90);
  const cliques = new Map(
    ((agg && agg.clicks && agg.clicks.rows) || []).map((r) => [
      String(r.date).slice(0, 10),
      { cliques: Number(r.total || 0), pessoas: Number(r.unique || 0) },
    ])
  );
  const instala = new Map(
    (dados.por_dia || []).map((r) => [
      String(r.dia).slice(0, 10),
      Number(r.n || 0),
    ])
  );
  const dias = new Set([...cliques.keys(), ...instala.keys()]);
  return [...dias]
    .sort()
    .reverse()
    .map((dia) => ({
      dia,
      cliques: (cliques.get(dia) || {}).cliques || 0,
      pessoas: (cliques.get(dia) || {}).pessoas || 0,
      instalacoes: instala.get(dia) || 0,
    }));
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

  const querFunil = String((req.query && req.query.funnel) || "") === "1";
  const querLinhas = String((req.query && req.query.rows) || "") === "1";
  const querAberturas = String((req.query && req.query.opens) || "") === "1";
  const funil = querFunil ? await funilDiario(dados) : null;
  const linhas = querLinhas ? await listarInstalacoes(60) : null;
  const aberturas = querAberturas ? await contagemAberturas(90) : null;

  if (String((req.query && req.query.format) || "") === "html") {
    res.setHeader("content-type", "text/html; charset=utf-8");
    return res.status(200).send(
      `<html><body style="font-family:system-ui;padding:24px">` +
        `<h2>Instalacoes (trial iniciado) — ${dados.total_reais}` +
        (dados.qa_teste
          ? ` <small>(+${dados.qa_teste} de QA/probe, fora da conta)</small>`
          : "") +
        `</h2>` +
        `<p>primeira: ${dados.primeiro || "—"} &nbsp;·&nbsp; ultima: ` +
        `${dados.ultimo || "—"}</p>` +
        (funil ? tabela("Baixar x instalar, por dia", funil,
                        ["dia", "cliques", "pessoas", "instalacoes"]) : "") +
        (aberturas
          ? `<h2>Aberturas do app — ${aberturas.total.instalacoes} instalacoes ` +
            `ativas (${aberturas.ativas_24h} nas ultimas 24h)</h2>` +
            tabela("Aberturas por dia (instalacoes distintas = uso real)",
                   aberturas.por_dia.slice(0, 30),
                   ["dia", "instalacoes", "aberturas", "em_trial",
                    "licenciadas", "bloqueadas"]) +
            tabela("Ultimas aberturas", aberturas.ultimas.map((r) => ({
                     ts: r.ts, platform: r.platform, v: r.app_version,
                     status: r.status, days_left: r.days_left,
                     local: [r.city, r.cc].filter(Boolean).join("/"),
                     install_id: r.install_id,
                     novo: r.first_open ? "1a vez" : "",
                   })),
                   ["ts", "platform", "v", "status", "days_left", "local",
                    "install_id", "novo"])
          : "") +
        tabela("Por sistema", dados.por_sistema, ["plataforma", "n"]) +
        tabela("Por pais", dados.por_pais, ["cc", "n"]) +
        tabela("Por cidade", dados.por_cidade, ["cidade", "cc", "n"]) +
        tabela("Por dia (30 mais recentes)", (dados.por_dia || []).slice(0, 30),
               ["dia", "n"]) +
        (linhas
          ? tabela("Linhas cruas (auditoria)",
                   linhas.map((r) => ({
                     ts: r.ts, platform: r.platform, cc: r.cc, city: r.city,
                     install_id: r.install_id, qa: r.qa ? "QA" : "",
                   })),
                   ["ts", "platform", "cc", "city", "install_id", "qa"])
          : "") +
        `<p style="color:#666">Conta UMA vez por instalacao (trial iniciado). ` +
        `Cliques/pessoas vem da tabela clicks do site (mesma fonte Postgres). ` +
        `Pais/cidade sao aproximados (cabecalho do Vercel).</p></body></html>`
    );
  }

  return json(res, 200, { success: true, ...dados, funil, linhas, aberturas });
}
