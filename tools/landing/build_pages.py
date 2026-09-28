#!/usr/bin/env python3
"""build_pages.py — gerador das landing pages de método do Magic Stat.

POR QUE UM GERADOR (e não 50 arquivos na mão):
  o preço, o rodapé, o CTA e a navegação aparecem em TODA página. Escritos à
  mão, a primeira mudança de preço deixa 50 páginas mentindo. Aqui o que é
  comum vive em `site.json`; o que muda por página vive em `methods.json`.

USO:
    python3 tools/landing/build_pages.py            # gera tudo
    python3 tools/landing/build_pages.py --check    # só valida (não escreve)

SAÍDA:
    <slug>/index.html      (uma pasta por método)
    sitemap.xml
    robots.txt

REGRA DE CONTEÚDO (anti "doorway page"): cada página precisa de conteúdo
PRÓPRIO — o que é o método, quando usar, opções, saída, FAQ. Template com o
nome trocado o Google trata como spam e pode derrubar o domínio inteiro.
"""
from __future__ import annotations

import argparse
import html
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
HERE = Path(__file__).resolve().parent

# Páginas que já existem e NÃO são geradas por este script (ficam no sitemap).
PAGINAS_PREEXISTENTES = ["/spss-alternative/", "/apa-tables-word/"]

OBRIGATORIOS = ["slug", "eyebrow", "h1", "seo_title", "meta", "hero_sub",
                "intro", "gives", "faq"]


def esc(v: str) -> str:
    """Escapa para uso em ATRIBUTO de HTML (title=, content=)."""
    return html.escape(str(v), quote=True)


def carrega_site() -> dict:
    return json.loads((HERE / "site.json").read_text(encoding="utf-8"))


def carrega_metodos() -> list[dict]:
    data = json.loads((HERE / "methods.json").read_text(encoding="utf-8"))
    return data["methods"]


# --------------------------------------------------------------------------
# Blocos
# --------------------------------------------------------------------------

def head(site: dict, m: dict) -> str:
    url = f"{site['domain']}/{m['slug']}/"
    ld_soft = {
        "@context": "https://schema.org", "@type": "SoftwareApplication",
        "name": site["brand"], "applicationCategory": "EducationalApplication",
        "operatingSystem": "Windows, macOS, Linux",
        "url": site["domain"] + "/",
        "description": site["brand"] + " — statistical analysis with "
                       "publication-ready figures and APA tables, no code.",
        "offers": {"@type": "Offer", "price": site["price_usd"],
                   "priceCurrency": "USD"},
    }
    ld_faq = None
    if m.get("faq"):
        ld_faq = {
            "@context": "https://schema.org", "@type": "FAQPage",
            "mainEntity": [
                {"@type": "Question", "name": q["q"],
                 "acceptedAnswer": {"@type": "Answer", "text": q["a"]}}
                for q in m["faq"]
            ],
        }
    ld_bc = {
        "@context": "https://schema.org", "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": site["brand"],
             "item": site["domain"] + "/"},
            {"@type": "ListItem", "position": 2, "name": m["eyebrow"],
             "item": url},
        ],
    }
    blocos = [ld_soft, ld_bc] + ([ld_faq] if ld_faq else [])
    scripts = "\n".join(
        '<script type="application/ld+json">'
        + json.dumps(b, ensure_ascii=False) + "</script>" for b in blocos)

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{esc(m['seo_title'])}</title>
<meta name="description" content="{esc(m['meta'])}">
<link rel="canonical" href="{url}">
<meta property="og:type" content="article">
<meta property="og:title" content="{esc(m.get('og_title') or m['seo_title'])}">
<meta property="og:description" content="{esc(m.get('og_desc') or m['meta'])}">
<meta property="og:url" content="{url}">
<link rel="icon" type="image/png" href="/assets/img/favicon.png">
<link rel="stylesheet" href="{site['style_css']}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<script>window.va = window.va || function () {{ (window.vaq = window.vaq || []).push(arguments); }};</script>
<script defer src="/_vercel/insights/script.js"></script>
{scripts}
</head>
<body>
{navbar(site)}
<header class="hero" id="home">
  <div class="hero-inner container">
    <span class="eyebrow">{m['eyebrow']}</span>
    <h1 class="hero-title">{m['h1']}</h1>
    <p class="hero-sub">{m['hero_sub']}</p>
    <div class="hero-actions">
      <a href="{site['buy_url']}" class="btn btn-primary">Buy now</a>
      <a href="{site['downloads']['windows']}" class="btn btn-ghost">Download for Windows</a>
      <a href="{site['downloads']['macos']}" class="btn btn-ghost">Download for macOS</a>
      <a href="{site['downloads']['linux']}" class="btn btn-ghost">Download for Linux</a>
    </div>
  </div>
</header>
"""


def navbar(site: dict) -> str:
    links = "\n".join(
        f'      <li><a href="{href}">{txt}</a></li>' for txt, href in site["nav"])
    return f"""<nav class="navbar" id="navbar">
  <div class="nav-inner container">
    <a href="/" class="brand">
      <img src="/assets/img/logo.png" alt="{site['brand']}" class="brand-logo">
      <span class="brand-name">Magic&nbsp;Stat</span>
    </a>
    <ul class="nav-links" id="navLinks">
{links}
    </ul>
    <a href="{site['buy_url']}" class="btn btn-primary btn-sm nav-cta">Buy now</a>
  </div>
</nav>
"""


def bloco(sec: dict | None, alt: bool = False) -> str:
    """Uma seção de conteúdo: eyebrow + título + corpo."""
    if not sec:
        return ""
    cls = "section section-alt" if alt else "section"
    sid = f' id="{sec["id"]}"' if sec.get("id") else ""
    out = [f'<section class="{cls}"{sid}>',
           '  <div class="section-head container">',
           f'    <span class="eyebrow">{sec.get("eyebrow","")}</span>',
           f'    <h2 class="section-title">{sec.get("title","")}</h2>',
           '  </div>',
           '  <div class="container">']
    for p in sec.get("paras", []):
        out.append(f'    <p>{p}</p>')
    if sec.get("bullets"):
        out.append("    <ul>")
        for b in sec["bullets"]:
            out.append(f'      <li>{b}</li>')
        out.append("    </ul>")
    if sec.get("steps"):
        out.append("    <ol>")
        for s in sec["steps"]:
            out.append(f'      <li><strong>{s["t"]}.</strong> {s["d"]}</li>')
        out.append("    </ol>")
    out += ["  </div>", "</section>", ""]
    return "\n".join(out)


def captura(m: dict) -> str:
    """Screenshot opcional: {"src", "alt", "caption"}. Sem shot, nada sai."""
    s = m.get("shot")
    if not s:
        return ""
    legenda = f'<p class="container" style="text-align:center;color:#a6aed6;">{s["caption"]}</p>' if s.get("caption") else ""
    return (
        '<section class="section" id="shot">\n'
        '  <div class="section-head container">\n'
        '    <span class="eyebrow">In the software</span>\n'
        '  </div>\n'
        '  <div class="container" style="text-align:center;">\n'
        f'    <img src="{s["src"]}" alt="{esc(s["alt"])}" '
        'loading="lazy" decoding="async" style="max-width:100%;height:auto;'
        'border:1px solid rgba(255,255,255,.08);border-radius:10px;">\n'
        f'  </div>\n{legenda}\n</section>\n')


def faq(site: dict, m: dict) -> str:
    if not m.get("faq"):
        return ""
    out = ['<section class="section section-alt" id="faq">',
           '  <div class="section-head container">',
           '    <span class="eyebrow">Frequently asked</span>',
           f'    <h2 class="section-title">{m.get("faq_title","Questions")}</h2>',
           '  </div>', '  <div class="container">']
    for q in m["faq"]:
        out.append(f'    <h3>{q["q"]}</h3>')
        out.append(f'    <p>{q["a"]}</p>')
    out += ['  </div>', '</section>', '']
    return "\n".join(out)


def relacionados(m: dict, todos: dict[str, dict]) -> str:
    if not m.get("related"):
        return ""
    itens = []
    for slug in m["related"]:
        alvo = todos.get(slug)
        if alvo:
            itens.append(f'<a href="/{slug}/" class="btn btn-ghost">'
                         f'{alvo["eyebrow"]} &rarr;</a>')
    if not itens:
        return ""
    return ('<p class="container" style="text-align:center;margin:0 auto 48px;">'
            + "\n  ".join(itens) + "</p>\n")


def rodape(site: dict) -> str:
    links = "\n".join(f'      <a href="{href}">{txt}</a>'
                      for txt, href in site["footer_links"])
    return f"""<footer class="footer">
  <div class="footer-inner container">
    <div class="footer-brand">
      <img src="/assets/img/logo.png" alt="{site['brand']}" class="brand-logo">
      <span class="brand-name">Magic&nbsp;Stat</span>
    </div>
    <p class="footer-note">The statistical suite for macOS, Windows and Linux &mdash; publication-quality analysis with built-in intelligence.</p>
    <div class="footer-links">
{links}
    </div>
    <p class="footer-copy">Contact: <a href="mailto:{site['contact']}">{site['contact']}</a></p>
  </div>
</footer>
<script src="{site['track_js']}"></script>
</body>
</html>
"""


def pagina(site: dict, m: dict, todos: dict[str, dict]) -> str:
    partes = [head(site, m),
              bloco(m["intro"]),
              captura(m),
              bloco(m["gives"], alt=True),
              bloco(m.get("how")),
              bloco(m.get("options"), alt=True),
              bloco(m.get("output")),
              faq(site, m),
              relacionados(m, todos),
              rodape(site)]
    return "\n".join(p for p in partes if p)


def valida(metodos: list[dict]) -> list[str]:
    erros = []
    vistos = set()
    for i, m in enumerate(metodos):
        nome = m.get("slug") or f"#{i}"
        for campo in OBRIGATORIOS:
            if not m.get(campo):
                erros.append(f"[{nome}] falta o campo obrigatório '{campo}'")
        if m.get("slug") in vistos:
            erros.append(f"[{nome}] slug duplicado")
        vistos.add(m.get("slug"))
        if len(str(m.get("meta", ""))) > 165:
            erros.append(f"[{nome}] meta description com "
                         f"{len(m['meta'])} chars (ideal <= 160)")
        for outro in m.get("related", []):
            if outro not in {x.get("slug") for x in metodos} \
                    and f"/{outro}/" not in PAGINAS_PREEXISTENTES:
                erros.append(f"[{nome}] related aponta para '{outro}', "
                             f"que não existe")
        shot = m.get("shot")
        if shot:
            if not shot.get("src") or not shot.get("alt"):
                erros.append(f"[{nome}] shot precisa de 'src' e 'alt'")
            else:
                caminho = ROOT / str(shot["src"]).lstrip("/")
                if not caminho.exists():
                    erros.append(f"[{nome}] shot não existe no repo: "
                                 f"{shot['src']}")
                elif not str(shot["src"]).lower().endswith(
                        (".png", ".jpg", ".jpeg", ".webp")):
                    erros.append(f"[{nome}] shot SEM EXTENSÃO de imagem "
                                 f"(: {shot['src']}) — o Cloudflare recusa "
                                 f"cachear (ver AGENTS.md)")
    return erros


def sitemap(site: dict, metodos: list[dict]) -> str:
    urls = [site["domain"] + "/"] + \
           [site["domain"] + p for p in PAGINAS_PREEXISTENTES] + \
           [f"{site['domain']}/{m['slug']}/" for m in metodos]
    linhas = "\n".join(f"  <url><loc>{u}</loc></url>" for u in urls)
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
            f"{linhas}\n</urlset>\n")


def robots(site: dict) -> str:
    return ("User-agent: *\nAllow: /\n\n"
            f"Sitemap: {site['domain']}/sitemap.xml\n")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="só valida; não escreve arquivos")
    args = ap.parse_args()

    site = carrega_site()
    metodos = carrega_metodos()
    erros = valida(metodos)
    if erros:
        print("ERROS DE VALIDAÇÃO:")
        for e in erros:
            print("  -", e)
        return 1

    todos = {m["slug"]: m for m in metodos}
    print(f"{len(metodos)} páginas válidas.")
    if args.check:
        return 0

    for m in metodos:
        destino = ROOT / m["slug"]
        destino.mkdir(exist_ok=True)
        (destino / "index.html").write_text(pagina(site, m, todos),
                                            encoding="utf-8")
        print(f"  escrito: {m['slug']}/index.html")

    (ROOT / "sitemap.xml").write_text(sitemap(site, metodos), encoding="utf-8")
    (ROOT / "robots.txt").write_text(robots(site), encoding="utf-8")
    print("  escrito: sitemap.xml")
    print("  escrito: robots.txt")
    return 0


if __name__ == "__main__":
    sys.exit(main())
