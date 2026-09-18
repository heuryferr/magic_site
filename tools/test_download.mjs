// Teste do gate de /api/download (api/download.js) com Redis FALSO.
//
// Por quê: o 6/6/6 (macOS/Windows/Linux em lockstep) era um scanner seguindo os
// 3 botões. Este teste prende a solução: sem `file` não conta como macOS; sem
// vir da nossa página (sem `p`/utm/ref e sem Referer nosso) não conta; e os
// robôs óbvios continuam bloqueados. Um clique de VERDADE passa.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ARQ = path.join(RAIZ, "api", "download.js");

// O getRedis() da rota testa cada credencial com uma LEITURA REAL: o stub
// reproduz o incidente de 18/09/2026 — a variavel UPSTASH_* aponta para um
// banco APAGADO (ENOTFOUND) e convive com a KV_REST_API_* (banco NOVO). Se a
// rota voltar a criar o cliente no topo com o par fixo, ela morre aqui.
process.env.KV_REST_API_URL = "https://banco-novo-vivo";
process.env.KV_REST_API_TOKEN = "token-de-teste";
process.env.UPSTASH_REDIS_REST_URL = "https://banco-apagado";
process.env.UPSTASH_REDIS_REST_TOKEN = "token-de-teste";

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
src = src.replace(/^import \{ Redis \} from "@upstash\/redis";$/m, "");
if (!/function ehCliqueDePagina/.test(src) || !/function ehRobo/.test(src)) {
  console.error("FALHOU: gate sumiu do api/download.js");
  process.exit(1);
}
const tmp = path.join("/tmp", `download_test_${process.pid}.mjs`);
fs.writeFileSync(tmp, src);
const mod = await import(pathToFileURL(tmp).href);
fs.unlinkSync(tmp);

const { ehRobo, ehCliqueDePagina } = mod;
const handler = mod.default;

const UA_REAL = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/142.0 Safari/537.36";

const problemas = [];
const igual = (nome, obtido, esperado) => {
  if (obtido !== esperado) problemas.push(`${nome}: veio ${obtido}, esperava ${esperado}`);
};

// ── robô óbvio
igual("curl é robô", ehRobo({ headers: { "user-agent": "curl/7.88.1" } }), true);
igual("sem user-agent é robô", ehRobo({ headers: {} }), true);
igual("googlebot é robô", ehRobo({ headers: { "user-agent": "Googlebot/2.1" } }), true);
igual("navegador de verdade NÃO é robô", ehRobo({ headers: { "user-agent": UA_REAL } }), false);

// ── é CLIQUE de gente? (o track.js só põe `dl=1` no evento de CLIQUE)
igual("CLIQUE de gente (dl=1) passa", ehCliqueDePagina({ query: { dl: "1", p: "/" }, headers: {} }), true);
igual("seguidor de link com ?p= (sem clique) NÃO passa", ehCliqueDePagina({ query: { p: "/" }, headers: {} }), false);
igual("seguidor com ?utm_content (sem clique) NÃO passa", ehCliqueDePagina({ query: { utm_content: "heuryferr@gmail.com" }, headers: {} }), false);
igual("Referer nosso sem clique NÃO passa", ehCliqueDePagina({ query: {}, headers: { referer: "https://statmagic.vercel.app/" } }), false);
igual("scanner (sem nada) NÃO passa", ehCliqueDePagina({ query: {}, headers: {} }), false);

// ── handler de verdade (caminhos que não tocam o GitHub)
const fakeRes = () => {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {};
  r.status = (c) => ({ json: (o) => { r.statusCode = c; r.body = o; return r; },
                        send: (o) => { r.statusCode = c; r.body = o; return r; } });
  return r;
};

let res = fakeRes();
await handler({ query: {}, headers: {} }, res);
igual("sem file → 404 (não vira macOS)", res.statusCode, 404);

res = fakeRes();
await handler({ query: { file: "macos" }, headers: { "user-agent": "curl/7.88.1" } }, res);
igual("curl em macos → 403 automated_access", res.statusCode, 403);

res = fakeRes();
await handler({ query: { file: "macos" }, headers: { "user-agent": UA_REAL } }, res);
igual("sem origem de página → 403 not_from_page", res.statusCode, 403);

// ── credencial: banco VELHO (apagado) + banco NOVO ────────────────────
// É o incidente real: com a variavel antiga presente, a rota criava o cliente
// no topo com o par fixo UPSTASH_* e TODA a contagem morria em silencio.
globalThis.__contou = 0;
res = fakeRes();
await handler(
  { query: { file: "macos" }, headers: { "user-agent": "curl/7.88.1" } },
  res,
);
igual("robô com banco velho + banco novo → 403 (não quebra)", res.statusCode, 403);
igual(
  "e a contagem SAI (no banco que responde, não no apagado)",
  globalThis.__contou > 0,
  true,
);

if (problemas.length) {
  console.error("FALHOU:\n  - " + problemas.join("\n  - "));
  process.exit(1);
}
console.log("ok: gate do download (file obrigatório + robô + só-clique-de-página)");
