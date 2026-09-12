// api/download.js
// ======================================================================
// Magic Stat — contador de downloads + redirecionamento para o instalador.
// ----------------------------------------------------------------------
// Uso no site (link do botão):
//     <a href="/api/download?file=macos">Download</a>
//
// Fluxo:
//   1. registra o clique no Upstash Redis (por dia + únicos por IP);
//  2. responde 302 redirecionando para o arquivo real (.dmg no GitHub).
//
// IMPORTANTE: a contagem é "best-effort" — se o Redis falhar por qualquer
// motivo, o usuário é redirecionado do MESMO jeito (o download nunca
// quebra por causa da estatística).
//
// Env (Vercel → Settings → Environment Variables):
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN  (já configurados)
//   DOWNLOAD_ENABLED = "1"  → libera os downloads (sem isso, responde 404)
// ======================================================================

import { Redis } from "@upstash/redis";
import { createHash } from "node:crypto";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ── Instaladores publicados ─────────────────────────────────────────────
// Atualize estas URLs a cada release (a URL fica num lugar só: o site usa
// /api/download, então trocar aqui vale para todos os botões).
const FILES = {
  macos:
    "https://github.com/heuryferr/MagicStat-Releases/releases/download/v1.0.1/MagicStat-1.0.1.dmg",
  // windows: "https://.../MagicStat-Setup.exe",
  // linux:   "https://.../MagicStat.AppImage",
};

// Minutos de deslocamento do fuso para definir o "dia" da contabilidade.
// -180 = UTC-3 (horário de Brasília).
const REPORT_TZ_OFFSET_MINUTES = -180;

// Sal usado no hash do IP (não guardamos o IP cru — só um hash irreversível).
const IP_SALT = process.env.DOWNLOAD_IP_SALT || "magic-stat-downloads";

function localDayKey(offsetDays = 0) {
  const now = Date.now() + REPORT_TZ_OFFSET_MINUTES * 60 * 1000;
  const d = new Date(now + offsetDays * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
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

// Trava de lançamento: enquanto o app não está pronto, o endpoint fica
// fechado. Ligue no Vercel com DOWNLOAD_ENABLED=1 quando for publicar.
const DOWNLOAD_ENABLED = process.env.DOWNLOAD_ENABLED === "1";

export default async function handler(req, res) {
  if (!DOWNLOAD_ENABLED) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(404).json({
      ok: false,
      error: "downloads_not_enabled",
      message: "Downloads are not open yet.",
    });
  }

  const file = String(req.query.file || "macos").toLowerCase();
  const url = FILES[file];

  if (!url) {
    return res
      .status(404)
      .json({ ok: false, error: "unknown_file", file, available: Object.keys(FILES) });
  }

  // ── Contabilização (nunca derruba o download) ─────────────────────────
  try {
    const day = localDayKey();
    await Promise.all([
      redis.incr(`downloads:${file}:${day}`),
      redis.incr(`downloads:${file}:total`),
      redis.sadd(`downloads:uniq:${file}:${day}`, visitorHash(req)),
      redis.expire(`downloads:uniq:${file}:${day}`, 120 * 24 * 60 * 60),
    ]);
  } catch (err) {
    console.error("download counter error:", err?.message ?? err);
  }

  // ── Redireciona para o instalador real ────────────────────────────────
  res.setHeader("Cache-Control", "no-store, max-age=0");
  return res.redirect(302, url);
}
