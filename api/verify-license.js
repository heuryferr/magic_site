// api/verify-license.js
// ======================================================================
// Magic Stat — Serverless de licenças (Vercel + Upstash Redis + Gumroad).
// ----------------------------------------------------------------------
// Tramo a "trava de 2 máquinas" (Opção C): valida a chave no Gumroad e
// registra até 2 dispositivos (hardware_id) por chave no Upstash Redis.
//
// Envelope de requisição (POST, JSON):
//   {
//     "license_key": "...",             // chave do Gumroad (obrigatório)
//     "hardware_id": "...",             // fingerprint SHA-256 da máquina (obrigat.)
//     "product_id":  "hjjfhq",          // permalink do produto (opcional)
//     "increment_uses_count": false     // se toca o contador 'uses' do Gumroad
//   }
//
// Respostas:
//   200 { success:true,  purchase:{...}, devices:[...], device_count, device_limit }
//   200 { success:false, error:"invalid_license", message }
//   200 { success:false, error:"refunded"|"chargebacked", purchase:{...} }
//   403 { success:false, error:"device_limit", message }
//   400 { success:false, error:"bad_request", message }
//   500 { success:false, error:"server_error", message }
// ======================================================================

import { Redis } from "@upstash/redis";

const GUMROAD_VERIFY_URL = "https://api.gumroad.com/v2/licenses/verify";

// Configurado no painel da Vercel: Settings -> Environment Variables.
const GUMROAD_ACCESS_TOKEN = process.env.GUMROAD_ACCESS_TOKEN;

// Upstash Redis conectado (Vercel Marketplace -> Upstash Redis). As variáveis
// UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN são criadas automaticamente
// pela integração.
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Nº máximo de dispositivos por chave de licença.
const DEVICE_LIMIT = 2;

// product_id do produto Magic Stat no Gumroad.
// O Gumroad exige este valor ao validar (devolvido na mensagem de erro da API).
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
  // O Gumroad pede o parâmetro 'product_id' com o ID da conta do produto.
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
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return serverError(res, "Upstash Redis não configurado no ambiente.");
  }

  const {
    license_key,
    hardware_id,
    product_id = DEFAULT_PRODUCT_ID,
    increment_uses_count = false,
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

  // ----------------------------------------------------------------
  // 2) Trava de dispositivos no Upstash Redis (um conjunto por chave).
  // ----------------------------------------------------------------
  const registryKey = `licenses:${license_key}`;
  let members;
  try {
    members = await redis.smembers(registryKey);
    if (!members.includes(hardware_id)) {
      if (members.length >= DEVICE_LIMIT) {
        return json(res, 403, {
          success: false,
          error: "device_limit",
          message: `Esta licença já está ativada em ${DEVICE_LIMIT} dispositivos. Encerre o uso em um deles para liberar esta máquina.`,
        });
      }
      await redis.sadd(registryKey, hardware_id);
    }
    // Renova o TTL a cada validação: usuário ativo nunca perde o registro.
    await redis.expire(registryKey, DEVICE_TTL_SECONDS);
    members = await redis.smembers(registryKey);
  } catch (err) {
    console.error("Erro no Upstash Redis:", err?.message ?? err);
    return serverError(res, "Falha ao acessar o registro de dispositivos.");
  }

  // ----------------------------------------------------------------
  // 3) Sucesso: devolve o payload no formato que o app desktop espera.
  // ----------------------------------------------------------------
  return json(res, 200, {
    success: true,
    message: "Licença válida e registrada para este dispositivo.",
    devices: members,
    device_count: members.length,
    device_limit: DEVICE_LIMIT,
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
