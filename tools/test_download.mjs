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

globalThis.Redis = class {
  constructor() {}
  incr() { return Promise.resolve(1); }
  sadd() { return Promise.resolve(1); }
  expire() { return Promise.resolve(1); }
  pipeline() {
    const p = this;
    return { sadd() { return this; }, scard() { return this; }, expire() { return this; },
             exec() { return Promise.resolve([0, 1, 0]); } };
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

// ── veio da nossa página?
igual("com ?p= veio da página", ehCliqueDePagina({ query: { p: "/" }, headers: {} }), true);
igual("com ?utm_content veio da página", ehCliqueDePagina({ query: { utm_content: "heuryferr@gmail.com" }, headers: {} }), true);
igual("com ?ref (mail) veio da página", ehCliqueDePagina({ query: { ref: "mail.google.com" }, headers: {} }), true);
igual("Referer nosso (JS desligado)", ehCliqueDePagina({ query: {}, headers: { referer: "https://statmagic.vercel.app/" } }), true);
igual("Referer estranho NÃO conta", ehCliqueDePagina({ query: {}, headers: { referer: "https://evil.com" } }), false);
igual("scanner (sem nada) NÃO conta", ehCliqueDePagina({ query: {}, headers: {} }), false);

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

if (problemas.length) {
  console.error("FALHOU:\n  - " + problemas.join("\n  - "));
  process.exit(1);
}
console.log("ok: gate do download (file obrigatório + robô + só-clique-de-página)");
