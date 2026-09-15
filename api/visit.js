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
//   visits:bots:{dia}                INCR  -> requisições de robô (separadas)
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

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

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

// Requisições claramente automáticas (scanners, monitores, curl): atrapalham a
// leitura por país, então vão para uma chave separada (visits:bots:{dia}).
function pareceRobo(req) {
  const ua = String(req.headers["user-agent"] || "");
  if (!ua || ua.length < 12) return true;
  return /bot|crawl|spider|slurp|preview|monitor|uptime|pingdom|curl|wget|python-requests|python-urllib|httpx|axios|node-fetch|go-http|okhttp|headless|phantom|scrapy|facebookexternalhit|whatsapp|telegram|slack|discord/i.test(
    ua
  );
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  try {
    const day = localDayKey();
    if (pareceRobo(req)) {
      await redis.incr(`visits:bots:${day}`);
      return res.status(204).end();
    }

    const cc =
      String(req.headers["x-vercel-ip-country"] || "??")
        .toUpperCase()
        .replace(/[^A-Z]/g, "")
        .slice(0, 2) || "??";
    const hash = visitorHash(req);
    const conta = utmContent(req);

    const p = redis.pipeline();
    // totais do dia / acumulado
    p.incr(`visits:${day}`);
    p.incr("visits:total");
    p.sadd(`visits:uniq:${day}`, hash);
    p.expire(`visits:uniq:${day}`, RETENCAO_UNICOS);
    // por país
    p.incr(`visits:cc:${cc}:${day}`);
    p.incr(`visits:cc:${cc}`);
    p.sadd(`visits:ccs:${day}`, cc);
    p.expire(`visits:ccs:${day}`, RETENCAO_INDICE);
    p.sadd("visits:ccs", cc);
    p.sadd(`visits:unicc:${cc}`, hash);
    p.expire(`visits:unicc:${cc}`, RETENCAO_UNICOS);
    // por conta (utm_content)
    p.incr(`visits:utm:${conta}:${day}`);
    p.incr(`visits:utm:${conta}`);
    p.sadd(`visits:utms:${day}`, conta);
    p.expire(`visits:utms:${day}`, RETENCAO_INDICE);
    p.sadd("visits:utms", conta);
    p.sadd(`visits:uniutm:${conta}`, hash);
    p.expire(`visits:uniutm:${conta}`, RETENCAO_UNICOS);
    // dimensões extras — um hash por dia (1 comando por campo, 1 para ler)
    const dimKey = `visits:x:${day}`;
    p.hincrby(dimKey, `ua:${familiaUA(req)}`, 1);
    p.hincrby(dimKey, `ref:${origemExterna(req)}`, 1);
    p.hincrby(dimKey, `path:${pagina(req)}`, 1);
    p.hincrby(dimKey, `ccut:${cc}|${conta}`, 1);
    p.expire(dimKey, RETENCAO_DIM);
    await p.exec();
  } catch (err) {
    console.error("visit counter error:", err?.message ?? err);
  }

  return res.status(204).end();
}
