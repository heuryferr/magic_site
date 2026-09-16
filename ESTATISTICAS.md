# Estatísticas do site (contador próprio)

Contamos tudo no **Upstash Redis** (sem serviço externo, sem custo extra) e
lemos por um endpoint protegido: `/api/stats?token=STATS_TOKEN`.

## Como funciona

| Rota | O que faz |
| --- | --- |
| `GET /api/visit` | Conta a **visita à página** (o `assets/js/track.js` chama ao carregar). |
| `GET /api/download?file=macos` | Conta o **clique no botão de download** e redireciona para o instalador. Só conta clique que sai da nossa página (track.js grava `?p`/`?ref`/`?utm_*`, ou o Referer aponta para nós); `file` é obrigatório; o mesmo visitante pedindo 2+ sistemas em 30 min é tratado como robô. O que é bloqueado vai para `downloads:bot:*` e recebe **403** (não redireciona — o GitHub não infla). |
| `GET /api/stats?token=…&days=30` | Devolve o relatório em **JSON** (ou `&format=html` para ler no navegador). |

O `track.js` também repassa os parâmetros de campanha da URL
(`utm_source`, `utm_content`…) para os links de download e do Gumroad — assim
sabemos **de qual conta de envio** veio cada visita, clique e venda.

## Atribuição (de onde veio)

* **País** — header `x-vercel-ip-country` (o Vercel entrega em qualquer plano).
* **Conta** — `utm_content` do link. Os e-mails do Magic Stat Mail mandam
  `utm_content=<conta de envio>` (ex.: `heuryferr@gmail.com`).
* **Dispositivo/robô** — robôs claros (scanner, monitor, curl) não contam como
  visita: vão para `visits:bots:{dia}` e aparecem separados no relatório.
* **Navegador/SO** — derivado do user-agent (`macOS/Safari 17`, `Windows/Chrome
  126`, `HeadlessChrome`…). É o desempate entre **pessoa** e **robô com cara de
  navegador**.
* **Origem (referrer)** — de qual site a pessoa veio (`(sem referrer)` quando
  abre direto). Vai na mão do `track.js`, porque numa requisição de beacon o
  header `Referer` seria a própria página.
* **Página** — em qual página do site ela estava.
* **País × conta** — a leitura combinada: responde "as visitas da Holanda
  vieram do nosso e-mail ou foram diretas?".
* **País × sistema do clique** — `downloads:ccf:{cc}:{file}:{dia}`: o **país
  de cada clique** no botão (`US|macos`). O GitHub conta o download, mas **não
  diz quem nem de onde** baixou — quem dá país ao download é o clique. O
  `/api/stats` devolve `clicks_ccf` (soma da janela) e `clicks_ccf_dias`
  (`[{day, name:"US|macos", count}]`, um por dia, para o painel poder somar
  qualquer período).

  > Atenção: isto é o **clique no botão**, não o download concluído (quem clica
  > e desiste conta aqui e não conta no GitHub).

## Chaves no Redis

```
downloads:{macos|windows|linux}:{dia}      cliques por dia
downloads:{plataforma}:total               cliques acumulados
downloads:uniq:{plataforma}:{dia}          visitantes únicos (hash IP+UA, 120d)
downloads:cc:{cc}:{dia} / downloads:cc:{cc}          cliques por país / acumulado
downloads:utm:{conta}:{dia} / downloads:utm:{conta}  cliques por conta / acumulado
downloads:ccs:{dia} / downloads:utms:{dia}           índices do dia (400d)
downloads:ccf:{cc}:{file}:{dia}                      cliques por país × sistema
downloads:bot:{file}:{dia} / downloads:bot:{file}     cliques BLOQUEADOS
                                                       (robô óbvio, sem página,
                                                        multi-OS) — 403, não conta
downloads:ccfs:{dia}                                 índice do dia ("CC|file")

visits:{dia} / visits:total                visitas por dia / acumuladas
visits:uniq:{dia}                          visitantes únicos do dia (120d)
visits:bots:{dia}                          requisições de robô (ignoradas)
visits:cc:{cc}:{dia} / visits:cc:{cc}                visitas por país / acumulado
visits:utm:{conta}:{dia} / visits:utm:{conta}        visitas por conta / acumulado
visits:ccs:{dia} / visits:utms:{dia}                 índices do dia (400d)

visits:x:{dia}          HASH  dimensões extras do dia, campo por valor:
                              ua:<SO/navegador>   ref:<site de origem>
                              path:<página>       ccut:<país>|<conta>
downloads:x:{dia}       HASH  as mesmas 4 dimensões, para os cliques
                              (um hash por dia = 1 comando para gravar e 1
                               para ler tudo; expira em 400 dias)
```

## Privacidade

Nunca guardamos o IP nem nada no navegador do visitante. O que existe é um
**hash irreversível** de `IP + user-agent` (com sal, via `DOWNLOAD_IP_SALT`)
usado só para contar visitantes distintos, e apenas dentro de SETs com
expiração de 120 dias.

## Variáveis de ambiente

Nenhuma nova. Continua valendo o que já estava:

| Variável | Para quê |
| --- | --- |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | o banco do contador (já configurados) |
| `STATS_TOKEN` | segredo exigido por `/api/stats` |
| `DOWNLOAD_IP_SALT` *(opcional)* | sal do hash de visitante |
| `GITHUB_TOKEN` *(opcional)* | aumenta o limite da API do GitHub no relatório |
