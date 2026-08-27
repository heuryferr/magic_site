# FALTANDO — Checklist para completar a ativação da TRAVA DE 2 MÁQUINAS (Magic Stat)

> ⚠️ Este arquivo foi gerado pelo agente no repositório `Magic_Site` (site de
> divulgação). Ele lista **tudo que falta** para a Opção C funcionar de ponta a
> ponta. Execute os itens abaixo no projeto/código **deste** repositório atual.

---

## Contexto rápido

- A "trava de 2 dispositivos" já foi definida em `ATIVACAO_VERCEL.md`.
- A Serverless Function de referência já existe no repo `Magic_Site`:
  - `Magic_Site/api/verify-license.js` — fonte do código a ser usado no backend Vercel.
- **Falta** aplicar as mudanças no código do **programa Python** e configurar o
  **projeto Vercel** que hospeda a rota `statmagic.vercel.app/api/verify-license`.

---

## O que este repositório (`Magic Stat` — programa/app Python) precisa

### 1. Alterar `utils/licensing.py` — Seção 4 do `ATIVACAO_VERCEL.md`

Todas as alterações abaixo correspondem ao que o arquivo `ATIVACAO_VERCEL.md`
(no repo `Magic_Site`) descreve na **Seção 4**.

#### 4.1 — Constante da URL da nossa rota (inserir perto das outras constantes)

```python
# Rota do NOSSO backend na Vercel: valida a chave no Gumroad E aplica a
# trava de até 2 dispositivos por chave (Upstash Redis). O app NÃO fala mais
# direto com o Gumroad — o servidor encosta na API do Gumroad por nós.
VERIFY_LICENSE_SERVER_URL = "https://statmagic.vercel.app/api/verify-license"
```

> ✏️ Único ponto onde muda se o domínio da rota mudar um dia.

#### 4.2 — Payload com o `hardware_id` (dentro do método `verify_license`)

Localizar o payload que hoje monta a chamada ao Gumroad e trocar para:

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

- `hardware_id` = `machine_fingerprint()` — já deve existir (SHA-256 do UUID da máquina).
- `validate_license()` (startup) chama o mesmo `verify_license`, logo também passa
  pela trava de 2 dispositivos.

#### 4.3 — Novo método `_post_verify` (colocar logo após o método `_post` antigo)

- Faz **POST JSON** para `VERIFY_LICENSE_SERVER_URL`.
- Reutiliza o tratamento de **rede/timeout** (a "graça offline" do startup continua:
  falha de rede vira offline, não bloqueia).
- `403 device_limit` → vira erro `LICENSE_DEVICE_LIMIT` amigável.

#### 4.4 — Novo código de erro e mapeamento da mensagem

- `LICENSE_DEVICE_LIMIT` = `"license_device_limit"` (mais constantes
  `_SERVER_ERROR_*` do envelope do servidor).
- `_map_verify_server_error()` — converter o envelope do servidor em `LicenseError`
  com mensagem amigável.

#### Mensagem que o usuário vê no 3º dispositivo

> "Esta licença já está ativada em 2 dispositivos. Para usar numa nova máquina,
> encerre o uso em um dos dispositivos atuais ou entre em contato com o suporte."

---

## O que o PROJETO VERCEL (backend) precisa

> ⚠️ Este repositório pode ou não ser o projeto Vercel. O deploy da rota
> `statmagic.vercel.app/api/verify-license` precisa de:

1. **Adicionar a dependência** na raiz do projeto Vercel:
   ```bash
   npm i @upstash/redis
   ```
   > Isso instala a biblioteca e adiciona sozinho `"@upstash/redis"` ao
   > `"dependencies"` do `package.json`. **Não** digitar a entrada na mão; o `npm i`
   > cuida disso. (Nome correto: `@upstash/redis` com "sh").

2. **Colocar** o arquivo `api/verify-license.js` na pasta `/api` do projeto Vercel
   (copiar do repo `Magic_Site`).

3. **Configurar variáveis de ambiente** (Vercel → Settings → Environment Variables):
   - `GUMROAD_ACCESS_TOKEN`
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

4. **Deploy** (push para o branch de produção ou `vercel --prod`).

5. **Testar a rota**:
   ```bash
   curl -X POST https://statmagic.vercel.app/api/verify-license \
     -H "Content-Type: application/json" \
     -d '{"license_key":"SUA_CHAVE","hardware_id":"0000000000000000000000000000000000000000000000000000000000000000"}'
   ```
   Esperado (1º device): `200 { success: true, device_count: 1, ... }`.

---

## Regras da trava (para conferência do agente)

- Máximo de **2 `hardware_id`** por chave (`DEVICE_LIMIT = 2`).
- 1º/2º dispositivo → registra e autoriza.
- Dispositivo já registrado → autoriza sem duplicar.
- **3º dispositivo distinto** → nega com HTTP 403 `device_limit`.
- Reembolso/chargeback → remove o registro da chave (DEL).
- TTL ~370 dias renovado a cada validação (sincronizado com a licença anual).

---

## Fontes de referência

- `Magic_Site/ATIVACAO_VERCEL.md` — documento completo da Opção C (seção 4 = app Python,
  seção 5 = passo a passo Vercel, seção 3 = código da function).
- `Magic_Site/api/verify-license.js` — código-fonte da Serverless Function.

---

*Arquivo gerado pelo agente em `Magic_Site` — use como briefing no repositório `Magic Stat`.*
