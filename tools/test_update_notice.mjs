// tools/test_update_notice.mjs
// ======================================================================
// Prova que a contagem de AVISOS VISTOS funciona — sem banco de verdade.
// ----------------------------------------------------------------------
// Dono (2026-09-23): *"SO QUERO QUE O APP GRAVE ISSO"* (quantas pessoas viram o
// aviso de atualização). Aqui a gente injeta um pool de mentira (`_usarPool`) e
// cobra o comportamento:
//
//   1. /api/update-notice conta uma vez por (INSTALAÇÃO, VERSÃO OFERECIDA);
//   2. a MESMA instalação repetindo o MESMO aviso não conta de novo;
//   3. OUTRA instalação soma, e a plataforma/versão de origem ficam guardadas;
//   4. payload sem offered_version → 400 e NADA gravado;
//   5. plataforma inválida → 400 e nada gravado;
//   6. o leitor exige token (401) e devolve o número agregado por versão,
//      plataforma e ORIGEM;
//   7. banco fora → 503 (nunca 500 nem número inventado).
//
// Rodar:  node tools/test_update_notice.mjs   (sai 1 se algo falhar)
// ======================================================================

process.env.STATS_TOKEN = "token-de-teste";

// ── Pool de mentira: guarda o que foi mandado e responde ao SELECT ────
const queries = [];
let linhas = [];
let falhar = false;

const poolFalso = {
  async query(sql, params) {
    queries.push({ sql, params });
    if (falhar) throw new Error("banco fora (teste)");
    if (String(sql).includes("INSERT INTO update_notices")) {
      const [install_id, offered_version, from_version, platform, kind] = params;
      const jaTem = linhas.some(
        (l) => l.install_id === install_id && l.offered_version === offered_version
      );
      if (!jaTem) {
        linhas.push({ install_id, offered_version, from_version, platform, kind });
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    }
    // ⚠ A ORDEM importa: a consulta por origem também contém a substring
    // "GROUP BY offered_version" — testar o padrão genérico primeiro fazia a
    // consulta de origem cair no ramo dos totais (o pool falso é que estava
    // errado, não o produto).
    if (String(sql).includes("GROUP BY offered_version, from_version")) {
      const mapa = {};
      for (const l of linhas) {
        const k = l.offered_version + "|" + (l.from_version || "?");
        mapa[k] = mapa[k] || {
          offered_version: l.offered_version,
          from_version: l.from_version || "?",
          n: 0,
        };
        mapa[k].n += 1;
      }
      return { rows: Object.values(mapa), rowCount: 0 };
    }
    if (String(sql).includes("count(*) FILTER")) {
      const mapa = {};
      for (const l of linhas) {
        const m = (mapa[l.offered_version] = mapa[l.offered_version] || {
          offered_version: l.offered_version,
          total: 0, macos: 0, windows: 0, linux: 0,
        });
        m.total += 1;
        if (l.platform in m) m[l.platform] += 1;
      }
      return { rows: Object.values(mapa), rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  },
};

const { _usarPool } = await import("../api/_db.js");
const { registrarAviso, contagemAvisos } = await import("../api/_db.js");
const noticeHandler = (await import("../api/update-notice.js")).default;
const statsHandler = (await import("../api/update-notice-stats.js")).default;

_usarPool(poolFalso);

let OK = 0;
let FAIL = 0;
function check(nome, cond, detalhe = "") {
  if (cond) {
    OK += 1;
    console.log("  OK    " + nome + (detalhe ? " — " + detalhe : ""));
  } else {
    FAIL += 1;
    console.log("  FAIL  " + nome + (detalhe ? " — " + detalhe : ""));
  }
}

function makeRes() {
  const out = { status: null, body: null, headers: {} };
  const res = {
    status(c) { out.status = c; return res; },
    json(b) { out.body = b; return res; },
    setHeader(k, v) { out.headers[k] = v; },
    send(b) { out.body = b; return res; },
  };
  return { res, out };
}
async function post(payload) {
  const { res, out } = makeRes();
  await noticeHandler({ method: "POST", body: payload }, res);
  return out;
}
async function get(query) {
  const { res, out } = makeRes();
  await statsHandler({ method: "GET", query }, res);
  return out;
}

console.log("== A. conta uma vez por (instalação, versão oferecida) ==");
let out = await post({
  install_id: "inst-1", platform: "linux", app_version: "4.0.0",
  offered_version: "4.5.1", notice_kind: "available",
});
check("aviso mostrado → 200 success", out.status === 200 && out.body.success === true,
      "status = " + out.status);
check("1 linha gravada", linhas.length === 1, "linhas = " + linhas.length);
check("o dedupe é (install_id, offered_version)",
      String(queries.find((q) => String(q.sql).includes("ON CONFLICT")).sql)
        .includes("(install_id, offered_version)"), "");

out = await post({ install_id: "inst-1", platform: "linux", offered_version: "4.5.1" });
check("a MESMA instalação vendo o MESMO aviso → duplicate:true e NÃO grava de novo",
      out.status === 200 && out.body.duplicate === true && linhas.length === 1,
      "linhas = " + linhas.length);

out = await post({
  install_id: "inst-2", platform: "windows", app_version: "3.0.3",
  offered_version: "4.5.1",
});
check("OUTRA instalação soma", out.body.success === true && linhas.length === 2,
      "linhas = " + linhas.length);

out = await post({
  install_id: "inst-1", platform: "linux", app_version: "4.5.1",
  offered_version: "4.6.0",
});
check("a MESMA instalação com OUTRA versão oferecida conta (aviso novo)",
      out.body.success === true && linhas.length === 3, "linhas = " + linhas.length);

console.log();
console.log("== B. payload ruim → 400 e nada gravado ==");
const antes = linhas.length;
out = await post({ install_id: "inst-3", platform: "macos" });
check("sem offered_version → 400", out.status === 400 && out.body.error === "bad_request",
      "status = " + out.status);
out = await post({ install_id: "inst-3", platform: "solaris", offered_version: "4.5.1" });
check("plataforma inválida → 400", out.status === 400, "status = " + out.status);
check("e NENHUMA linha nova entrou", linhas.length === antes,
      antes + " -> " + linhas.length);

console.log();
console.log("== C. o leitor do número ==");
out = await get({ token: "errado" });
check("token errado → 401 (o número não é público)", out.status === 401,
      "status = " + out.status);

out = await get({ token: "token-de-teste" });
const v451 = (out.body.versions || []).find((v) => v.offered_version === "4.5.1") || {};
check("token certo → total e quebra por plataforma",
      out.status === 200 && out.body.grand_total === 3 && v451.total === 2 &&
      v451.linux === 1 && v451.windows === 1,
      JSON.stringify(v451));
check("e diz DE ONDE os clientes vieram (quem está atrás)",
      (v451.from || {})["4.0.0"] === 1 && (v451.from || {})["3.0.3"] === 1,
      JSON.stringify(v451.from));

console.log();
console.log("== D. banco fora → 503 honesto, nunca número inventado ==");
falhar = true;
out = await post({ install_id: "inst-9", platform: "linux", offered_version: "4.5.1" });
check("registrar com banco fora → 503 notice_registry_unavailable",
      out.status === 503 && out.body.error === "notice_registry_unavailable",
      "status = " + out.status);
out = await get({ token: "token-de-teste" });
check("ler com banco fora → 503 (não devolve 0 como se fosse verdade)",
      out.status === 503, "status = " + out.status);
falhar = false;

check("sem banco configurado, registrarAviso devolve null (não estoura)",
      (await (async () => {
        const { _usarPool: _u } = await import("../api/_db.js");
        _u(null); // sem pool
        return registrarAviso({ install_id: "x", offered_version: "4.5.1" });
      })()) === null, "");
check("e contagemAvisos devolve null (quem lê trata como 'sem dados')",
      (await contagemAvisos()) === null, "");

console.log();
console.log("OK: " + OK + " | FAIL: " + FAIL);
process.exit(FAIL ? 1 : 0);
