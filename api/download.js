// api/download.js
// ======================================================================
// Magic Stat — contador de downloads + redirecionamento para o instalador.
// ----------------------------------------------------------------------
// ⚠️ ESTE ARQUIVO É A VERSÃO PRONTA PARA COLAR EM `magic_site/api/download.js`.
// Ele é um substituto direto: mantém o CONTADOR (Upstash Redis) e o mesmo
// contrato `/api/download?file=macos`.
//
// Uso no site (link do botão):
//     <a href="/api/download?file=macos">Download</a>
//
// O QUE MUDOU (15/09/2026): antes a URL do instalador estava escrita na mão
// (`FILES.macos = ".../download/v1.0.1/MagicStat-1.0.1.dmg"`), o que exigia
// editar este arquivo a cada lançamento. Agora a rota PERGUNTA à API de
// Releases do repositório público qual é a versão mais nova e manda o cliente
// para o arquivo dela — mesmo critério do app (updates/update_checker.py):
//
//   * ignora draft e pré-release;
//   * escolhe a MAIOR versão (não "a mais recente");
//   * exige um asset com extensão de instalador de macOS (.pkg/.dmg).
//
// Resultado: lançar passa a ser só gerar o instalador e publicar a Release.
// Este arquivo nunca mais precisa ser tocado.
//
// IMPORTANTE: a contagem é "best-effort" — se o Redis falhar por qualquer
// motivo, o usuário é redirecionado do MESMO jeito (o download nunca quebra
// por causa da estatística).
//
// Env (Vercel → Settings → Environment Variables):
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN  (já configurados)
// ======================================================================

import { Redis } from "@upstash/redis";
import { createHash } from "node:crypto";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ── Repositório público de distribuição ────────────────────────────────
const REPO = "heuryferr/MagicStat-Releases";
const MAC_EXT = [".pkg", ".dmg"];

// Último recurso: se a API do GitHub falhar (rede ou limite de requisições),
// o cliente AINDA baixa. Atualize junto com a Release quando lembrar — é a
// última versão conhecida boa.
const FALLBACK = {
  macos:
    "https://github.com/heuryferr/MagicStat-Releases/releases/download/" +
    "v1.0.1/MagicStat-1.0.1.dmg",
};

// Cache em memória (sobrevive entre invocações de uma instância "quente"):
// protege o limite de 60 requisições/hora por IP da API do GitHub.
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = { url: "", at: 0 };

function parseVersion(tag) {
  const m = String(tag || "").match(/(\d+(?:\.\d+)*)/);
  return m ? m[1].split(".").map(Number) : [0];
}

function isNewer(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

function pickMacAsset(release) {
  const assets = (release?.assets || []).filter(
    (a) =>
      a?.browser_download_url &&
      MAC_EXT.some((ext) => String(a.name || "").toLowerCase().endsWith(ext))
  );
  return assets[0] || null;
}

async function latestMacosUrl() {
  const now = Date.now();
  if (cache.url && now - cache.at < CACHE_TTL_MS) return cache.url;

  const res = await fetch(
    `https://api.github.com/repos/${REPO}/releases?per_page=20`,
    {
      headers: {
        "User-Agent": "MagicStat-Site/1.0",
        Accept: "application/vnd.github+json",
      },
    }
  );
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);

  const releases = await res.json();
  if (!Array.isArray(releases)) throw new Error("formato inesperado da API");

  let best = null;
  for (const r of releases) {
    if (!r || r.draft || r.prerelease) continue;
    const asset = pickMacAsset(r);
    if (!asset) continue;
    if (!best || isNewer(parseVersion(r.tag_name), parseVersion(best.tag))) {
      best = { tag: r.tag_name, url: asset.browser_download_url };
    }
  }
  if (!best) throw new Error("nenhuma Release com instalador de macOS");

  cache.url = best.url;
  cache.at = now;
  return best.url;
}

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

// ── Origem (país + conta) — usado pelo contador de origem abaixo ───────
const RETENCAO_UNICOS = 120 * 24 * 60 * 60; // 120 dias (igual ao resto)
const RETENCAO_INDICE = 400 * 24 * 60 * 60; // 400 dias para os índices

// Rótulo seguro para virar chave: minúsculo, sem acento/espaço, curto.
function slug(valor, max = 60) {
  const limpo = String(valor || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._@-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, max);
  return limpo;
}

// A conta vem do utm_content que o Magic Stat Mail coloca no link.
function utmContent(req) {
  return slug(req.query.utm_content, 60) || "(direto)";
}

export default async function handler(req, res) {
  const file = String(req.query.file || "macos").toLowerCase();
  if (file !== "macos") {
    return res
      .status(404)
      .json({ ok: false, error: "unknown_file", file, available: ["macos"] });
  }

  // ── Qual instalador entregar ─────────────────────────────────────────
  // (só macOS por enquanto; ao publicar Windows/Linux, resolva aqui também)
  let url = FALLBACK[file];
  try {
    url = await latestMacosUrl();
  } catch (err) {
    console.error("download: usando FALLBACK ->", err?.message ?? err);
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

  // ── De onde veio o clique: país (header do Vercel) + conta (utm_content)
  // Chaves NOVAS (downloads:cc:*, downloads:utm:*) — as de cima não mudam.
  try {
    const day = localDayKey();
    const cc =
      String(req.headers["x-vercel-ip-country"] || "??")
        .toUpperCase()
        .replace(/[^A-Z]/g, "")
        .slice(0, 2) || "??";
    const conta = utmContent(req);
    const hash = visitorHash(req);
    const p = redis.pipeline();
    p.incr(`downloads:cc:${cc}:${day}`);
    p.incr(`downloads:cc:${cc}`);
    p.sadd(`downloads:ccs:${day}`, cc);
    p.expire(`downloads:ccs:${day}`, RETENCAO_INDICE);
    p.sadd("downloads:ccs", cc);
    p.sadd(`downloads:unicc:${cc}`, hash);
    p.expire(`downloads:unicc:${cc}`, RETENCAO_UNICOS);
    p.incr(`downloads:utm:${conta}:${day}`);
    p.incr(`downloads:utm:${conta}`);
    p.sadd(`downloads:utms:${day}`, conta);
    p.expire(`downloads:utms:${day}`, RETENCAO_INDICE);
    p.sadd("downloads:utms", conta);
    p.sadd(`downloads:uniutm:${conta}`, hash);
    p.expire(`downloads:uniutm:${conta}`, RETENCAO_UNICOS);
    await p.exec();
  } catch (err) {
    console.error("download origin counter error:", err?.message ?? err);
  }

  // ── Redireciona para o instalador real ────────────────────────────────
  res.setHeader("Cache-Control", "no-store, max-age=0");
  return res.redirect(302, url);
}
