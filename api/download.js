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
// o cliente AINDA baixa. Atualize junto com a Release quando lembrar — é a
// última versão conhecida boa.
const FALLBACK = {
  macos:
    "https://github.com/heuryferr/MagicStat-Releases/releases/download/" +
    "v1.0.2/MagicStat-1.0.2.dmg",
  windows:
    "https://github.com/heuryferr/MagicStat-Releases/releases/download/" +
    "v1.0.2/MagicStat-1.0.2-setup.exe",
  linux:
    "https://github.com/heuryferr/MagicStat-Releases/releases/download/" +
    "v1.0.2/MagicStat-1.0.2-x86_64.AppImage",
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

// Requisições claramente automáticas (scanners, monitores, curl): o contador
// de VISITAS já separa robôs (api/visit.js) — aqui é o mesmo critério. Sem
// isso, um verificador que segue os três botões da página infla os três
// arquivos em lockstep (visto em 16/09: +5/+5/+5 com 15 IPs distintos).
const ROBOT_RE =
  /bot|crawl|spider|slurp|preview|monitor|uptime|pingdom|curl|wget|python-requests|python-urllib|httpx|axios|node-fetch|go-http|okhttp|headless|phantom|scrapy|facebookexternalhit|whatsapp|telegram|slack|discord|scanner|checker|validator|linkcheck|lighthouse|semrush|ahrefs|dataprovider|masscan|zgrab|nmap/i;

function ehRobo(req) {
  const ua = String(req.headers["user-agent"] || "");
  if (!ua) return true;            // sem user-agent nunca é navegador
  return ROBOT_RE.test(ua);
}

// Um clique de VERDADE sai da nossa página: o track.js grava `?p=...` (sempre)
// e, quando existe, `?ref=...` / `?utm_*=...`. Scanner de link e gateway de
// e-mail NÃO rodam o JS — chegam sem esses parâmetros e sem Referer nosso. Sem
// esta checagem, cada scanner segue os 3 botões e infla os 3 arquivos em
// lockstep (o 6/6/6 de 16/09).
const SITE_HOST = "statmagic.vercel.app";

function ehCliqueDePagina(req) {
  // Só o CLIQUE de gente passa. O track.js grava `dl=1` no href no PRÓPRIO
  // evento de clique; robô/scanner que apenas SEGUE o href do botão (sem
  // clicar — é o caso dos detonadores de link dos e-mails) chega sem a marca
  // e é barrado. Era ele que baixava os TRÊS instaladores e inflava os três
  // arquivos em lockstep (4/4/4 · 74/74/74 · 82/82/82 de 16–18/09).
  return String(req.query.dl || "") === "1";
}

async function _bloquear(req, res, motivo, file) {
  const day = localDayKey();
  try {
    const redis = await getRedis();
    // contabiliza à parte: não é "clique", mas não escondemos o volume
    await Promise.all([
      redis.incr(`downloads:bot:${file}:${day}`),
      redis.incr(`downloads:bot:${file}`),
    ]);
  } catch (err) {
    console.error("download bot counter error:", err?.message ?? err);
  }
  res.setHeader("Cache-Control", "no-store, max-age=0");
  return res.status(403).json({
    ok: false,
    error: motivo,
    hint: "open https://statmagic.vercel.app in a browser to download",
  });
}

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

  // ── Robô óbvio (curl, python, bot de UA): 403 antes de contar/redirecionar
  if (ehRobo(req)) return _bloquear(req, res, "automated_access", file);

  // ── Não veio da nossa página (scanner de link / gateway de e-mail): não
  // conta e não redireciona. Humano com JS desligado tem Referer nosso; com JS
  // ligado tem ?p=...
  if (!ehCliqueDePagina(req)) return _bloquear(req, res, "not_from_page", file);

  // ── Terceira barreira REMOVIDA (era o 403 `multi_os_em_segundos`).
  // Ela tirava o instalador de gente de verdade por 15 min, e o vínculo
  // escolhido (utm_content = a CONTA DE ENVIO do Magic Stat Mail) era o pior
  // possível: essa conta é a mesma para TODOS os destinatários da campanha,
  // então o primeiro que baixava macOS/Windows bloqueava o Windows/Linux de
  // todo mundo que veio do mesmo e-mail. Por IP também doía: duas pessoas
  // atrás do mesmo NAT com o mesmo navegador viram um hash só.
  //
  // O que essa barreira tentava pegar — scanner seguindo os três botões sem
  // clicar — já é barrado acima por ehCliqueDePagina() (exige `?dl=1`, que só
  // o track.js grava no clique real). E o sinal "mesmo visitante pedindo
  // vários sistemas" continua anotado na contabilização abaixo
  // (downloads:multi:*), que é onde ele importa: não inflar as PESSOAS.
  // Aqui não se nega mais um clique de página.

  // ── Qual instalador entregar (macOS / Windows / Linux) ───────────────
  let url = FALLBACK[file];
  try {
    url = await latestUrl(file);
  } catch (err) {
    console.error("download: usando FALLBACK ->", err?.message ?? err);
  }

  // ── Contabilização (nunca derruba o download) ─────────────────────────
  //
  // Duas réguas, de propósito:
  //   • downloads:{file}:{day}  = REQUISIÇÕES (o que o GitHub enxerga);
  //   • downloads:pessoas:{day} = PESSOAS (1 hash IP+UA por dia).
  // Um visitante que leva macOS E Windows E Linux no mesmo dia não é três
  // pessoas: é uma, e o padrão é de máquina — vai para downloads:multi:* em
  // vez de inflar as pessoas. Sem isto, 12 visitantes automáticos levando os
  // três instaladores apareciam como "36 únicos" (12/12/12).
  try {
    const redis = await getRedis();
    const day = localDayKey();
    const hash = visitorHash(req);
    const vistoKey = `downloads:visto:${hash}:${day}`;
    const jaLevou = await redis.smembers(vistoKey);
    const outroSistema = Array.isArray(jaLevou)
      && jaLevou.some((f) => f && f !== file);
    const p = redis.pipeline();
    p.incr(`downloads:${file}:${day}`);
    p.incr(`downloads:${file}:total`);
    p.sadd(`downloads:uniq:${file}:${day}`, hash);
    p.expire(`downloads:uniq:${file}:${day}`, RETENCAO_UNICOS);
    p.sadd(vistoKey, file);
    p.expire(vistoKey, RETENCAO_UNICOS);
    if (outroSistema) {
      p.incr(`downloads:multi:${file}:${day}`);
      p.incr(`downloads:multi:${day}`);
    } else {
      p.sadd(`downloads:pessoas:${day}`, hash);
      p.expire(`downloads:pessoas:${day}`, RETENCAO_UNICOS);
      p.sadd("downloads:pessoas", hash);
    }
    await p.exec();
  } catch (err) {
    console.error("download counter error:", err?.message ?? err);
  }

  // ── De onde veio o clique: país (header do Vercel) + conta (utm_content)
  // Chaves NOVAS (downloads:cc:*, downloads:utm:*) — as de cima não mudam.
  try {
    const redis = await getRedis();
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
    // país × sistema (é o que a aba Países usa: o download do GitHub não tem
    // país, mas o clique no botão tem — e é ele que leva ao arquivo)
    p.incr(`downloads:ccf:${cc}:${file}:${day}`);
    p.expire(`downloads:ccf:${cc}:${file}:${day}`, RETENCAO_INDICE);
    p.sadd(`downloads:ccfs:${day}`, `${cc}|${file}`);
    p.expire(`downloads:ccfs:${day}`, RETENCAO_INDICE);
    p.incr(`downloads:utm:${conta}:${day}`);
    p.incr(`downloads:utm:${conta}`);
    p.sadd(`downloads:utms:${day}`, conta);
    p.expire(`downloads:utms:${day}`, RETENCAO_INDICE);
    p.sadd("downloads:utms", conta);
    p.sadd(`downloads:uniutm:${conta}`, hash);
    p.expire(`downloads:uniutm:${conta}`, RETENCAO_UNICOS);
    // dimensões extras — um hash por dia (1 comando por campo)
    const dimKey = `downloads:x:${day}`;
    p.hincrby(dimKey, `ua:${familiaUA(req)}`, 1);
    p.hincrby(dimKey, `ref:${origemExterna(req)}`, 1);
    p.hincrby(dimKey, `path:${pagina(req)}`, 1);
    p.hincrby(dimKey, `ccut:${cc}|${conta}`, 1);
    p.expire(dimKey, RETENCAO_DIM);
    // LOG das últimas requisições (o dono lê no relatório): hora + arquivo +
    // país + navegador + conta + referrer. LPUSH + LTRIM = lista limitada.
    p.lpush(
      "downloads:log",
      JSON.stringify({
        t: new Date().toISOString(),
        f: file,
        cc,
        ua: familiaUA(req),
        conta,
        ref: origemExterna(req),
      })
    );
    p.ltrim("downloads:log", 0, LOG_MAX - 1);
    await p.exec();
  } catch (err) {
    console.error("download origin counter error:", err?.message ?? err);
  }

  // ── Redireciona para o instalador real ────────────────────────────────
  res.setHeader("Cache-Control", "no-store, max-age=0");
  return res.redirect(302, url);
}

export { ehRobo, ehCliqueDePagina };
