# 📦 Onde colocar o .pkg quando estiver pronto?

## Resposta curta

**O `.pkg` NÃO vai em nenhuma pasta do repositório.** Ele vai **anexado a um
"Release"** (uma seção separada do GitHub, feita para arquivos grandes).

O único arquivo que você edita no repositório é o **manifesto de atualização**
(que já existe):

```
MagicStat-Releases/
└── updates/
    └── manifest.json   ← só este arquivo você edita
```

---

## 🚀 Passo a passo (quando o .pkg estiver pronto)

1. No seu Mac, gere o instalador: **`MagicStat-1.0.2.pkg`**
   (lembre de subir a versão: `utils/app_meta.py` → `APP_VERSION = "1.0.2"`)

2. Vá em → **https://github.com/heuryferr/MagicStat-Releases/releases**

3. Clique em **"Draft a new release"**

4. Preencha:
   - **Choose a tag** → digite `v1.0.2` → *Create new tag*
   - **Release title** → `Magic Stat 1.0.2`

5. **Arraste o arquivo `MagicStat-1.0.2.pkg`** para a caixa
   *"Attach binaries…"* (é aqui que o pkg entra! Não é em pasta.)

6. Clique em **"Publish release"** ✅

Pronto! O link de download dele passa a ser:

```
https://github.com/heuryferr/MagicStat-Releases/releases/download/v1.0.2/MagicStat-1.0.2.pkg
```

---

## 🔄 Depois de publicar, atualize 2 coisas

### 1) O manifesto de atualização — `updates/manifest.json`

```json
{
  "latest_version": "1.0.2",
  "installer": {
    "url": "https://github.com/heuryferr/MagicStat-Releases/releases/download/v1.0.2/MagicStat-1.0.2.pkg",
    "sha256": "...",
    "size_bytes": 123456789
  }
}
```

> 💡 Pode me pedir: **"publica o 1.0.2"** que eu preencho o manifesto com a URL,
> o `sha256` e o tamanho certos automaticamente.

### 2) O site — `api/download.js`

Troque a URL do macOS:

```js
const FILES = {
  macos: "https://github.com/heuryferr/MagicStat-Releases/releases/download/v1.0.2/MagicStat-1.0.2.pkg",
};
```

E (só no dia do lançamento) ligue no Vercel: **`DOWNLOAD_ENABLED=1`**

---

## ✅ Checklist rápido

- [ ] `APP_VERSION` atualizado no código antes de buildar
- [ ] `.pkg` gerado no Mac
- [ ] Release criado com a tag `v1.0.2` + pkg **anexado**
- [ ] `updates/manifest.json` atualizado (versão + URL + sha256 + tamanho)
- [ ] `api/download.js` → URL nova
- [ ] Vercel → `DOWNLOAD_ENABLED=1`

> ⚠️ **Não coloque o `.pkg` como arquivo comum no repositório** — ele tem
> ~380 MB e o GitHub rejeita arquivos acima de 100 MB. Release (passo 5) é o
> lugar certo e não tem esse limite.
