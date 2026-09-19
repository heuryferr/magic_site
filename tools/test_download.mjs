// Teste do /api/download (api/download.js) com Redis FALSO.
//
// Regra de ouro: NADA é bloqueado e NADA é classificado. Robô, curl, scanner de
// e-mail, link direto e navegador com JS desligado recebem o instalador igual a
// um clique de página — e todos contam igual. Este teste prende isso.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ARQ = path.join(RAIZ, "api", "download.js");

// O getRedis() da rota testa cada credencial com uma LEITURA REAL: o stub
// reproduz o incidente de 18/09/2026 — a variavel UPSTASH_* aponta para um
// banco APAGADO (ENOTFOUND) e convive com a KV_REST_API_* (banco NOVO).
process.env.KV_REST_API_URL = "https://banco-novo-vivo";
process.env.KV_REST_API_TOKEN = "token-de-teste";
process.env.UPSTASH_REDIS_REST_URL = "https://banco-apagado";
process.env.UPSTASH_REDIS_REST_TOKEN = "token-de-teste";

// Sem rede no teste: a resolução do instalador cai no FALLBACK.
globalThis.fetch = () => Promise.reject(new Error("offline (teste)"));

globalThis.__contou = 0;
globalThis.Redis = class {
  constructor(cfg) { this.cfg = cfg || {}; }
  _op() {
    if (String(this.cfg.url || "").includes("apagado")) {
      throw new Error("fetch failed: ENOTFOUND banco-apagado");
    }
  }
  get() { this._op(); return Promise.resolve(null); }
  set() { this._op(); return Promise.resolve("OK"); }
  incr() { this._op(); globalThis.__contou += 1; return Promise.resolve(1); }
  sadd() { this._op(); globalThis.__contou += 1; return Promise.resolve(1); }
  smembers() { this._op(); return Promise.resolve([]); }
  expire() { this._op(); return Promise.resolve(1); }
  pipeline() {
    const self = this;
    return {
      incr() { self._op(); globalThis.__contou += 1; return this; },
      hincrby() { self._op(); globalThis.__contou += 1; return this; },
      sadd() { self._op(); globalThis.__contou += 1; return this; },
      lpush() { self._op(); globalThis.__contou += 1; return this; },
      ltrim() { self._op(); return this; },
      scard() { self._op(); return this; },
      expire() { self._op(); return this; },
      get() { self._op(); return this; },
      exec() { self._op(); return Promise.resolve([0, 1, 0]); },
    };
  }
};

let src = fs.readFileSync(ARQ, "utf8");
if (/ehRobo|ehCliqueDePagina|pareceRobo/.test(src)) {
  console.error("FALHOU: voltou classificação/bloqueio de robô no api/download.js");
  process.exit(1);
}
src = src.replace(/^import \{ Redis \} from "@upstash\/redis";$/m, "");
const tmp = path.join("/tmp", `download_test_${process.pid}.mjs`);
fs.writeFileSync(tmp, src);
const mod = await import(pathToFileURL(tmp).href);
fs.unlinkSync(tmp);

const handler = mod.default;

const UA_REAL = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/142 Safari/537.36";

const problemas = [];
const igual = (nome, obtido, esperado) => {
  if (obtido !== esperado) problemas.push(`${nome}: veio ${obtido}, esperava ${esperado}`);
};

const fakeRes = () => {
  const r = { statusCode: 0, body: null, location: "" };
  r.setHeader = () => {};
  r.status = (c) => ({ json: (o) => { r.statusCode = c; r.body = o; return r; },
                        send: (o) => { r.statusCode = c; r.body = o; return r; } });
  r.redirect = (c, url) => { r.statusCode = c; r.location = url; return r; };
  return r;
};

let res = fakeRes();
await handler({ query: {}, headers: {} }, res);
igual("sem file → 404 (não vira macOS)", res.statusCode, 404);

// ── TODO MUNDO baixa: robô, curl, scanner, sem UA, navegador, JS desligado ──
const UAS = [
  ["curl", "curl/8.5.0"],
  ["facebookexternalhit", "facebookexternalhit/1.1"],
  ["googlebot", "Googlebot/2.1"],
  ["scanner", "python-requests/2.31"],
  ["sem user-agent", ""],
  ["navegador de verdade", UA_REAL],
];
for (const [nome, ua] of UAS) {
  res = fakeRes();
  const headers = ua ? { "user-agent": ua } : {};
  await handler({ query: { file: "macos" }, headers }, res);
  igual(`${nome} recebe o instalador (302)`, res.statusCode, 302);
  igual(`${nome} leva ao arquivo`, /MagicStat/.test(res.location || ""), true);
}

// link direto, sem marca de clique e sem referrer: também baixa
res = fakeRes();
await handler({ query: { file: "windows" }, headers: { referer: "https://mail.google.com/" } }, res);
igual("link direto de e-mail (sem dl) → 302", res.statusCode, 302);

// clique de página, com o banco velho (apagado) convivendo: entrega e conta
globalThis.__contou = 0;
res = fakeRes();
await handler({ query: { file: "windows", dl: "1", p: "/" },
                headers: { "user-agent": UA_REAL } }, res);
igual("clique de página com banco velho → 302", res.statusCode, 302);
igual("e a contagem SAI (no banco que responde)", globalThis.__contou > 0, true);

if (problemas.length) {
  console.error("FALHOU:\n  - " + problemas.join("\n  - "));
  process.exit(1);
}
console.log("ok: /api/download entrega para TODO MUNDO (robo, curl, scanner, JS off)");
