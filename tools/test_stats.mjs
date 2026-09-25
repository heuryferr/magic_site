// Teste do RELATORIO (/api/stats) com numeros feitos A MAO.
//
// Por que existe: o relatorio e a unica janela do dono para os numeros
// (cliques, visitas, trials, vendas). A fonte passou do Redis (Upstash) para
// o POSTGRES (Neon) — o Redis foi aposentado. Aqui injetamos um pool falso
// (api/_db.js → _usarPool) que responde SQL plantado a mao, e conferimos a
// conta no HTML/JSON.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ARQ = path.join(RAIZ, "api", "stats.js");

process.env.STATS_TOKEN = "token-de-teste";
process.env.KV_REST_API_URL = "https://banco-novo-vivo";
process.env.KV_REST_API_TOKEN = "token-de-teste";
process.env.UPSTASH_REDIS_REST_URL = "https://banco-apagado";
process.env.UPSTASH_REDIS_REST_TOKEN = "token-de-teste";

// Fuso do relatorio (-180 min = UTC-3), o MESMO usado em stats.js.
const DIA = new Date(Date.now() - 180 * 60 * 1000).toISOString().slice(0, 10);

globalThis.fetch = async () => {
  throw new Error("sem rede no teste");
};

// Redis minimo: o stats.js só usa Redis para o CACHE do GitHub (best-effort);
// a contabilidade agora vem do Postgres (pool falso injetado abaixo).
globalThis.Redis = class {
  constructor(cfg) { this.cfg = cfg || {}; }
  async get() { return null; }
  async set() { return "OK"; }
};

let src = fs.readFileSync(ARQ, "utf8");
src = src.replace(/^import \{ Redis \} from "@upstash\/redis";$/m, "");
const tmp = path.join(RAIZ, "api", "_tmp_stats_test_" + process.pid + ".mjs");
fs.writeFileSync(tmp, src);
const mod = await import(pathToFileURL(tmp).href);
fs.unlinkSync(tmp);
const handler = mod.default;

// Injetamos um pool falso (SQL-aware) no api/_db.js: ele responde a cada
// consulta dos agregados com numeros plantados a mao.
const _db = await import(pathToFileURL(path.join(RAIZ, "api", "_db.js")).href);
const LINHAS_DB = [{
  ts: new Date("2026-09-18T12:00:00.000Z"),
  file: "linux", cc: "BR", region: "SP", city: "Sao Paulo",
  ua: "Linux/Chrome 153", conta: "(direto)", ref: "(sem referrer)",
}];
_db._usarPool({
  query: async (sql) => {
    const s = String(sql);
    if (/CREATE TABLE|ALTER TABLE|CREATE INDEX/i.test(s)) return { rows: [] };
    if (/SELECT ts, file, cc, region, city, ua, conta, ref/i.test(s)) return { rows: LINHAS_DB };
    if (/FROM trials/i.test(s)) return { rows: [{ dia: DIA, total: 6, macos: 2, windows: 1, linux: 3 }] };
    if (/FROM sales/i.test(s) && /min\(/i.test(s)) return { rows: [{ dia: DIA, sales: 3 }] };
    if (/platform AS name/i.test(s)) return { rows: [{ name: "macos", n: 1 }, { name: "linux", n: 1 }] };
    if (/country AS name/i.test(s)) return { rows: [{ name: "BR", n: 1 }, { name: "PT", n: 1 }] };
    if (/FROM clicks/i.test(s) && /AS total/i.test(s)) return { rows: [{ dia: DIA, total: 6, uniq: 2, macos: 5, windows: 0, linux: 1 }] };
    if (/FROM visits/i.test(s) && /AS views/i.test(s)) return { rows: [{ dia: DIA, views: 9, uniq: 2 }] };
    return { rows: [] };
  },
});

function fakeRes() {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => ({
    json: (o) => { r.statusCode = c; r.body = o; return r; },
    send: (o) => { r.statusCode = c; r.body = o; return r; },
    end: () => { r.statusCode = c; return r; },
  });
  return r;
}

const problemas = [];
const igual = (nome, obtido, esperado) => {
  if (obtido !== esperado) {
    problemas.push(nome + ": veio " + JSON.stringify(obtido) + ", esperava " + JSON.stringify(esperado));
  }
};

// sem token → 401
let res = fakeRes();
await handler({ query: { days: "1" }, headers: {} }, res);
igual("sem token → 401", res.statusCode, 401);

// com token → pagina HTML
res = fakeRes();
await handler({ query: { token: "token-de-teste", days: "1", format: "html" }, headers: {} }, res);
igual("com token → 200", res.statusCode, 200);
const html = String(res.body || "");

igual("secao de TRIALS aparece", html.includes("Trials started (48-hour trial)"), true);
igual(
  "linha do dia: 2 macos + 1 windows + 3 linux = 6 (conta a mao)",
  html.includes("<tr><td>" + DIA + "</td><td>2</td><td>1</td><td>3</td><td><b>6</b></td></tr>"),
  true,
);
igual("secao de VENDAS aparece", html.includes("Sales / activations (licensed)"), true);
igual("total da janela de vendas = 3 (2 sem chave + 1 licenca distinta)",
  html.includes("window total: <b>3</b>"), true);
igual("venda: revalidacao da MESMA licenca nao conta 2x (linux 1)",
  html.includes("<td>linux</td><td>1</td>"), true);
igual("vendas por plataforma: macos 1", html.includes("<td>macos</td><td>1</td>"), true);
igual("vendas por pais: BR 1", html.includes("<td>BR</td><td>1</td>"), true);
igual("secao de cliques ainda esta la", html.includes("site clicks (our counter)"), true);
// A coluna que o dono quer: PESSOAS distintas (2), e nao os 6 cliques brutos.
igual(
  "coluna People = 2 (pessoas distintas), com Total 6 e Multi-OS 0",
  html.includes(
    "<tr><td>" + DIA + "</td><td>5</td><td>0</td><td>1</td><td><b>6</b></td><td>2</td><td>0</td><td>0</td></tr>",
  ),
  true,
);
// O LOG das últimas requisições de download (hora + arquivo + país + navegador).
igual("secao do LOG aparece", html.includes("Last downloads (live log)"), true);
igual(
  "LOG traz a linha plantada (linux/BR)",
  html.includes("<td>linux</td><td>BR</td>"),
  true,
);
igual(
  "LOG traz o estado e a cidade do clique (BR/SP/Sao Paulo)",
  html.includes("<td>SP</td><td>Sao Paulo</td>"),
  true,
);

// JSON
res = fakeRes();
await handler({ query: { token: "token-de-teste", days: "1" }, headers: {} }, res);
// O total agregado vive em trials.totals (mesma forma de visits.totals).
// o link privado do dono (segunda porta) também abre
const resLink = fakeRes();
await handler(
  { query: { token: "ms-aeb509acecfb305a6173a871", days: "1", format: "html" }, headers: {} },
  resLink,
);
igual("o LINK privado do dono abre o relatorio", resLink.statusCode, 200);
igual(
  "e traz as secoes novas",
  String(resLink.body || "").includes("Trials started (48-hour trial)") &&
    String(resLink.body || "").includes("Sales / activations (licensed)"),
  true,
);

igual("JSON: trials.totals.total = 6", res.body.trials && res.body.trials.totals.total, 6);
igual("JSON: trials do dia por plataforma (2-1-3)", (res.body.trials.totals.macos || 0) + "-" + (res.body.trials.totals.windows || 0) + "-" + (res.body.trials.totals.linux || 0), "2-1-3");
igual("JSON: sales.total = 3", res.body.sales && res.body.sales.total, 3);

// MODO LEVE (`only=log`): o painel do dono puxa só o log, de poucos em poucos
// segundos, sem recalcular o relatório inteiro.
const resLeve = fakeRes();
await handler(
  { query: { token: "token-de-teste", only: "log", n: "1" }, headers: {} },
  resLeve,
);
igual("only=log devolve o log", Boolean(resLeve.body.log && resLeve.body.log.ok), true);
igual("only=log respeita o n pedido", (resLeve.body.log.itens || []).length, 1);
igual("only=log não arrasta o relatório inteiro", resLeve.body.clicks === undefined, true);

if (problemas.length) {
  console.error("FALHOU:\n  - " + problemas.join("\n  - "));
  process.exit(1);
}
console.log("ok: relatorio (cliques + visitas + trials + vendas, com banco velho + banco novo)");
