// api/visit.js
// ======================================================================
// Magic Stat — beacon de VISITA da página (api/visit).
// ----------------------------------------------------------------------
// O `assets/js/track.js` chama isto ao carregar a página. Aqui NÃO contamos
// nada no Redis: o Upstash ficou RESERVADO para a licença (2 máquinas por
// chave). Este endpoint só responde 204 (aceite) e sai.
//
// As contagens de download/visita saíram do Redis de propósito — a de download
// é do GitHub Releases, que o painel lê direto.
//
// Best-effort: nunca derruba o carregamento da página.
// ======================================================================

import { Redis } from "@upstash/redis";
import { createHash } from "node:crypto";
import { registrarVisita } from "./_db.js";

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
  // Evento (ex.: play do vídeo) chega em ?ev= e vira o "path" `event:<nome>`,
  // para o relatório separar "quantos deram play" das visitas de página.
  const ev = slug(req.query.ev, 40);
  if (ev) return `event:${ev}`;
  return slug(req.query.p, 60) || "/";
}

// Sem separação de robô: TODA visita conta como visita.

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  // A visita vai para o POSTGRES (o Redis ficou reservado à licença). É
  // best-effort: `registrarVisita` nunca lança — o beacon nunca atrapalha.
  try {
    await registrarVisita({
      cc: String(req.headers["x-vercel-ip-country"] || "??")
        .toUpperCase()
        .replace(/[^A-Z]/g, "")
        .slice(0, 2) || "??",
      ua: familiaUA(req),
      conta: utmContent(req),
      ref: origemExterna(req),
      path: pagina(req),
      uhash: visitorHash(req),
    });
  } catch (err) {
    console.error("visit insert error:", err?.message ?? err);
  }
  return res.status(204).end();
}
