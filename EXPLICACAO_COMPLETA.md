# 🧙 TUDO EXPLICADO — A "Trava de 2 Máquinas" do Magic Stat (em português simples)

> **Para quem?** Para você mesmo, que acompanhou tudo meio no susto (eu + Gemini fizemos as
> coisas) e quer **finalmente entender** o que aconteceu. Nada de jargão. Zero obrigação de
> saber programar. Só uma conversa clara, do começo ao fim.

---

## 🍔 Primeiro: a grande ideia, com uma analogia de lanchonete

Imagine que o seu **programa Magic Stat** é um **cliente** que toda vez que abre precisa
mostrar a chave na portaria para provar que "comprou de verdade".

Antes, imagine que o cliente **ia direto na cozinha do Gumroad** (a empresa que vende seu
software) perguntar: *"essa chave aí é boa?"*. E o Gumroad respondia "sim/não".

O problema: **isso não tem limite de vezes**. Uma pessoa comprava UMA chave e usava em 100
computadores diferentes — porque cada computador só precisava comprovar a chave, e o Gumroad
só sabia dizer "é válida", não "já está sendo usada em outro lugar".

Nós queríamos: **uma chave vale para no máximo 2 computadores**. Como fazer? Montamos uma
**portaria nossa** no meio do caminho:

```
Computador → [NOSSO SEGURANÇA (backend na Vercel)] → pergunta pro Gumroad: "chave é boa?"
                                                          ↓
                                             "é boa!" (e guarda: "já usei nesse PC")
                                          + anota QUAIS 2 computadores já usaram
```

O "nosso segurança" faz 2 coisas:
1. **Pergunta ao Gumroad** se a chave é válida de verdade (a parte que já existia).
2. **Controla o limite de 2 computadores** (a parte NOVA que a gente criou).

É só isso. Vamos detalhar cada pedaço agora.

---

## 🔤 Glossário (as palavras que você ouviu, sem susto)

| Palavra | O que é, em simples |
|---------|---------------------|
| **Frontend** | A parte que o usuário VÊ (a tela). No seu caso, o programa Python que abre no PC, e o site `index.html`. |
| **Backend** | A parte que NÃO aparece, fica num servidor, faz o trabalho "pesado" por trás. É onde mora o nosso segurança. |
| **Servidor** | Um computador que fica ligado o tempo todo rodando programas "por trás" (não é seu PC). |
| **Serverless / Function** | Uma "mini-função" que roda só quando alguém chama, num servidor alugado. Você não gerencia o servidor — ele aparece e some na hora. |
| **API / Endpoint / Rota** | Um "endereço na internet" que um programa usa para pedir/fazer algo. Ex.: `https://.../api/verify-license` é o endereço do nosso segurança. |
| **Vercel** | Empresa grátis/iniciante que hospeda essas mini-funções. É onde nosso segurança mora. |
| **Upstash Redis** | Um "caderninho de anotações" guardado na nuvem. É onde anotamos *quais* computadores já usaram a chave. |
| **Gumroad** | A loja onde você vende o Magic Stat. É o "dono oficial" das chaves. |
| **Chave / license_key / key** | A "senha da compra" que o cliente digita no programa. |
| **hardware_id** | Uma "impressão digital" do computador (número que identifica aquele PC). |
| **product_id** | Um identificador do seu produto no Gumroad. |
| **env vars / variáveis de ambiente** | Segredos/configurações (tipo senha do token) guardados fora do código, no painel da Vercel, pra não vazar. |
| **package.json** | Uma "lista de compras" do projeto Node: o que precisa estar instalado. |
| **npm i <pacote>** | Comando que instala o pacote e anota ele na lista. |
| **commit / push** | Salvar a mudança ("commit") e mandar para o GitHub ("push"). |

---

## 🖇️ Os 4 "personagens" e como se conectam

```
              ┌────────────────────────────┐
              │   VERCEL (nosso segurança)  │
              │  /api/verify-license        │
              └───┬────────────────────┬────┘
                  │                    │
        pergunta se a      anota quais computadores
        chave é boa        já usaram
                  │                    │
         ┌────────▼────┐      ┌────────▼─────────┐
         │   GUMROAD   │      │  UPSTASH REDIS   │
         │ (loja/chave)│      │ (caderninho da   │
         └─────────────┘      │  nuvem)          │
                              └──────────────────┘
```

- O **programa Python** manda pra Vercel: `chave + impressão digital do PC`.
- A **Vercel** pergunta ao **Gumroad**: "essa chave é válida para o produto do heury?"
- A Vercel **anota no Upstash Redis**: "o PC com essa impressão digital já usou essa chave".
- Se já tiver **2 PCs anotados** e chegar um 3º diferente → Vercel nega (HTTP 403).

---

## 📦 MAS PRIMEIRO: importante entender onde fica cada coisa

Existem **DOIS lugares** diferentes no seu projeto, e uma das confusões foi essa:

1. **`Magic_Site`** — é o **site de divulgação** (página `index.html`) + os arquivos de
   apoio. É ONDE ESTAMOS TRABALHANDO AGORA. Fica no GitHub como `heuryferr/magic_site`.
2. **`Magic Stat`** (outro repositório/pasta, `/Users/heury/Magic-Stat`) — é o **programa
   Python** que roda no PC do usuário.

> ⚡ A "trava" é feita no **backend** (item que fica na Vercel). Esse backend foi criado
> **dentro do repositório `Magic_Site`**, porque a gente decidiu que a Vercel vai hospedar o
> site E a função juntos (era o "Cenário A").

---

## 🗺️ PASSO A PASSO — o que foi feito, na ordem

### PASSO 1 — Entender o objetivo (a regra de negócio)

Queríamos que **uma licença valesse para no máximo 2 computadores**. Essa regra recebeu o
apelido de **"Opção C"** e "trava de 2 máquinas".

### PASSO 2 — Desenhar a arquitetura

Decidimos que **o programa NÃO pode mais falar direto com o Gumroad**. Ele passa a falar com
**nosso "segurança" (backend na Vercel)**, que tem o token do Gumroad guardado em segredo e
faz a validação + o controle do limite. Isso é mais seguro (o token nunca vai pro PC do
usuário) e é o que permite limitar a 2 máquinas.

### PASSO 3 — Criar o arquivo do backend

Foi criado o arquivo **`api/verify-license.js`**. É um "mini-programa" que:

- **Recebe** (via um POST, tipo um formulário JSON): a `license_key` e o `hardware_id`.
- **Pergunta ao Gumroad** se a chave é válida (com o token secreto).
  - Se **reembolsada** ou **chargeback** → remove o registro e avisa.
  - Se **inválida** → devolve erro `invalid_license`.
- **Se válida**, vai ao **Upstash Redis** e: se o PC ainda não está anotado e ainda cabe
  (menos de 2), **anota**; se já está anotado, **renova**; se já tem **2** e é um 3º PC
  diferente → **nega** com erro `device_limit`.
- **Devolve** uma resposta dizendo "ok" + quantos PCs já usaram.

### PASSO 4 — Declarar a "dependência" (a tal do `@upstash/redis`)

Esse arquivo usa uma **biblioteca pronta** chamada `@upstash/redis` (é o "motor" que fala
com o caderninho Upstash Redis). Precisávamos instalar ela e declarar no `package.json`
(nossa "lista de compras").

- Rodamos: `npm init -y` (cria a lista `package.json`) e `npm i @upstash/redis` (instala o
  motor e adiciona na lista).
- Resultado no `package.json`:
  ```json
  "dependencies": {
    "@upstash/redis": "^1.38.3"
  }
  ```

> 👉 **Resumo da sua dúvida antiga:** "adicionar na lista de dependências" NÃO é digitar
> algo na mão. É rodar `npm i @upstash/redis` — o próprio comando adiciona sozinho.

### PASSO 5 — Publicar no GitHub (commit + push)

Com os arquivos prontos, fizemos o **commit** (salvamos uma "foto" da mudança) e o **push**
(mandamos pro GitHub `heuryferr/magic_site`). Isso deixa tudo salvo na nuvem.

⚠️ **Detalhe importante que fizemos:** adicionamos `node_modules/` ao `.gitignore`, senão
subiria uma pasta gigante de dependências desnecessária.

### PASSO 6 — Conectar na Vercel (manual, no painel)

Para o nosso segurança funcionar na internet, o repositório `magic_site` foi **importado na
Vercel**. A cada `push`, a Vercel **faz deploy automático** (publica a versão nova).

### PASSO 7 — Configurar as "chaves de ambiente" (env vars) na Vercel

O arquivo `api/verify-license.js` lê **segredos** do ambiente:

- `GUMROAD_ACCESS_TOKEN` — a senha/token da sua conta Gumroad (para ela saber que é você).
- `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN` — endereço e senha do caderninho
  Upstash Redis.

Esses valores NÃO ficam no código (por segurança); ficam digitados no painel da Vercel →
Settings → Environment Variables.

> 👉 **Resumo da sua dúvida sobre "chaves de ambiente":** é só um "armário de segredos" que
> a Vercel injeta no programa quando ele roda. Você digita lá no painel, uma única vez.

### PASSO 8 — ⚔️ O momento em que "quebrou" a validação (e como resolvemos)

Quando testamos o curl, veio um erro dizendo que faltava o **`product_id`** e que o valor
certo era **`rrU3Ea0rVRwxQQoOlEDQbw==`**.

**O que estava acontecendo:** o código enviava o campo errado (`product_permalink` com o
valor `hjjfhq`). O Gumroad quer **`product_id`** com o valor **`rrU3Ea0rVRwxQQoOlEDQbw==`**
(um identificador interno, diferente do "slug" da URL `hjjfhq`).

**A correção:** mudamos o arquivo para enviar:
```js
form.append("product_id", "rrU3Ea0rVRwxQQoOlEDQbw==");
```

**Deu certo!** 🎉 O teste retornou:
```json
{
  "success": true,
  "device_count": 1,
  "device_limit": 2,
  "purchase": { "product_name": "Magic Stat", "email": "heuryferr@gmail.com", ... }
}
```
Ou seja: chave válida, 1º dispositivo registrado, e o limite de 2 configurado.

> 👉 A lição: **não precisou de nova venda**. Uma chave real não "envelhece" — o que estava
> errado era o código, não a chave.

### PASSO 9 — ⏳ O que AINDA falta: ligar o programa Python

O **backend já está pronto e funciona**. Mas o **programa Python** (o que o usuário abre no
PC) ainda não foi alterado para falar com a nossa rota. Hoje ele deve estar falando direto
com o Gumroad (ou nem passando pela trava).

**O que falta fazer** (no repositório `Magic Stat`, em `utils/licensing.py`):
1. Trocar a constante de URL para apontar para o nosso segurança:
   `https://statmagic.vercel.app/api/verify-license`.
2. Enviar no payload o `hardware_id` (a impressão digital do PC).
3. Usar um "método novo" (`_post_verify`) que chama a nossa rota em vez do Gumroad direto.
4. Tratar o erro `device_limit` (quando vier o 3º PC) com mensagem amigável:
   > "Esta licença já está ativada em 2 dispositivos. Para usar numa nova máquina, encerre o
   > uso em um dos dispositivos atuais ou entre em contato com o suporte."
5. Adicionar a constante de erro `LICENSE_DEVICE_LIMIT`.

Esses detalhes estão **documentados** no arquivo `FALTANDO.md` (que você pode abrir no
repositório do programa) e na seção 4 do `ATIVACAO_VERCEL.md`.

---

## 📝 CONFERÊNCIA — o que o backend faz com precisão (se quiser o detalhe técnico)

As regras implementadas na `api/verify-license.js`:

| Regra | Comportamento |
|-------|---------------|
| Máximo de 2 `hardware_id` por chave | `DEVICE_LIMIT = 2` |
| 1º ou 2º PC | Registra (anota no Redis) e autoriza ✅ |
| PC já registrado | Autoriza sem duplicar ✅ |
| 3º PC diferente | Nega com HTTP 403 `device_limit` ❌ |
| Reembolso / chargeback | Remove o registro da chave e avisa |
| Chave inválida | Devolve `invalid_license` |
| TTL | O registro de PC "expira" em ~370 dias (renovado a cada uso) — alinhado com a licença anual |

---

## 🧩 Resumo "fala baixinho" (o que você precisa LEMBRAR)

1. Você tem **duas coisas**: o **site** (`magic_site`) e o **programa Python** (`Magic Stat`).
2. A **trava de 2 máquinas** funciona pelo **backend** colocado na Vercel, que é o nosso
   segurança: ele valida a chave no Gumroad E controla o limite de 2 PCs no Upstash Redis.
3. O backend **já está pronto, publicado e TESTADO** (deu `success: true`). 🎉
4. Falta apenas **adaptar o programa Python** para mandar a chave + `hardware_id` para essa
   rota (detalhes no `FALTANDO.md`).
5. **Nada disso vai quebrar** seu site normal — o site continua servido igual, a API é só um
   "endereço a mais".

---

## 🗂️ Onde está cada arquivo (mapa rápido)

| Arquivo | O que é | Status |
|---------|---------|--------|
| `api/verify-license.js` | O "segurança" (backend). É o coração da trava. | ✅ Pronto e no GitHub |
| `package.json` | A lista de compras do projeto (tem o motor `@upstash/redis`). | ✅ Pronto |
| `.gitignore` | Diz ao git para não subir `node_modules/`. | ✅ Corrigido |
| `ATIVACAO_VERCEL.md` | Documento técnico completo da ativação na Vercel. | ✅ Existe |
| `FALTANDO.md` | Checklist do que falta (especialmente o programa Python). | ✅ Existe, serve de briefing |
| `utils/licensing.py` (no repo do programa) | Código do app Python que precisa ser adaptado. | ⏳ Ainda falta |

---

## 🚀 Próximo passo óbvio (te ofereço ajuda)

O passo natural agora é **adaptar o `utils/licensing.py`** no repositório `Magic Stat`.
Como eu já expliquei, o fluxo que você escolheu foi: entrar lá, ligar o agente e mostrar o
`FALTANDO.md`. Te sugiro seguir esse caminho — e se quiser, antes disso eu dou uma revisada
no `FALTANDO.md` para deixá-lo ainda mais claro, já que agora sabemos o `product_id`
correto e que o backend passou no teste.

---

*Escrito para você entender 100% do que aconteceu — sem depender de mim/Gemini para repetir tudo de novo.* 💙
