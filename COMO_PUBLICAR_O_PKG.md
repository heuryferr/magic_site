# 📦 Como publicar o instalador do Magic Stat (.pkg)

> Guia simples, para consultar no dia do lançamento.

---

## 🧠 Entenda as versões primeiro (importante!)

**Seu primeiro lançamento é o `1.0.1`.** Não precisa mudar número nenhum.

| Onde a versão aparece | Valor no 1º lançamento |
|---|---|
| No app — `Magic-Stat/utils/app_meta.py` → `APP_VERSION` | `"1.0.1"` |
| Tag do Release no GitHub | `v1.0.1` |
| Nome do arquivo | `MagicStat-1.0.1.pkg` |
| Manifesto — `updates/manifest.json` → `latest_version` | `"1.0.1"` |

### ⚠️ De onde veio o "1.0.2"?

Do **teste** que fizemos: colocamos um manifesto anunciando `1.0.2` mas o pkg
anexado era o `1.0.1`. Resultado: o app dizia *"tem 1.0.2!"*, baixava o `1.0.1`,
reabria ainda como `1.0.1` e avisava de novo → **loop infinito**.
Já corrigimos (o manifesto está em `1.0.1`). **Lição:** o `latest_version` do
manifesto **sempre** tem que bater com o pkg que ele aponta.

### Quando usar `1.0.2`, `1.1.0`…?

Só quando você **mudar o app de verdade**. Aí sim:
1. Bump em `app_meta.py` (`APP_VERSION = "1.0.2"`)
2. Gera o `MagicStat-1.0.2.pkg`
3. Publica um Release novo (tag `v1.0.2`)
4. Atualiza o manifesto → o app passa a oferecer a atualização sozinho ✅

---

## 📍 Onde o .pkg vai?

**Não é em pasta do repositório!** Ele vai **anexado a um "Release"**
(seção separada do GitHub, feita para arquivos grandes).

O único arquivo do repositório que você edita é o **manifesto**:

```
MagicStat-Releases/
└── updates/
    └── manifest.json   ← só este arquivo
```

> ⚠️ **Não** suba o `.pkg` como arquivo comum no repositório: ele tem ~380 MB e
> o GitHub rejeita arquivos acima de 100 MB. Release é o lugar certo (sem limite).

---

## 🚀 Passo a passo (dia do lançamento)

1. No Mac, gere o instalador **`MagicStat-1.0.1.pkg`**
2. Abra → **https://github.com/heuryferr/MagicStat-Releases/releases**
3. Clique em **"Draft a new release"**
4. Preencha:
   - **Choose a tag** → `v1.0.1` → *Create new tag*
   - **Release title** → `Magic Stat 1.0.1`
5. **Arraste o `MagicStat-1.0.1.pkg`** para a caixa *"Attach binaries…"*
   👉 **é aqui que o pkg entra**, não em pasta
6. Clique em **"Publish release"** ✅

O link de download será:

```
https://github.com/heuryferr/MagicStat-Releases/releases/download/v1.0.1/MagicStat-1.0.1.pkg
```

### 🔁 E se o pkg `v1.0.1` de lá for um build antigo de teste?

Não precisa criar release novo: abra o Release `v1.0.1` → **Edit** →
apague o asset antigo e **arraste o novo com o mesmo nome**.
A URL continua idêntica e nada mais precisa mudar. 👍

---

## 🔄 Depois de publicar, ajuste 2 coisas

### 1) O manifesto — `updates/manifest.json`

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

> 💡 Pode me pedir: **"publica o 1.0.1"** que eu preencho a URL, o `sha256` e o
> tamanho certos automaticamente.

### 2) O site — `api/download.js`

Confirme a URL do macOS (é o que o contador usa):

```js
const FILES = {
  macos: "https://github.com/heuryferr/MagicStat-Releases/releases/download/v1.0.1/MagicStat-1.0.1.pkg",
};
```

No dia do lançamento, ligue no Vercel: **`DOWNLOAD_ENABLED=1`**

---

## 🤖 O que acontece DEPOIS (o ciclo da atualização)

Quando existir um Release **mais novo** que a versão instalada, o app:

1. avisa que há atualização (só com licença válida)
2. baixa o .pkg + confere o `sha256`
3. pede a senha de administrador do macOS e instala
4. mostra: *"Magic Stat foi atualizado! O app vai fechar e reabrir com a nova
   versão em alguns segundos. Não se preocupe — é automático."*
5. fecha e reabre **já atualizado** (sem loop, porque a versão nova == manifesto)

---

## ✅ Checklist final

- [ ] `APP_VERSION` no `app_meta.py` = versão que você está lançando (`1.0.1`)
- [ ] `.pkg` gerado no Mac
- [ ] Release `v1.0.1` no GitHub com o **pkg anexado**
- [ ] `updates/manifest.json` → `latest_version` + `url` + `sha256` + `size_bytes`
- [ ] `api/download.js` → mesma URL do pkg
- [ ] Vercel → `DOWNLOAD_ENABLED=1`
- [ ] Botões do site apontando para `/api/download?file=macos`

---

## 📊 Bônus: acompanhar os downloads

Depois de lançar, veja a contabilidade (cliques do site + downloads reais do GitHub):

```
https://statmagic.vercel.app/api/stats?token=SEU_TOKEN&format=html
```
