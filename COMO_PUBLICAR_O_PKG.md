# 📦 Onde colocar o .pkg quando estiver pronto?

> ℹ️ **Primeiro lançamento = `1.0.1`** — já é a versão que o app reporta e a
> tag que já existe. **Não precisa bumpar nada** para lançar.
> Nos exemplos abaixo usei `1.0.2` só para ilustrar a *próxima* atualização
> (quando você mudar o app de novo).

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

1. No seu Mac, gere o instalador: **`MagicStat-1.0.1.pkg`**
   (é a versão atual — só mude o número em `utils/app_meta.py` quando lançar
   uma versão NOVA de verdade)

2. Vá em → **https://github.com/heuryferr/MagicStat-Releases/releases**

3. Clique em **"Draft a new release"** — se o `v1.0.1` já existir, use ele e
   apenas **substitua o arquivo** (arrastar outro com o mesmo nome por cima)

4. Preencha:
   - **Choose a tag** → `v1.0.1` → *Create new tag* (ou reaproveite a existente)
   - **Release title** → `Magic Stat 1.0.1`

5. **Arraste o arquivo `MagicStat-1.0.1.pkg`** para a caixa
   *"Attach binaries…"* (é aqui que o pkg entra! Não é em pasta.)

6. Clique em **"Publish release"** ✅

Pronto! O link de download dele passa a ser:

```
https://github.com/heuryferr/MagicStat-Releases/releases/download/v1.0.1/MagicStat-1.0.1.pkg
```

---

## 🔄 Depois de publicar, atualize 2 coisas

### 1) O manifesto de atualização — `updates/manifest.json`

```json
{
  "latest_version": "1.0.1",
  "installer": {
    "url": "https://github.com/heuryferr/MagicStat-Releases/releases/download/v1.0.1/MagicStat-1.0.1.pkg",
    "sha256": "...",
    "size_bytes": 123456789
  }
}
```

> 💡 Pode me pedir: **"publica o 1.0.1"** que eu preencho o manifesto com a URL,
> o `sha256` e o tamanho certos automaticamente.

### 2) O site — `api/download.js`

Confirme a URL do macOS:

```js
const FILES = {
  macos: "https://github.com/heuryferr/MagicStat-Releases/releases/download/v1.0.1/MagicStat-1.0.1.pkg",
};
```

E (só no dia do lançamento) ligue no Vercel: **`DOWNLOAD_ENABLED=1`**

---

## ✅ Checklist rápido

- [ ] `APP_VERSION` confere com o nome do pkg (primeiro lançamento: `1.0.1`)
- [ ] `.pkg` gerado no Mac
- [ ] Release `v1.0.1` com o pkg **anexado** (ou asset substituído)
- [ ] `updates/manifest.json` atualizado (versão + URL + sha256 + tamanho)
- [ ] `api/download.js` → URL correta
- [ ] Vercel → `DOWNLOAD_ENABLED=1`

> ⚠️ **Não coloque o `.pkg` como arquivo comum no repositório** — ele tem
> ~380 MB e o GitHub rejeita arquivos acima de 100 MB. Release (passo 5) é o
> lugar certo e não tem esse limite.
