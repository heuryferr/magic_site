// api/release-device.js
// ======================================================================
// Magic Stat — Libera UM dispositivo da chave (self-service).
// ----------------------------------------------------------------------
// Complementa a "trava de 2 máquinas" do /api/verify-license com a opção
// que faltava: REMOVER este computador do registro da chave. É assim que
// um usuário real troca de máquina sem ficar preso:
//
//   1. Na máquina ANTIGA: Help → About Magic Stat → aba License →
//      "Remove this device from this license";
//   2. Na máquina NOVA: ativa a chave normalmente (o slot ficou livre).
//
// Segurança: só quem sabe a chave de licença consegue liberar um
// dispositivo (o Gumroad valida a chave primeiro) — mesmo nível de
// confiança do registro feito pelo verify-license.
//
// Envelope de requisição (POST, JSON):
//   { "license_key": "...", "hardware_id": "...",
//     "product_id":  "rrU3Ea0rVRwxQQoOlEDQbw==" }
//
// Respostas:
//   200 { success:true, devices:[...], device_count, device_limit }
//   200 { success:false, error:"invalid_license"|"refunded"|..., message }
//   400 { success:false, error:"bad_request", message }
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
const DEVICE_TTL_SECONDS = 370 * 24 * 60 * 60;

const json = (res, status, body) => res.status(status).json(body);

function badRequest(res, message) {
  return json(res, 400, { success: false, error: "bad_request", message });
}

function serverError(res, message) {
  return json(res, 500, { success: false, error: "server_error", message });
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
    return serverError(res, "GUMROAD_ACCESS_TOKEN não configurado no ambiente.");
  }

  const redis = getRedis();
  if (!redis) {
    // Sem registro de dispositivos não há slot para liberar: honestidade (é
    // problema NOSSO; a licença em si continua valendo).
    return json(res, 503, {
      success: false,
      error: "device_registry_unavailable",
      reason: "credential_missing",
      message: "Registro de dispositivos não configurado no ambiente.",
    });
  }

  const { license_key, hardware_id, product_id = DEFAULT_PRODUCT_ID } =
    req.body ?? {};

  if (!license_key || !hardware_id) {
    return badRequest(res, "license_key e hardware_id são obrigatórios.");
  }
  if (typeof license_key !== "string" || typeof hardware_id !== "string") {
    return badRequest(res, "license_key e hardware_id devem ser strings.");
  }

  // 1) Só o dono da chave libera: valida no Gumroad (sem incrementar uses).
  let gum;
  try {
    gum = await verifyWithGumroad(license_key, product_id);
  } catch (err) {
    console.error("Erro ao chamar o Gumroad:", err?.message ?? err);
    return serverError(res, "Falha ao contatar o Gumroad.");
  }

  const purchase = gum?.body?.purchase ?? {};
  if (!gum?.body?.success) {
    if (purchase.refunded) {
      await redis.del(`licenses:${license_key}`).catch(() => {});
      return json(res, 200, {
        success: false,
        error: "refunded",
        purchase: { refunded: true, license_key, product_id },
        message: "Compra reembolsada no Gumroad.",
      });
    }
    if (purchase.chargebacked) {
      await redis.del(`licenses:${license_key}`).catch(() => {});
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

  // 2) Remove ESTE hardware_id do conjunto da chave (idempotente: se o
  //    dispositivo não estava registrado, nada muda — só confirma).
  const registryKey = `licenses:${license_key}`;
  const metaKey = `licenses:${license_key}:meta`;
  let members;
  try {
    await redis.srem(registryKey, hardware_id);
    // Some com os metadados do dispositivo liberado (a lista não pode mostrar
    // uma máquina que já não ocupa slot).
    await redis.hdel(metaKey, hardware_id).catch(() => {});
    members = await redis.smembers(registryKey);
    if (members.length > 0) {
      // Renova o TTL para as máquinas que continuam ativas.
      await redis.expire(registryKey, DEVICE_TTL_SECONDS);
    } else {
      // Nenhum dispositivo restante: apaga o registro da chave.
      await redis.del(registryKey).catch(() => {});
      await redis.del(metaKey).catch(() => {});
    }
  } catch (err) {
    console.error("Erro no Upstash Redis:", err?.message ?? err);
    return json(res, 503, {
      success: false,
      error: "device_registry_unavailable",
      reason: "registry_error",
      message: "Falha ao acessar o registro de dispositivos.",
    });
  }

  return json(res, 200, {
    success: true,
    message: "Dispositivo liberado. Reative a licença na máquina nova.",
    devices: members,
    device_count: members.length,
    device_limit: DEVICE_LIMIT,
  });
}
