/* assets/js/track.js
   ====================================================================
   Magic Stat — atribuição da campanha + contador de visitas.

   O que faz (uma vez, ao carregar a página):
     1. lê os parâmetros da campanha da URL (os e-mails do Magic Stat Mail
        mandam `utm_content=<conta>`);
     2. repassa esses parâmetros — e também a PÁGINA e o REFERRER — para os
        links de download (`/api/download?...`), para o contador saber de onde
        veio cada clique e cada visita;
     3. repassa a campanha para o link do Gumroad (aparece no `referrer` da
        venda, atribuindo a venda à conta de envio);
     4. envia um "beacon" para `/api/visit`, que soma a VISITA por dia, por
        país (header do Vercel), por conta, navegador, origem e página.

   Por que o referrer vai na mão: numa requisição de beacon/fetch o header
   `Referer` é a PRÓPRIA página, não de onde a pessoa veio — então lemos
   `document.referrer` aqui e mandamos explicitamente.

   Regras: nunca atrapalha o site (tudo em try/catch), não roda em localhost,
   e não guarda nada no navegador do visitante.
   ==================================================================== */
(function () {
  "use strict";

  try {
    var host = location.hostname || "";
    if (location.protocol !== "https:" || host === "localhost" ||
        host === "127.0.0.1" || host === "") {
      return; // desenvolvimento local: não conta
    }

    // 1) o que a campanha trouxe na URL
    var KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content",
                "utm_term", "gclid"];
    var entrada = new URLSearchParams(location.search);
    var params = new URLSearchParams();
    KEYS.forEach(function (k) {
      var v = entrada.get(k);
      if (v) params.set(k, String(v).slice(0, 80));
    });

    // 2) página + de onde a pessoa veio (o beacon não sabe sozinho)
    params.set("p", (location.pathname || "/").slice(0, 60));
    try {
      if (document.referrer) {
        var de = new URL(document.referrer).hostname;
        if (de && de !== host) params.set("ref", String(de).slice(0, 60));
      }
    } catch (e) { /* referrer estranho: ignora */ }

    var qs = params.toString();

    // 3) leva a atribuição para os botões (download e Gumroad)
    if (qs) {
      document.querySelectorAll('a[href^="/api/download"]').forEach(function (a) {
        try {
          var u = new URL(a.getAttribute("href"), location.origin);
          params.forEach(function (v, k) { u.searchParams.set(k, v); });
          a.setAttribute("href", u.pathname + "?" + u.searchParams.toString());
        } catch (e) { /* link intacto */ }
      });
      var soCampanha = new URLSearchParams();
      KEYS.forEach(function (k) {
        var v = params.get(k);
        if (v) soCampanha.set(k, v);
      });
      if (soCampanha.toString()) {
        document.querySelectorAll('a[href*="gumroad.com"]').forEach(function (a) {
          try {
            var u2 = new URL(a.href);
            soCampanha.forEach(function (v, k) { u2.searchParams.set(k, v); });
            a.href = u2.toString();
          } catch (e) { /* link intacto */ }
        });
      }
    }

    // 4) conta a visita (sempre, com ou sem campanha)
    var beacon = "/api/visit" + (qs ? "?" + qs : "");
    if (navigator.sendBeacon) {
      navigator.sendBeacon(beacon);
    } else if (window.fetch) {
      fetch(beacon, { keepalive: true, cache: "no-store" })["catch"](function () {});
    }
  } catch (err) {
    /* silêncio: estatística nunca pode quebrar a página */
  }
})();
