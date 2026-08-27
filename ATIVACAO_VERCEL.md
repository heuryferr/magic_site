# ATIVAÇÃO VERCEL — Trava de 2 Máquinas (Magic Stat)

> ⚠️ **ARQUIVO CRÍTICO — ler antes do deploy.** Este documento registra a
> implementação da **Opção C** (trava de licença em até 2 dispositivos).
> Conteúdo: a Serverless Function, os pontos alterados no app Python e o passo
> a passo para subir no Vercel + testar.

---

## 1. Visão geral da arquitetura

```
┌──────────────┐   POST JSON            ┌─────────────────────────────┐
│  App Python  │ ─────────────────────▶ │  statmagic.vercel.app        │
│  (PySide6)   │  chave + hardware_id   │  /api/verify-license         │
└──────────────┘                        └─────────────┬───────────────┘
                                                      │ POST access_token + chave
                                                      ▼
                                          ┌────────────────────────────┐
                                          │  Gumroad API               │
                                          │  /v2/licenses/verify       │
                                          └─────────────┬──────────────┘
                                                      │ válida?
                                                      ▼
                                          ┌────────────────────────────┐
                                          │  Upstash Redis             │
                                          │  licenses:<CHAVE>          │
                                          │  (máx 2 hardware_ids)      │
                                          └─────────────┬──────────────┘
                                                      │ success | device_limit
                                                      ▼
                                              (resposta ao app)
```

- O **app Python** NÃO fala mais direto com a API pública do Gumroad.
- O **servidor Vercel** valida a chave no Gumroad (com o `GUMROAD_ACCESS_TOKEN`
  guardado no ambiente) e aplica a trava de até 2 dispositivos no Redis.

---

## 2. Serverless Function — `api/verify-license.js`

> **Local:** `api/verify-license.js` (copiar para a pasta `/api` do projeto Vercel).
> **Dependência:** `@upstash/redis` → rodar `npm i @upstash/redis` na raiz do
> projeto Vercel (ou adicionar ao `package.json`).

### Envelope de requisição (POST, JSON)

```json
{
  "license_key": "...",
  "hardware_id": "...",
  "product_id": "hjjfhq",
  "increment_uses_count": false
}
```

### Respostas

| HTTP | shape | significado |
|------|-------|-------------|
| 200  | `{ success:true, purchase:{...}, devices:[...], device_count, device_limit }` | licença válida e registrada |
| 200  | `{ success:false, error:"invalid_license", message }` | chave inválida |
| 200  | `{ success:false, error:"refunded"\|"chargebacked", purchase:{...} }` | reembolso / contestação |
| 403  | `{ success:false, error:"device_limit", message }` | **3º dispositivo** |
| 400  | `{ success:false, error:"bad_request", message }` | payload errado |
| 500  | `{ success:false, error:"server_error", message }` | erro interno |

### Variáveis de ambiente (já configuradas)

- `GUMROAD_ACCESS_TOKEN` — token do Gumroad.
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` — criadas pela
  integração Upstash do Vercel Marketplace.

### Regras da trava (implementadas na function)

- Máximo de **2 `hardware_id`** por chave (`DEVICE_LIMIT = 2`).
- **1º/2º** dispositivo → registra (SADD) e autoriza.
- Dispositivo **já registrado** → autoriza sem duplicar.
- **3º dispositivo distinto** → nega com HTTP 403 `device_limit`.
- Reembolso/chargeback → remove o registro da chave (DEL).
- TTL ~370 dias renovado a cada validação (sincronizado com a licença anual).

---

## 3. Código do arquivo `api/verify-license.js`

```js
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

// Permalink público do produto Magic Stat no Gumroad.
const DEFAULT_PRODUCT_ID = "hjjfhq";

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
```

---

## 4. Alterações no app Python — `utils/licensing.py`

### 4.1 — Constante da URL da nossa rota (linhas ~169-172)

```python
# Rota do NOSSO backend na Vercel: valida a chave no Gumroad E aplica a
# trava de até 2 dispositivos por chave (Upstash Redis). O app NÃO fala mais
# direto com o Gumroad — o servidor encosta na API do Gumroad por nós.
VERIFY_LICENSE_SERVER_URL = "https://statmagic.vercel.app/api/verify-license"
```

> ✏️ Único ponto onde você muda se o domínio da rota mudar um dia.

### 4.2 — Payload com o `hardware_id` (método `verify_license`, ~linhas 784-796)

```python
payload: dict[str, Any] = {
    "license_key": license_key,
    "product_id": product_id,
    "hardware_id": machine_fingerprint(),      # <-- fingerprint da máquina local
    "increment_uses_count": bool(increment_uses_count),
}

logger.info(
    "Verificando licença no servidor de licenças (product_id=%s, chave %s)...",
    product_id,
    _mask_key(license_key),
)
body = self._post_verify(payload)   # <-- chama o nosso servidor (não mais o Gumroad direto)
```

- `hardware_id` = `machine_fingerprint()` — SHA-256 do UUID da máquina (já é hash).
- `validate_license()` (startup) chama o mesmo `verify_license`, logo também passa
  pela trava de 2 dispositivos.

### 4.3 — Método `_post_verify` (novo, logo após o `_post` antigo)

- Faz **POST JSON** para `VERIFY_LICENSE_SERVER_URL`.
- Reutiliza o tratamento de **rede/timeout** → a *graça offline* do startup
  continua valendo (falha de rede vira offline, não bloqueia).
- `403 device_limit` → vira erro `LICENSE_DEVICE_LIMIT` amigável.

### 4.4 — Novo código de erro e o string padrão do Gumroad (referência)

- `LICENSE_DEVICE_LIMIT` = `"license_device_limit"` (mais as constantes
  `_SERVER_ERROR_*` do envelope do servidor).
- `_map_verify_server_error()` converte o envelope em `LicenseError` com
  mensagem amigável.

### Mensagem que o usuário vê no 3º dispositivo

> "Esta licença já está ativada em 2 dispositivos. Para usar numa nova máquina,
> encerre o uso em um dos dispositivos atuais ou entre em contato com o suporte."

---

## 5. Passo a passo no Vercel

1. **Adicionar a dependência** na raiz do projeto Vercel:
   ```bash
   npm i @upstash/redis
   ```
2. **Colocar** `api/verify-license.js` na pasta `/api` do projeto.
3. **Confirmar variables de ambiente** (Settings → Environment Variables):
   - `GUMROAD_ACCESS_TOKEN`
   - `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN`
4. **Fazer deploy** (push para o branch de produção ou `vercel --prod`).
5. **Testar a rota**:

   ```bash
   curl -X POST https://statmagic.vercel.app/api/verify-license \
     -H "Content-Type: application/json" \
     -d '{"license_key":"SUA_CHAVE","hardware_id":"0000000000000000000000000000000000000000000000000000000000000000"}'
   ```

   Esperado (1º device) → `200 { success: true, device_count: 1, ... }`.

---

## 6. Limitações honestas do esquema

- **Não há desativação explícita de device.** Se o usuário formatar o PC
  (hardware_id novo), ele vira um "3º device" e precisaria do suporte para
  liberar. *(Se quiser, adicionamos um endpoint de "desativar este device".)*
- O `hardware_id` enviado é o `machine_fingerprint()` — já é um hash, não é
  dado cru.
- TTL de ~370 dias: dentro da licença anual a trava segura; no ano seguinte o
  registro expira (permite renovação de hardware).

---

*Arquivo gerado automaticamente — registra a implementação da trava de 2 máquinas (Opção C).*
