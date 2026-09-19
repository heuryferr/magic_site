// api/visit.js
// ======================================================================
// Magic Stat — contador de VISITAS (page views) do site.
// ----------------------------------------------------------------------
// Complementa o `api/download` (que conta o CLIQUE no botão): aqui contamos a
// VISITA à página, para separar "abriu o site" de "clicou em baixar".
//
// Chaves NOVAS no Upstash Redis (nada existente é sobrescrito):
//
//   visits:{dia}                     INCR  -> visitas por dia
//   visits:total                     INCR  -> acumulado
//   visits:uniq:{dia}                SET   -> visitantes únicos (hash IP+UA)
//   visits:cc:{cc}:{dia}             INCR  -> visitas por PAÍS e dia
//   visits:cc:{cc}                   INCR  -> acumulado por país
//   visits:ccs:{dia} / visits:ccs    SET   -> índice de países do dia / geral
//   visits:unicc:{cc}                SET   -> únicos por país
//   visits:utm:{conta}:{dia}         INCR  -> visitas por CONTA (utm_content)
//   visits:utm:{conta}               INCR  -> acumulado por conta
//   visits:utms:{dia} / visits:utms  SET   -> índice de contas do dia / geral
//   visits:uniutm:{conta}            SET   -> únicos por conta
//   visits:x:{dia}                   HASH  -> dimensões extras do dia, campo:
//                                            "ua:<SO/navegador>",
//                                            "ref:<site de origem>",
//                                            "path:<página>",
//                                            "ccut:<país>|<conta>"
//                                            (um hash por dia = 1 comando
//                                            para gravar e 1 para ler tudo)
//
// O país vem do header `x-vercel-ip-country` (o Vercel entrega em qualquer
// plano). A conta vem do `utm_content` que o Magic Stat Mail coloca no link.
// O `ref` e o `path` chegam do `assets/js/track.js` (o referrer de uma
// requisição de beacon seria a própria página, não de onde a pessoa veio).
//
// PRIVACIDADE: nunca guardamos o IP — só um hash irreversível de IP +
// user-agent (mesmo esquema do download.js), dentro de SETs com expiração.
// Nada de dado pessoal: só contagens por país/navegador/origem/página.
//
// Best-effort: se o Redis falhar, o site segue funcionando do mesmo jeito.
// ======================================================================

import { Redis } from "@upstash/redis";
import { createHash } from "node:crypto";

// ── Redis: cliente SOB DEMANDA + CANDIDATOS ────────────────────────────
// A Vercel cria KV_REST_API_* quando o banco vem pela KV e
// UPSTASH_REDIS_REST_* quando vem pelo Marketplace Upstash — e as duas podem
// coexistir, com a de banco APAGADO entre elas (foi o incidente de 18/09/2026).
// Criar o cliente no topo do arquivo com o par fixo UPSTASH_* fazia TODA a
// contagem morrer em silencio. Aqui testamos os candidatos com uma LEITURA
// REAL e ficamos com o que RESPONDE; o cliente bom fica em cache.
let _redis = null;

function redisCandidates() {
  const pares = [
    [process.env.KV_REST_API_URL, process.env.KV_REST_API_TOKEN],
    [process.env.UPSTASH_REDIS_REST_URL, process.env.UPSTASH_REDIS_REST_TOKEN],
  ];
  const vistos = new Set();
  return pares.filter(([url, token]) => {
    if (!url || !token || vistos.has(url)) return false;
    vistos.add(url);
    return true;
  });
}

async function getRedis() {
  if (_redis) return _redis;
  const cands = redisCandidates();
  let lastErr = null;
  for (const [url, token] of cands) {
    const client = new Redis({ url, token });
    try {
      await client.get("magicstat:probe");
      _redis = client;
      return client;
    } catch (err) {
      lastErr = err;
      console.error("Upstash: candidato falhou, tentando o proximo:", err?.message ?? err);
    }
  }
  throw lastErr || new Error("no redis credentials in the environment");
}

// Mesmo fuso da contabilidade de downloads (-180 = UTC-3, Brasília).
const REPORT_TZ_OFFSET_MINUTES = -180;
const IP_SALT = process.env.DOWNLOAD_IP_SALT || "magic-stat-downloads";
const RETENCAO_UNICOS = 120 * 24 * 60 * 60; // 120 dias (igual ao download.js)
const RETENCAO_INDICE = 400 * 24 * 60 * 60; // 400 dias para os índices
const RETENCAO_DIM = 400 * 24 * 60 * 60; // 400 dias para o hash do dia

function localDayKey(offsetDays = 0) {
  const now = Date.now() + REPORT_TZ_OFFSET_MINUTES * 60 * 1000;
  const d = new Date(now + offsetDays * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function visitorHash(req) {
  const fwd = req.headers["x-forwarded-for"] || "";
  const ip = String(fwd).split(",")[0].trim() || "unknown";
  const ua = String(req.headers["user-agent"] || "");
  return createHash("sha256")
    .update(`${IP_SALT}|${ip}|${ua}`)
    .digest("hex")
    .slice(0, 32);
}

// Rótulo seguro para virar chave: minúsculo, sem acento/espaço, curto.
function slug(valor, max = 60) {
  const limpo = String(valor || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._@|-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, max);
  return limpo;
}

function utmContent(req) {
  return slug(req.query.utm_content, 60) || "(direto)";
}

// "macOS/Safari 17" — serve para separar pessoa de robô com cara de navegador.
function familiaUA(req) {
  const ua = String(req.headers["user-agent"] || "");
  if (!ua) return "(sem user-agent)";
  const os = /iPhone|iPad|iPod/i.test(ua)
    ? "iOS"
    : /Android/i.test(ua)
      ? "Android"
      : /Macintosh|Mac OS X/i.test(ua)
        ? "macOS"
        : /Windows/i.test(ua)
          ? "Windows"
          : /CrOS/i.test(ua)
            ? "ChromeOS"
            : /Linux/i.test(ua)
              ? "Linux"
              : "outro";
  const nav = /HeadlessChrome/i.test(ua)
    ? "HeadlessChrome"
    : /Edg\//i.test(ua)
      ? "Edge"
      : /OPR\/|Opera/i.test(ua)
        ? "Opera"
        : /Firefox\//i.test(ua)
          ? "Firefox"
          : /Chrome\//i.test(ua)
            ? "Chrome"
            : /Safari\//i.test(ua)
              ? "Safari"
              : "outro";
  const v = (ua.match(/(?:Chrome|Firefox|Version|Edg)\/(\d+)/) || [])[1] || "";
  return `${os}/${nav}${v ? " " + v : ""}`.slice(0, 44);
}

function origemExterna(req) {
  const bruto = slug(req.query.ref, 80);
  if (!bruto) return "(sem referrer)";
  return bruto;
}

function pagina(req) {
  return slug(req.query.p, 60) || "/";
}

// Sem separação de robô: TODA visita conta como visita.

export default async function handler(req, res) {
  // A visita NÃO é contada no Redis: o Upstash ficou RESERVADO para a licença
  // (2 máquinas por chave). Aqui só respondemos ao beacon do track.js.
  res.setHeader("Cache-Control", "no-store, max-age=0");
  return res.status(204).end();
}
