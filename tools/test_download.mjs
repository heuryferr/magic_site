// Teste do /api/download (api/download.js) com Redis FALSO.
//
// Duas regras:
//   1. NADA é bloqueado: robô, curl, scanner, sem-UA e navegador baixam igual.
//   2. A rota NÃO escreve no Redis (o Upstash é só da licença) — o download é
//      entrega pura; quem conta instalador baixado é o GitHub Releases.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ARQ = path.join(RAIZ, "api", "download.js");

// Sem rede no teste: a resolução do instalador cai no FALLBACK.
globalThis.fetch = () => Promise.reject(new Error("offline (teste)"));

globalThis.__contou = 0;
globalThis.Redis = class {
  constructor() {}
  get() { globalThis.__contou += 1; return Promise.resolve(null); }
  set() { globalThis.__contou += 1; return Promise.resolve("OK"); }
  incr() { globalThis.__contou += 1; return Promise.resolve(1); }
  sadd() { globalThis.__contou += 1; return Promise.resolve(1); }
  smembers() { globalThis.__contou += 1; return Promise.resolve([]); }
  lpush() { globalThis.__contou += 1; return Promise.resolve(1); }
  expire() { globalThis.__contou += 1; return Promise.resolve(1); }
  pipeline() {
    const self = this;
    return {
      incr() { globalThis.__contou += 1; return this; },
      hincrby() { globalThis.__contou += 1; return this; },
      sadd() { globalThis.__contou += 1; return this; },
      lpush() { globalThis.__contou += 1; return this; },
      ltrim() { return this; },
      expire() { return this; },
      get() { return this; },
      exec() { return Promise.resolve([0, 1, 0]); },
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

res = fakeRes();
await handler({ query: { file: "windows" }, headers: { referer: "https://mail.google.com/" } }, res);
igual("link direto de e-mail (sem dl) → 302", res.statusCode, 302);

// A rota NÃO pode escrever no Redis (Upstash é só da licença)
globalThis.__contou = 0;
res = fakeRes();
await handler({ query: { file: "windows", dl: "1", p: "/" },
                headers: { "user-agent": UA_REAL } }, res);
igual("clique de página → 302", res.statusCode, 302);
igual("a rota NÃO toca no Redis", globalThis.__contou, 0);

if (problemas.length) {
  console.error("FALHOU:\n  - " + problemas.join("\n  - "));
  process.exit(1);
}
console.log("ok: /api/download entrega para TODO MUNDO e NAO usa Redis");
