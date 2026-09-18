// Teste do RELATORIO (/api/stats) com Redis FALSO e numeros feitos A MAO.
//
// Por que existe: o relatorio e a unica janela do dono para os numeros
// (cliques, visitas, trials, vendas) e ficou MESES quebrado em silencio — o
// cliente Redis era criado no topo do arquivo com o par de credencial APAGADO.
// Aqui o banco falso reproduz exatamente o incidente (KV_REST_API_* vivo +
// UPSTASH_REDIS_REST_* apontando para banco apagado), os valores sao plantados
// a mao e a conta e conferida no HTML/JSON.
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

// ── numeros plantados A MAO ────────────────────────────────────────────
const STRINGS = {
  ["stats:trial:" + DIA + ":macos"]: 2,
  ["stats:trial:" + DIA + ":windows"]: 1,
  ["stats:trial:" + DIA + ":linux"]: 3,
  ["stats:trial:" + DIA + ":total"]: 6,
  ["downloads:macos:" + DIA]: 5,
  ["downloads:windows:" + DIA]: 0,
  ["downloads:linux:" + DIA]: 1,
  ["downloads:macos:total"]: 5,
  ["downloads:windows:total"]: 0,
  ["downloads:linux:total"]: 1,
  ["visits:" + DIA]: 9,
  ["visits:bots:" + DIA]: 1,
  "visits:total": 100,
};
const SETS = {
  ["downloads:uniq:macos:" + DIA]: ["h1"],
  ["downloads:pessoas:" + DIA]: ["h1", "h2"],
  ["visits:uniq:" + DIA]: ["a", "b"],
  ["analytics:sales:" + DIA]: [
    JSON.stringify({ platform: "macos", country: "BR" }),
    JSON.stringify({ platform: "windows", country: "US" }),
    // Duas VALIDAÇÕES da MESMA licença (o app revalida de tempos em tempos):
    // isso não é venda nova — a contagem tem de ser por licença DISTINTA.
    JSON.stringify({ platform: "linux", country: "PT", license_key: "K1" }),
    JSON.stringify({ platform: "linux", country: "PT", license_key: "K1" }),
  ],
};
// LISTAS (o LOG das últimas requisições de download, gravado pelo api/download).
const LISTS = {
  "downloads:log": [
    JSON.stringify({
      t: "2026-09-18T12:00:00.000Z",
      f: "linux",
      cc: "BR",
      rg: "SP",
      ct: "Sao Paulo",
      ua: "Linux/Chrome 153",
      conta: "(direto)",
      ref: "(sem referrer)",
    }),
  ],
};

globalThis.fetch = async () => {
  throw new Error("sem rede no teste");
};

globalThis.Redis = class {
  constructor(cfg) { this.cfg = cfg || {}; }
  _op() {
    if (String(this.cfg.url || "").includes("apagado")) {
      throw new Error("fetch failed: ENOTFOUND banco-apagado");
    }
  }
  get(k) { this._op(); return Promise.resolve(STRINGS[k] === undefined ? null : String(STRINGS[k])); }
  scard(k) { this._op(); return Promise.resolve((SETS[k] || []).length); }
  smembers(k) { this._op(); return Promise.resolve(SETS[k] || []); }
  lrange(k) { this._op(); return Promise.resolve(LISTS[k] || []); }
  pipeline() {
    const self = this;
    const jobs = [];
    const api = {
      get(k) { self._op(); jobs.push(() => (STRINGS[k] === undefined ? null : String(STRINGS[k]))); return api; },
      scard(k) { self._op(); jobs.push(() => (SETS[k] || []).length); return api; },
      smembers(k) { self._op(); jobs.push(() => SETS[k] || []); return api; },
      hgetall() { self._op(); jobs.push(() => ({})); return api; },
      incr() { self._op(); jobs.push(() => 1); return api; },
      hincrby() { self._op(); jobs.push(() => 1); return api; },
      sadd() { self._op(); jobs.push(() => 1); return api; },
      expire() { self._op(); jobs.push(() => 1); return api; },
      exec() { self._op(); return Promise.resolve(jobs.map((f) => f())); },
    };
    return api;
  }
};

let src = fs.readFileSync(ARQ, "utf8");
src = src.replace(/^import \{ Redis \} from "@upstash\/redis";$/m, "");
const tmp = path.join("/tmp", "stats_test_" + process.pid + ".mjs");
fs.writeFileSync(tmp, src);
const mod = await import(pathToFileURL(tmp).href);
fs.unlinkSync(tmp);
const handler = mod.default;

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

igual("secao de TRIALS aparece", html.includes("Trials started (7-day trial)"), true);
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
  String(resLink.body || "").includes("Trials started (7-day trial)") &&
    String(resLink.body || "").includes("Sales / activations (licensed)"),
  true,
);

igual("JSON: trials.totals.total = 6", res.body.trials && res.body.trials.totals.total, 6);
igual("JSON: trials do dia por plataforma (2-1-3)", (res.body.trials.totals.macos || 0) + "-" + (res.body.trials.totals.windows || 0) + "-" + (res.body.trials.totals.linux || 0), "2-1-3");
igual("JSON: sales.total = 3", res.body.sales && res.body.sales.total, 3);

if (problemas.length) {
  console.error("FALHOU:\n  - " + problemas.join("\n  - "));
  process.exit(1);
}
console.log("ok: relatorio (cliques + visitas + trials + vendas, com banco velho + banco novo)");
