// Teste do ccfWindow (api/stats.js) com um Redis FALSO.
//
// Para que serve: o contador `downloads:ccf:{cc}:{file}:{dia}` (clique por país ×
// sistema, gravado pelo api/download) alimenta as 4 colunas de downloads por país
// do painel do Magic Stat Mail. Se a leitura quebrar aqui, o painel fica com
// zero sem avisar ninguém — este teste é o alarme.
//
// Como o projeto não tem node_modules local, o cliente do Upstash é stubado:
// rodar com `npm test` (ou `node tools/test_ccf.mjs`) na raiz do repositório.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ARQ = path.join(RAIZ, "api", "stats.js");

const dia = (atras) =>
  new Date(Date.now() + -180 * 60 * 1000 - atras * 86400000)
    .toISOString().slice(0, 10);
const hoje = dia(0);
const ontem = dia(1);

const DB = {
  [`downloads:ccfs:${hoje}`]: ["US|macos", "US|windows", "DE|linux"],
  [`downloads:ccfs:${ontem}`]: ["US|macos", "US|zap"],   // "zap" é lixo
  [`downloads:ccf:US:macos:${hoje}`]: 3,
  [`downloads:ccf:US:windows:${hoje}`]: 2,
  [`downloads:ccf:DE:linux:${hoje}`]: 1,
  [`downloads:ccf:US:macos:${ontem}`]: 5,
  [`downloads:ccf:US:zap:${ontem}`]: 99,
};

class Pipeline {
  constructor() { this.cmds = []; }
  smembers(k) { this.cmds.push(k); return this; }
  get(k) { this.cmds.push(k); return this; }
  incr(k) { this.cmds.push(k); return this; }
  sadd() { return this; }
  expire() { return this; }
  hgetall() { return this; }
  async exec() { return this.cmds.map((k) => DB[k] ?? null); }
}
// getRedis() (usado por ccfWindow) testa a credencial com uma LEITURA real:
// o ambiente precisa de um par de credencial (no servidor de verdade são
// KV_REST_API_* ou UPSTASH_REDIS_REST_*) e o stub precisa responder à sonda.
process.env.KV_REST_API_URL = "https://banco-de-teste";
process.env.KV_REST_API_TOKEN = "token-de-teste";
globalThis.Redis = class {
  constructor() {}
  get() { return Promise.resolve(null); }
  pipeline() { return new Pipeline(); }
};

let src = fs.readFileSync(ARQ, "utf8");
if (!/function ccfWindow/.test(src)) {
  console.error("FALHOU: ccfWindow sumiu do api/stats.js");
  process.exit(1);
}
src = src.replace(/^import \{ Redis \} from "@upstash\/redis";$/m, "");
src += "\nexport { ccfWindow };\n";
const tmp = path.join("/tmp", `stats_test_${process.pid}.mjs`);
fs.writeFileSync(tmp, src);

const { ccfWindow } = await import(pathToFileURL(tmp).href);
const r = await ccfWindow(2);
fs.unlinkSync(tmp);

const total = Object.fromEntries(r.clicks_ccf.map((x) => [x.name, x.count]));
const esperado = { "US|macos": 8, "US|windows": 2, "DE|linux": 1 };
const problemas = [];
if (JSON.stringify(total) !== JSON.stringify(esperado)) {
  problemas.push(`soma por país × sistema: ${JSON.stringify(total)}`);
}
if (r.clicks_ccf.some((x) => x.name.includes("zap"))) {
  problemas.push("sistema desconhecido deveria ser descartado");
}
if (r.clicks_ccf_dias.length !== 4) {
  problemas.push(`esperava 4 linhas por dia, veio ${r.clicks_ccf_dias.length}`);
}
const deOntem = r.clicks_ccf_dias.find(
  (x) => x.day === ontem && x.name === "US|macos");
if (!deOntem || deOntem.count !== 5) {
  problemas.push("cada dia tem que vir separado (painel soma o período)");
}

if (problemas.length) {
  console.error("FALHOU:\n  - " + problemas.join("\n  - "));
  process.exit(1);
}
console.log("ok: ccfWindow soma país × sistema e separa por dia");
