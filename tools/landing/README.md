# Landing pages de método (SEO)

Gerador das páginas `/<slug>/` do `getmagicstat.com`.

## Por que existe

Preço, rodapé, CTA e navegação aparecem em **toda** página. Escritos à mão, a
primeira mudança de preço deixa 50 páginas mentindo (e o preço já mudou 5 vezes
em um único dia). Aqui o que é comum vive em `site.json`; o que muda por página
vive em `methods.json`.

## Como usar

```sh
python3 tools/landing/build_pages.py --check   # só valida
python3 tools/landing/build_pages.py           # gera <slug>/index.html + sitemap.xml + robots.txt
```

Depois: `git add -A && git commit && git push` (o Vercel publica).

## Mudar o preço (um lugar só)

`site.json` → `"price_usd": "990"`. Rode o gerador: as 51 páginas passam a
mostrar o valor novo, e o JSON-LD também.

## Adicionar uma página de método

Acrescente um objeto em `methods.json` com o schema das entradas existentes.
Campos obrigatórios: `slug`, `eyebrow`, `h1`, `seo_title`, `meta` (≤ 160 chars),
`hero_sub`, `intro`, `gives`, `faq`. Opcionais: `how`, `options`, `output`,
`related`, `shot`.

## Screenshots

As imagens vão em `assets/img/shots/<slug>.png` e são referenciadas no campo
`shot` da página:

```json
"shot": {
  "src": "/assets/img/shots/nmds.png",
  "alt": "NMDS ordination output in Magic Stat",
  "caption": "The ordination, its stress value and the settings used — in one window."
}
```

O validador **quebra o build** se a imagem não existir ou vier sem extensão.

### ⚠️ Regra de ouro (AGENTS.md)

**Todo arquivo em `assets/` precisa de extensão** (`.png`, `.jpg`, `.webp`…).
Sem extensão o Vercel responde `application/octet-stream` e o Cloudflare se
recusa a cachear (`cf-cache-status: DYNAMIC`) — cada visita puxa o arquivo
inteiro de volta do Vercel. Foi o que estourou os 100 GB de tráfego. Toda
`<img>` usa `loading="lazy"` e `decoding="async"`.

## Regra de conteúdo (anti "doorway page")

Página com o molde e só o nome do método trocado é **doorway page**: o Google
trata como spam e pode derrubar o domínio inteiro. Cada página precisa de
conteúdo próprio e específico — o que o método é, quando é e quando não é a
ferramenta certa, as opções reais, a saída e o FAQ.

Tom: direto, honesto, técnico. **Sem hype** ("best", "powerful", "revolutionary",
"seamless"). Se para algum caso o R, JASP ou jamovi for a resposta melhor, a
página diz isso — é justamente isso que faz o pesquisador confiar.

**Nunca afirme recurso que não existe.** A fonte de verdade é o código do app em
`/home/heury/Da nuvem magic/Magic-Stat/`. Quem escreve uma página verifica lá
antes; na dúvida, omite.
