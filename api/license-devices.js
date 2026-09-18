// api/license-devices.js
// ======================================================================
// Magic Stat — LISTA os dispositivos registrados numa chave de licença.
// ----------------------------------------------------------------------
// Por que existe (pedido do dono, 2026-09-18): a trava de 2 dispositivos só
// funciona se o cliente tiver como LIBERAR a máquina que não usa mais. Antes
// existia só "Remove this device" A PARTIR da máquina antiga — quem formatou,
// perdeu ou vendeu o computador ficava num beco sem saída e precisava de
// suporte. Agora o app lista os dispositivos (com data de primeiro/último uso
// e plataforma) e o usuário remove qualquer um deles, de qualquer máquina.
//
// Segurança: a chave é validada no Gumroad ANTES de qualquer leitura — só quem
// sabe a chave vê a lista (mesmo nível de confiança do verify/release).
// A remoção continua na rota /api/release-device (que aceita qualquer
// hardware_id da lista).
//
// Envelope de requisição (POST, JSON):
//   {
//     "license_key": "...",              // obrigatório
//     "hardware_id": "...",              // opcional: marca qual é ESTE aparelho
//     "product_id":  "rrU3Ea0rVRwxQQoOlEDQbw=="  // opcional
//   }
//
// Respostas:
//   200 { success:true, devices:[{id, first_seen, last_seen, platform,
//         app_version, current}], device_count, device_limit }
//   200 { success:false, error:"invalid_license"|"refunded"|"chargebacked", message }
//   400 { success:false, error:"bad_request", message }
//   503 { success:false, error:"device_registry_unavailable", message }
//   500 { success:false, error:"server_error", message }
// ======================================================================

import { Redis } from "@upstash/redis";

const GUMROAD_VERIFY_URL = "https://api.gumroad.com/v2/licenses/verify";

const GUMROAD_ACCESS_TOKEN = process.env.GUMROAD_ACCESS_TOKEN;

// Cliente sob demanda (ver a nota em api/verify-license.js): sem as variáveis
// do Upstash o construtor estouraria no carregamento do módulo.
let _redis = null;
function getRedis() {
  if (_redis) return _redis;
  // Aceita os DOIS nomes que a Vercel usa (Upstash Marketplace ->
  // UPSTASH_REDIS_REST_*; Vercel KV -> KV_REST_API_*), senão o servidor fica
  // "sem credencial" mesmo com o banco ligado ao projeto.
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  _redis = new Redis({ url, token });
  return _redis;
}

const DEVICE_LIMIT = 2;
const DEFAULT_PRODUCT_ID = "rrU3Ea0rVRwxQQoOlEDQbw==";

const json = (res, status, body) => res.status(status).json(body);

// Detalhe SEGURO do erro do Redis, para diagnosticar sem acesso aos logs:
// remove URLs e tokens antes de devolver (nunca expõe credencial).
function safeDetail(err) {
  const raw = String((err && err.message) || err || "");
  return raw
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/[A-Za-z0-9_\-]{24,}/g, "[token]")
    .slice(0, 140);
}

async function verifyWithGumroad(licenseKey, productId) {
  const form = new URLSearchParams();
  form.append("access_token", GUMROAD_ACCESS_TOKEN);
  form.append("product_id", productId);
  form.append("license_key", licenseKey);
  const res = await fetch(GUMROAD_VERIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const body = await res.json().catch(() => ({}));
  return { httpStatus: res.status, body };
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
    return json(res, 500, {
      success: false,
      error: "server_error",
      message: "GUMROAD_ACCESS_TOKEN não configurado no ambiente.",
    });
  }

  const { license_key, hardware_id = null, product_id = DEFAULT_PRODUCT_ID } =
    req.body ?? {};

  if (!license_key || typeof license_key !== "string") {
    return json(res, 400, {
      success: false,
      error: "bad_request",
      message: "license_key é obrigatório.",
    });
  }

  // 1) Só o dono da chave vê a lista.
  let gum;
  try {
    gum = await verifyWithGumroad(license_key, product_id);
  } catch (err) {
    console.error("Erro ao chamar o Gumroad:", err?.message ?? err);
    return json(res, 500, {
      success: false,
      error: "server_error",
      message: "Falha ao contatar o Gumroad.",
    });
  }

  const purchase = gum?.body?.purchase ?? {};
  if (!gum?.body?.success) {
    if (purchase.refunded) {
      return json(res, 200, {
        success: false,
        error: "refunded",
        purchase: { refunded: true, license_key, product_id },
        message: "Compra reembolsada no Gumroad.",
      });
    }
    if (purchase.chargebacked) {
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

  // 2) A lista É o registro no Redis: sem ele não há o que mostrar. Aqui a
  //    resposta honesta é 503 (e o app diz que é problema nosso), porque não
  //    existe lista para inventar.
  const redis = getRedis();
  if (!redis) {
    return json(res, 503, {
      success: false,
      error: "device_registry_unavailable",
      reason: "credential_missing",
      message: "Registro de dispositivos não configurado no ambiente.",
    });
  }

  const registryKey = `licenses:${license_key}`;
  const metaKey = `licenses:${license_key}:meta`;
  let ids = [];
  let meta = {};
  try {
    ids = await redis.smembers(registryKey);
    meta = (await redis.hgetall(metaKey)) || {};
  } catch (err) {
    console.error("Erro no Upstash Redis:", err?.message ?? err);
    return json(res, 503, {
      success: false,
      error: "device_registry_unavailable",
      reason: "registry_error",
      detail: safeDetail(err),
      message: "Falha ao acessar o registro de dispositivos.",
    });
  }

  const devices = (ids || []).map((id) => {
    let info = meta[id] ?? null;
    if (typeof info === "string") {
      try {
        info = JSON.parse(info);
      } catch (_) {
        info = null;
      }
    }
    const data = info && typeof info === "object" ? info : {};
    return {
      id,
      first_seen: data.first_seen ?? null,
      last_seen: data.last_seen ?? null,
      platform: data.platform ?? null,
      app_version: data.app_version ?? null,
      current: hardware_id ? id === hardware_id : false,
    };
  });

  // Mais recente primeiro: é assim que o usuário reconhece o computador que
  // está usando agora e o que ficou para trás.
  devices.sort((a, b) => String(b.last_seen || "").localeCompare(String(a.last_seen || "")));

  return json(res, 200, {
    success: true,
    devices,
    device_count: devices.length,
    device_limit: DEVICE_LIMIT,
  });
}
