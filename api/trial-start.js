// api/trial-start.js
// ======================================================================
// Magic Stat — Beacon ANÔNIMO de início do trial (48 horas).
// ----------------------------------------------------------------------
// O app desktop envia UM ping por instalação quando o trial começa:
//
//   POST /api/trial-start
//   {
//     "install_id": "uuid-aleatório",     // NÃO identifica a pessoa
//     "platform":   "macos",              // macos | windows | linux
//     "os_release": "23.4.0",             // opcional
//     "app_version": "1.0.0",
//     "days_left": 2
//   }
//
// Respostas:
//   200 { success:true }                       — registrado
//   200 { success:true, duplicate:true }       — mesma instalação já contada
//   400 { success:false, error:"bad_request" } — payload inválido
//   503 { success:false, error:"trial_registry_unavailable" } — banco fora
//   500 { success:false, error:"server_error" } — falha inesperada
//
// Armazenamento (Upstash Redis — o MESMO já usado pelo verify-license):
//   * contador diário por plataforma:
//       stats:trial:YYYY-MM-DD:macos   (INCR)
//   * dedupe por instalação (evita contar 2x se o app abrir de novo):
//       stats:trial:install:<install_id>  (SETNX + TTL 400 dias)
//
// SEM dados pessoais: não guarda email, IP, hardware_id nem conteúdo.
//
// ⚠️ ESTA ROTA JÁ FICOU MESES FORA DO AR: o arquivo existia no repositório do
// app, mas nunca foi publicado no projeto do site — o servidor respondia 404 e
// o app engolia o erro em silêncio (roda em thread e não mostra nada). Ou seja:
// ninguém era incomodado, mas o dono ficava SEM estatística de trial sem
// desconfiar. Agora ela é PUBLICADA e tem teste na bateria
// (qa_legado/probe_license_server_js.py).
// ======================================================================

import { Redis } from "@upstash/redis";
import { registrarTrial } from "./_db.js";

// Cliente SOB DEMANDA + CANDIDATOS (ver api/verify-license.js): a Vercel cria
// KV_REST_API_* quando o banco vem pela KV e UPSTASH_REDIS_REST_* quando vem
// pelo Marketplace Upstash — e as duas podem coexistir, com a de banco APAGADO
// entre elas. Criar o cliente no topo do arquivo (com o par fixo UPSTASH_*)
// fazia a rota morrer antes de contar qualquer coisa. Agora testamos os
// candidatos e ficamos com o que RESPONDE.
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

async function withRedis(fn) {
  if (_redis) return fn(_redis);
  const cands = redisCandidates();
  if (!cands.length) {
    const err = new Error("no redis credentials in the environment");
    err.code = "credential_missing";
    throw err;
  }
  let lastErr = null;
  for (const [url, token] of cands) {
    const client = new Redis({ url, token });
    try {
      const out = await fn(client);
      _redis = client;
      return out;
    } catch (err) {
      lastErr = err;
      console.error(
        "Upstash: candidato falhou, tentando o proximo se houver:",
        err?.message ?? err
      );
    }
  }
  throw lastErr || new Error("redis unavailable");
}

const INSTALL_TTL_SECONDS = 400 * 24 * 60 * 60; // dedupe ~1 ano

const json = (res, status, body) => res.status(status).json(body);

// ── Geolocalizacao COARSE da instalacao (dono, 2026-09-23) ──────────────
// Vem dos cabecalhos do Vercel (x-vercel-ip-*), os MESMOS que as tabelas
// clicks/visits ja usam. Sem IP: pais/estado/cidade e o maximo que guardamos.
function limpaTexto(valor, max = 60) {
  return String(valor || "")
    .replace(/[<>&"'`\\]/g, "")
    .trim()
    .slice(0, max);
}
function regiao(req) {
  return limpaTexto(req.headers["x-vercel-ip-country-region"], 8).toUpperCase();
}
function cidade(req) {
  const bruto = String(req.headers["x-vercel-ip-city"] || "");
  let c = bruto;
  try {
    c = decodeURIComponent(bruto);
  } catch (err) {
    /* '%' invalido no cabecalho: fica como veio */
  }
  return limpaTexto(c, 60);
}
function pais(req) {
  return (
    String(req.headers["x-vercel-ip-country"] || "??")
      .toUpperCase()
      .replace(/[^A-Z]/g, "")
      .slice(0, 2) || "??"
  );
}

// Detalhe SEGURO do erro do Redis (ver api/license-devices.js): junta a causa
// raiz e MASCARA url, token e host antes de devolver.
function safeDetail(err) {
  const parts = [];
  const push = (e) => {
    if (!e) return;
    const msg = String((e && e.message) || e || "");
    const code = String((e && e.code) || "");
    const txt = (code ? code + " " : "") + msg;
    if (txt.trim()) parts.push(txt.trim());
  };
  push(err);
  if (err && err.cause) push(err.cause);
  return parts
    .join(" | ")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/[A-Za-z0-9_\-]{24,}/g, "[token]")
    .replace(/[a-z0-9.\-]*upstash\.io/gi, "[host]")
    .slice(0, 200);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, {
      success: false,
      error: "method_not_allowed",
      message: "Use POST.",
    });
  }

  const {
    install_id,
    platform,
    app_version,
    os_release = "",
    days_left = 0,
  } = req.body ?? {};

  const validPlatforms = ["macos", "windows", "linux"];
  if (
    !install_id ||
    typeof install_id !== "string" ||
    !validPlatforms.includes(platform)
  ) {
    return json(res, 400, {
      success: false,
      error: "bad_request",
      message: "install_id (string) e platform (macos|windows|linux) são obrigatórios.",
    });
  }

  // Registro no POSTGRES — o Redis ficou reservado à licença. O dedupe é o
  // índice único em `install_id`: a MESMA instalação conta UMA vez.
  const resultado = await registrarTrial({
    install_id, platform,
    cc: pais(req), region: regiao(req), city: cidade(req),
  });
  if (resultado === null) {
    // Sem banco configurado (ou falha): declarado como indisponível.
    return json(res, 503, {
      success: false,
      error: "trial_registry_unavailable",
      reason: "registry_error",
      message: "Falha ao acessar o registro de trials.",
    });
  }
  if (resultado === "duplicado") {
    return json(res, 200, { success: true, duplicate: true });
  }
  return json(res, 200, { success: true });
}
