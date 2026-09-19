// api/download.js
// ======================================================================
// Magic Stat — contador de downloads + redirecionamento para o instalador.
// ----------------------------------------------------------------------
// ⚠️ ESTE ARQUIVO É A VERSÃO PRONTA PARA COLAR EM `magic_site/api/download.js`.
// Ele é um substituto direto: mantém o CONTADOR (Upstash Redis) e o mesmo
// contrato `/api/download?file=<macos|windows>`.
//
// Uso no site (links dos botões):
//     <a href="/api/download?file=macos">Download for macOS</a>
//     <a href="/api/download?file=windows">Download for Windows</a>
//     <a href="/api/download?file=linux">Download for Linux</a>
//
// O QUE MUDOU (15/09/2026): antes a URL do instalador estava escrita na mão
// (`FILES.macos = ".../download/v1.0.1/MagicStat-1.0.1.dmg"`), o que exigia
// editar este arquivo a cada lançamento. Agora a rota PERGUNTA à API de
// Releases do repositório público qual é a versão mais nova e manda o cliente
// para o arquivo dela — mesmo critério do app (updates/update_checker.py):
//
//   * ignora draft e pré-release;
//   * escolhe a MAIOR versão (não "a mais recente");
//   * exige um asset com extensão de instalador do SO pedido
//     (macOS: .pkg/.dmg · Windows: .exe/.msi · Linux: .AppImage/.deb/.rpm).
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
import { registrarClique } from "./_db.js";

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

// ── Repositório público de distribuição ────────────────────────────────
const REPO = "heuryferr/MagicStat-Releases";

// Uma entrada por sistema operacional: extensões que identificam o instalador
// daquele SO na Release. Ao publicar Linux, basta acrescentar a chave.
const FILE_KINDS = {
  // Ordem = preferência: usa o 1º formato que existir na Release.
  // macOS: .dmg para o site/primeira instalação (instalação mais fluida);
  // o .pkg é para a atualização feita de dentro do próprio programa.
  macos: [".dmg", ".pkg"],
  windows: [".exe", ".msi"],
  linux: [".appimage", ".deb", ".rpm"],
};

// Último recurso: se a API do GitHub falhar (rede ou limite de requisições),
// o cliente AINDA baixa. TEM DE APONTAR PARA ARTEFATOS QUE EXISTEM: até 18/09
// isto apontava para a v1.0.2, cuja Release está SEM assets — os 3 links davam
// 404 e quem clicasse em "Download" durante uma falha da API recebia uma página
// 404 do GitHub (foi o "não consigo baixar" relatado por e-mail).
// Ao publicar uma Release nova, atualize aqui JUNTO — com os nomes EXATOS dos
// assets daquela Release (ex.: o macOS da v1.0.6 é .pkg, não .dmg).
const FALLBACK_VERSION = "v1.0.6";
const FALLBACK = {
  macos: `https://github.com/heuryferr/MagicStat-Releases/releases/download/${FALLBACK_VERSION}/MagicStat-1.0.6-setup.pkg`,
  windows: `https://github.com/heuryferr/MagicStat-Releases/releases/download/${FALLBACK_VERSION}/MagicStat-1.0.6-setup.exe`,
  linux: `https://github.com/heuryferr/MagicStat-Releases/releases/download/${FALLBACK_VERSION}/MagicStat-1.0.6-x86_64.AppImage`,
};

// Cache em memória, um por sistema (sobrevive entre invocações de uma
// instância "quente"): protege o limite de 60 requisições/hora por IP da API
// do GitHub.
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = {};

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

function pickAsset(release, exts) {
  // exts vem em ordem de preferência: devolve o 1º asset do formato preferido
  // que existir (ex.: macOS pega .dmg e só cai no .pkg se não houver .dmg).
  const assets = (release?.assets || []).filter((a) => a?.browser_download_url);
  for (const ext of exts) {
    const hit = assets.find((a) =>
      String(a.name || "").toLowerCase().endsWith(ext)
    );
    if (hit) return hit;
  }
  return null;
}

async function latestUrl(kind) {
  const exts = FILE_KINDS[kind];
  const now = Date.now();
  const hit = cache[kind];
  if (hit && hit.url && now - hit.at < CACHE_TTL_MS) return hit.url;

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
    const asset = pickAsset(r, exts);
    if (!asset) continue;
    if (!best || isNewer(parseVersion(r.tag_name), parseVersion(best.tag))) {
      best = { tag: r.tag_name, url: asset.browser_download_url };
    }
  }
  if (!best) throw new Error(`nenhuma Release com instalador de ${kind}`);

  cache[kind] = { url: best.url, at: now };
  return best.url;
}

// Resolve o instalador da versão mais nova; se a API do GitHub falhar (rede ou
// limite), cai no FALLBACK — o download nunca quebra por causa disso.
async function resolveUrl(file) {
  try {
    return await latestUrl(file);
  } catch (err) {
    console.error("download: usando FALLBACK ->", err?.message ?? err);
    return FALLBACK[file];
  }
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

const RETENCAO_DIM = 400 * 24 * 60 * 60; // 400 dias para o hash do dia

// Log das ÚLTIMAS requisições que passaram pelo portão (o dono vê, no relatório,
// hora + arquivo + país + navegador + conta + referrer de cada download). Lista
// limitada: guardamos só as últimas LOG_MAX. Serve para distinguir, sem
// adivinhação, um clique humano de uma rajada de robô/atualizador.
const LOG_MAX = 500;

// "macOS/Safari 17" — separa pessoa de robô com cara de navegador.
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
  return slug(req.query.ref, 80) || "(sem referrer)";
}

function pagina(req) {
  return slug(req.query.p, 60) || "/";
}

// Texto de cabeçalho → limpo, mas SEM perder acento/maiúscula: cidade e estado
// são para LER no relatório, não são chave. Só tira o que poderia estragar HTML.
function limpaTexto(valor, max = 60) {
  return String(valor || "")
    .replace(/[<>&"'`\\]/g, "")
    .trim()
    .slice(0, max);
}

// Estado/cidade do clique (geolocalização do Vercel). O estado vem como código
// ISO 3166-2 ("SP", "CA"); a cidade pode vir URL-encoded. Cabeçalho ausente
// (preview/local) → "" e o relatório mostra "—": a gente não inventa.
function regiao(req) {
  return limpaTexto(req.headers["x-vercel-ip-country-region"], 8).toUpperCase();
}

function cidade(req) {
  const bruto = String(req.headers["x-vercel-ip-city"] || "");
  let c = bruto;
  try {
    c = decodeURIComponent(bruto);
  } catch (err) {
    /* '%' inválido no cabeçalho: fica como veio */
  }
  return limpaTexto(c, 60);
}

// Aqui NÃO existe classificação, contador separado nem bloqueio. Robô, curl,
// scanner de e-mail, link direto e navegador com JS desligado contam EXATAMENTE
// como um clique de gente. O gate que existia aqui — e que barrava quem
// clicava de verdade — foi removido de vez.

export default async function handler(req, res) {
  const file = String(req.query.file || "").toLowerCase();
  if (!FILE_KINDS[file]) {
    return res.status(404).json({
      ok: false,
      error: "unknown_file",
      file,
      available: Object.keys(FILE_KINDS),
    });
  }

  // Sem classificação, sem barreira e SEM contagem no Redis. O Upstash ficou
  // RESERVADO para a licença (2 máquinas por chave); o download aqui é só
  // entrega. Quem conta instalador baixado é o GitHub Releases.

  // ── Qual instalador entregar (macOS / Windows / Linux) ───────────────
  const url = await resolveUrl(file);

  // ── Log do clique no Postgres (Neon) — best-effort ────────────────────
  // O Upstash ficou reservado para a licença; o log de cliques (cidade, nave-
  // gador, remetente) vive no banco. Se o banco faltar ou falhar, o download
  // segue igual (`registrarClique` nunca lança).
  await registrarClique({
    file,
    cc: String(req.headers["x-vercel-ip-country"] || "??")
      .toUpperCase()
      .replace(/[^A-Z]/g, "")
      .slice(0, 2) || "??",
    region: regiao(req),
    city: cidade(req),
    ua: familiaUA(req),
    conta: utmContent(req),
    ref: origemExterna(req),
    path: pagina(req),
    uhash: visitorHash(req),
  });

  // ── Redireciona para o instalador real ────────────────────────────────
  res.setHeader("Cache-Control", "no-store, max-age=0");
  return res.redirect(302, url);
}
