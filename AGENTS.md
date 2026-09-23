# AGENTS.md — Regras do projeto (site Magic Stat)

Instruções para agentes de IA que forem editar este repositório. **Leia antes de mexer.**
O site é servido pelo **Vercel** (origem) atrás do **Cloudflare** (proxy + cache), no
domínio **https://getmagicstat.com/**.

---

## 🚨 Regra de ouro — nunca quebre o cache do Cloudflare

O Vercel tem apenas **100 GB de *Fast Data Transfer* grátis**. Se estourar, ele
**pausa o projeto inteiro** (o site sai do ar). O Cloudflare é o que segura esse
tráfego — mas só consegue cachear o que o Vercel serve com um tipo MIME "de arquivo".

1. **Todo arquivo em `assets/` DEVE ter extensão** (`.png`, `.jpg`, `.webp`, `.svg`, `.css`, `.js`…).
   **Nunca** suba um arquivo sem extensão (ex.: `circular05`).
   - Sem extensão → o Vercel responde `content-type: application/octet-stream` e
     `cache-control: max-age=0` → o Cloudflare **se recusa a cachear**
     (`cf-cache-status: DYNAMIC`) → **cada visita puxa o arquivo inteiro de volta do Vercel**.
   - **Essa foi a causa raiz dos 100 GB de tráfego que quase derrubaram o site.**
2. Toda `<img>` da galeria deve ter **`loading="lazy"`** e **`decoding="async"`**.
3. Ao renomear/adicionar um asset, **atualize as referências no `index.html`** e
   confirme que nenhum arquivo antigo/sem extensão ficou para trás.
4. **Não mexa** na Cache Rule do Cloudflare para `/assets/`
   (Cache Rules → Edge TTL + Browser TTL = 1 mês). Ela é o que mantém o custo baixo.
5. **Ao alterar `assets/css/style.css` ou `assets/js/*.js`, suba o `?v=N` na URL
   no `index.html`** (ex.: `style.css?v=2` → `style.css?v=3`).
   - O cache de 1 mês congela o arquivo **pela URL**; o HTML é dinâmico (aparece
     na hora), mas o CSS/JS com a mesma URL **não atualiza** e a mudança some.
   - Sintoma clássico: você edita o CSS, o HTML muda e o estilo continua o velho
     (ex.: um bloco novo aparece desalinhado à esquerda, sem estilo).
   - Arquivos **novos/renomeados** (ex.: imagem que ganhou `.png`) já têm URL nova,
     então não precisam disso.

### Como verificar (faça isso depois de mexer em assets)

```sh
curl -sI https://getmagicstat.com/assets/screenshots/circular02.png
# Esperado: content-type: image/png · cache-control: max-age=2678400 · cf-cache-status: HIT
```

Se aparecer `cf-cache-status: DYNAMIC` ou `content-type: application/octet-stream`,
o cache está quebrado — conserte antes de seguir.

---

## ✅ O que NÃO pode ser cacheado

- **`/` (HTML da home)** → deve continuar `DYNAMIC` / `must-revalidate`.
  O preço, a oferta e os textos mudam com frequência; cachear atrasa isso.
- **`/api/*`** → `no-store`. Nunca cachear (download, stats, licença).

---

## ⬇️ Downloads

- **Nunca bloqueie ninguém.** O download nunca retorna 403. Robôs, scanners de
  e-mail, acesso direto e links copiados **recebem o instalador** normalmente.
  (Exigência explícita do dono.)
- Quem entrega o binário é o **GitHub Releases**, não o site: `/api/download?file=X`
  só faz um `302`. **Isso não consome banda do Vercel.**
- A rota pergunta à API do GitHub qual é a **release mais nova que tenha o
  instalador daquele sistema** (macOS `.pkg`, Windows `.exe`, Linux `.AppImage`).
- Só mexa em `FALLBACK_VERSION` (em `api/download.js`) junto com um lançamento
  novo, usando os **nomes exatos** dos assets daquela release.

---

## 🧪 Antes de commitar

```sh
npm test        # tools/test_ccf.mjs · test_download.mjs · test_stats.mjs — precisa passar
```

---

## 🤝 Não desfaça sozinho (decisões do dono)

- **Preço, oferta e cupom** (Gumroad) são controlados pelo dono. Ele liga/desliga
  quando quer. **Nunca** altere preço, oferta, texto de promoção ou cupom por
  conta própria — só quando ele pedir explicitamente.
- **Vídeo "In action"** = embed do **YouTube** (`youtube-nocookie`, 1080p).
  **Não re-encode** o vídeo (perde definição) nem volte a hospedar o `.mp4` no repo.
- **Testemunhos** são reais (recebidos por e-mail), traduzidos e **sem nomes**.
- O trial é **48 h** para instalações novas (versões anteriores mantêm os 7 dias
  já prometidos). A duração é imposta **no app**, não no backend.
