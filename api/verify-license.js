// api/verify-license.js
// ======================================================================
// Magic Stat — Serverless de licenças (Vercel + Upstash Redis + Gumroad).
// ----------------------------------------------------------------------
// Tramo a "trava de 2 máquinas" (Opção C): valida a chave no Gumroad e
// registra até 2 dispositivos (hardware_id) por chave no Upstash Redis.
//
// ➕ INSTRUMENTADO PARA ANALYTICS (ver ANALYTICS.md na raiz do repo):
//   a cada ativação bem-sucedida, grava em Redis uma linha de CRM com:
//     - email (vem do Gumroad — é do comprador, ok),
//     - país derivado do IP da requisição (header x-vercel-ip-country —
//       a Vercel injeta automaticamente),
//     - instituição/área: `purchase.custom_fields` do Gumroad (campos
//       opcionais criados no checkout do produto),
//     - plataforma/versão do app (enviadas no payload).
//   Chaves: analytics:sales:<YYYY-MM-DD> (SADD de JSON) + totais simples.
//   Nada disso altera a validação — é fire-and-forget com try/catch.
//
// Envelope de requisição (POST, JSON):
//   {
//     "license_key": "...",             // chave do Gumroad (obrigatório)
//     "hardware_id": "...",             // fingerprint SHA-256 da máquina (obrigat.)
//     "product_id":  "hjjfhq",          // permalink do produto (opcional)
//     "increment_uses_count": false,    // se toca o contador 'uses' do Gumroad
//     "platform": "macos",              // ➕ analytics (opcional)
//     "app_version": "1.0.0"            // ➕ analytics (opcional)
//   }
//
// Respostas: (inalteradas)
//   200 { success:true,  purchase:{...}, devices:[...], device_count, device_limit }
//   200 { success:false, error:"invalid_license", message }
//   200 { success:false, error:"refunded"|"chargebacked", purchase:{...} }
//   403 { success:false, error:"device_limit", message }
//   400 { success:false, error:"bad_request", message }
//   500 { success:false, error:"server_error", message }
// ======================================================================

import { Redis } from "@upstash/redis";
import { registrarVenda } from "./_db.js";

const GUMROAD_VERIFY_URL = "https://api.gumroad.com/v2/licenses/verify";

// Configurado no painel da Vercel: Settings -> Environment Variables.
const GUMROAD_ACCESS_TOKEN = process.env.GUMROAD_ACCESS_TOKEN;

// Upstash Redis conectado (Vercel Marketplace -> Upstash Redis). As variáveis
// UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN são criadas automaticamente
// pela integração.
//
// Cliente SOB DEMANDA: se as variáveis sumirem (ou a integração for
// desconectada), o construtor do @upstash/redis estouraria no carregamento do
// módulo e a função morreria ANTES de validar qualquer chave — foi o que
// aconteceu no incidente de 2026-09-18. Sem Redis, a validação continua (só
// sem a trava de dispositivos e sem analytics).
//
// ACEITA OS DOIS NOMES de variável que a Vercel usa, e testa os dois na ordem
// (ver withRedis/redisCandidates acima).
let _redis = null;
let _redisReason = "ok"; // ok | credential_missing

// CREDENCIAIS CANDIDATAS, em ordem. A Vercel cria KV_REST_API_* quando o banco
// vem pela KV e UPSTASH_REDIS_REST_* quando vem pelo Marketplace Upstash — e as
// duas podem coexistir (foi o que aconteceu em 18/09/2026: as UPSTASH_* eram de
// um banco APAGADO e o servidor insistia nelas).
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

/**
 * Roda `fn(cliente)` no PRIMEIRO candidato que RESPONDER.
 *
 * É o que torna o servidor imune a variável velha: credencial de banco apagado
 * não derruba mais o serviço quando existe outra válida no ambiente. O cliente
 * que funcionou fica em cache (as chamadas seguintes não repetem o teste).
 */
async function withRedis(fn) {
  if (_redis) return fn(_redis);
  const cands = redisCandidates();
  if (!cands.length) {
    _redisReason = "credential_missing";
    const err = new Error("no redis credentials in the environment");
    err.code = "credential_missing";
    throw err;
  }
  let lastErr = null;
  for (const [url, token] of cands) {
    const client = new Redis({ url, token });
    try {
      const out = await fn(client);
      _redis = client; // este respondeu: é o bom
      _redisReason = "ok";
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

// Motivo curto para log/resposta (nunca com valores, host ou token).
function redisReason(opFailed, err) {
  if (err && err.code === "credential_missing") return "credential_missing";
  return opFailed ? "registry_error" : _redisReason;
}

// Nº máximo de dispositivos por chave de licença.
const DEVICE_LIMIT = 2;

// product_id interno (NÃO o permalink/slug "hjjfhq"): é o que o Gumroad aceita
// no campo product_id do verify — conferido na resposta do teste real. (O app
// sempre manda o product_id dele; isto vale para chamadas sem product_id.)
const DEFAULT_PRODUCT_ID = "rrU3Ea0rVRwxQQoOlEDQbw==";

// TTL do registro de dispositivos: ~1 ano (equivale à licença anual), renovado
// a cada validação para que um usuário ativo nunca perca seus devices — e o
// registro some no ano seguinte, aceitando renovação de hardware.
const DEVICE_TTL_SECONDS = 370 * 24 * 60 * 60;

const json = (res, status, body) => res.status(status).json(body);

function badRequest(res, message) {
  return json(res, 400, { success: false, error: "bad_request", message });
}

function serverError(res, message) {
  return json(res, 500, { success: false, error: "server_error", message });
}

/**
 * Valida a chave no Gumroad via POST /v2/licenses/verify.
 * @returns {{ httpStatus: number, body: Record<string, any> }}
 */
async function verifyWithGumroad(licenseKey, productId, incrementUses) {
  const form = new URLSearchParams();
  form.append("access_token", GUMROAD_ACCESS_TOKEN);
  form.append("product_id", productId);
  form.append("license_key", licenseKey);
  if (incrementUses) form.append("increment_uses_count", "true");

  const res = await fetch(GUMROAD_VERIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const body = await res.json().catch(() => ({}));
  return { httpStatus: res.status, body };
}

// ----------------------------------------------------------------------
// ➕ ANALYTICS — helpers (fire-and-forget; nunca quebram a validação)
// ----------------------------------------------------------------------
function customField(customFields, wanted) {
  // Gumroad devolve purchase.custom_fields como [{name, value}, ...]
  const arr = Array.isArray(customFields) ? customFields : [];
  for (const f of arr) {
    if (f && String(f.name).toLowerCase() === wanted.toLowerCase()) {
      return String(f.value ?? "").trim();
    }
  }
  return "";
}

/** Metadados de UM dispositivo (para o usuário se reconhecer na lista). */
function deviceMeta(prev, platform, appVersion) {
  const now = new Date().toISOString();
  const before = prev && typeof prev === "object" ? prev : {};
  return {
    first_seen: before.first_seen || now,
    last_seen: now,
    platform: platform || before.platform || null,
    app_version: appVersion || before.app_version || null,
  };
}

async function recordSaleAnalytics(purchase, meta) {
  // meta = { country, platform, app_version, license_key }
  // As SUAS próprias ativações (chave do dono, testes) não são venda: liste as
  // chaves em OWNER_LICENSE_KEYS (Vercel → Environment Variables), separadas
  // por vírgula; elas nunca entram na estatística.
  try {
    const minhas = String(process.env.OWNER_LICENSE_KEYS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const chave = String(meta?.license_key || purchase?.license_key || "").trim();
    if (chave && minhas.includes(chave)) return;
  } catch (err) {
    /* sem lista configurada: segue normalmente */
  }
  try {
    const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    const fields = purchase.custom_fields ?? [];
    const email = purchase.email ?? meta.email ?? "";
    const country = meta.country || "??";
    // Venda registrada no POSTGRES (o Redis ficou reservado à licença).
    await registrarVenda({
      license_key: purchase.license_key || meta.license_key || "",
      platform: meta.platform || "unknown",
      country,
      email,
    });
  } catch (err) {
    console.error("Analytics record falhou (ignorado):", err?.message ?? err);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, {
      success: false,
      error: "method_not_allowed",
      message: "Use POST.",
    });
  }

  if (!GUMROAD_ACCESS_TOKEN) {
    return serverError(res, "GUMROAD_ACCESS_TOKEN não configurado no ambiente.");
  }

  const {
    license_key,
    hardware_id,
    product_id = DEFAULT_PRODUCT_ID,
    increment_uses_count = false,
    platform = "",
    app_version = "",
  } = req.body ?? {};

  if (!license_key || !hardware_id) {
    return badRequest(res, "license_key e hardware_id são obrigatórios.");
  }
  if (typeof license_key !== "string" || typeof hardware_id !== "string") {
    return badRequest(res, "license_key e hardware_id devem ser strings.");
  }
  if (typeof increment_uses_count !== "boolean") {
    return badRequest(res, "increment_uses_count deve ser booleano.");
  }

  // ----------------------------------------------------------------
  // 1) Valida a chave no Gumroad.
  // ----------------------------------------------------------------
  let gum;
  try {
    gum = await verifyWithGumroad(license_key, product_id, increment_uses_count);
  } catch (err) {
    console.error("Erro ao chamar o Gumroad:", err?.message ?? err);
    return serverError(res, "Falha ao contatar o Gumroad.");
  }

  const purchase = gum?.body?.purchase ?? {};
  if (!gum?.body?.success) {
    // Gumroad respondeu mas negou a chave (inválida / reembolso / chargeback).
    if (purchase.refunded) {
      // Limpa o CADERNINHO inteiro desta chave: sem vagas e sem metadados
      // orfaos (senao o registro do dispositivo ficaria pendurado ~1 ano).
      await withRedis(async (r) => {
        await r.del(`licenses:${license_key}`);
        await r.del(`licenses:${license_key}:meta`);
      }).catch(() => {});
      return json(res, 200, {
        success: false,
        error: "refunded",
        purchase: { refunded: true, license_key, product_id },
        message: "Compra reembolsada no Gumroad.",
      });
    }
    if (purchase.chargebacked) {
      // Mesmo tratamento do reembolso: veredito honesto + caderninho limpo.
      await withRedis(async (r) => {
        await r.del(`licenses:${license_key}`);
        await r.del(`licenses:${license_key}:meta`);
      }).catch(() => {});
      return json(res, 200, {
        success: false,
        error: "chargebacked",
        purchase: { chargebacked: true, license_key, product_id },
        message: "Pagamento contestado no Gumroad.",
      });
    }
    return json(res, 200, {
      success: false,
      error: "invalid_license",
      message: gum?.body?.message || "Chave de licença inválida.",
    });
  }

  // ----------------------------------------------------------------
  // 2) Trava de dispositivos no Upstash Redis (DEGRADA, nunca derruba).
  //    A chave JÁ foi validada pelo Gumroad: falha nossa de infraestrutura
  //    não pode virar recusa para quem pagou (incidente 2026-09-18).
  // ----------------------------------------------------------------
  const registryKey = `licenses:${license_key}`;
  const metaKey = `licenses:${license_key}:meta`;
  let members = [];
  let deviceLockApplied = true;
  let lockReason = "ok";
  {
    try {
      const resultado = await withRedis(async (redis) => {
        let membros = await redis.smembers(registryKey);
        if (!membros.includes(hardware_id)) {
          if (membros.length >= DEVICE_LIMIT) return { lim: DEVICE_LIMIT };
          await redis.sadd(registryKey, hardware_id);
        }
        // Renova o TTL a cada validação: usuário ativo nunca perde o registro.
        await redis.expire(registryKey, DEVICE_TTL_SECONDS);
        membros = await redis.smembers(registryKey);
        // Metadados por dispositivo (data/plataforma/versão): é o que deixa a
        // lista de dispositivos legível para o usuário.
        let prev = null;
        try {
          const meta = (await redis.hgetall(metaKey)) || {};
          prev = meta[hardware_id] ?? null;
          if (typeof prev === "string") prev = JSON.parse(prev);
        } catch (metaErr) {
          prev = null;
        }
        try {
          await redis.hset(metaKey, {
            [hardware_id]: JSON.stringify(deviceMeta(prev, platform, app_version)),
          });
          await redis.expire(metaKey, DEVICE_TTL_SECONDS);
        } catch (metaErr) {
          console.error(
            "Metadados do dispositivo nao gravados:",
            metaErr?.message ?? metaErr
          );
        }
        return { membros };
      });
      if (resultado.lim) {
        // Veredito de NEGÓCIO (o cliente tem 2 máquinas ativas): propaga.
        return json(res, 403, {
          success: false,
          error: "device_limit",
          message: `Esta licença já está ativada em ${resultado.lim} dispositivos. Encerre o uso em um deles para liberar esta máquina.`,
        });
      }
      members = resultado.membros || [];
    } catch (err) {
      console.error(
        "Registro de dispositivos indisponivel — licenca liberada SEM a trava:",
        err?.message ?? err
      );
      deviceLockApplied = false;
      lockReason = redisReason(true, err);
      members = [];
    }
  }

  // ----------------------------------------------------------------
  // 3) ➕ ANALYTICS: grava país/instituição/plataforma (sem travar).
  //    País vem do header que a Vercel injeta (x-vercel-ip-country).
  // ----------------------------------------------------------------
  const country = String(
    (req.headers || {})["x-vercel-ip-country"] || ""
  ).toUpperCase();
  await recordSaleAnalytics(purchase, {
    country,
    platform,
    app_version,
    license_key,
  });

  // ----------------------------------------------------------------
  // 4) Sucesso: devolve o payload no formato que o app desktop espera.
  // ----------------------------------------------------------------
  return json(res, 200, {
    success: true,
    message: "Licença válida e registrada para este dispositivo.",
    devices: members,
    device_count: members.length,
    device_limit: DEVICE_LIMIT,
    device_lock_applied: deviceLockApplied,
    device_lock_reason: deviceLockApplied ? "ok" : lockReason,
    uses: purchase.uses ?? null,
    purchase: {
      license_key: purchase.license_key || license_key,
      product_id: purchase.product_id || product_id,
      email: purchase.email ?? null,
      product_name: purchase.product_name ?? null,
      refunded: Boolean(purchase.refunded),
      chargebacked: Boolean(purchase.chargebacked),
      uses: purchase.uses ?? null,
    },
  });
}
