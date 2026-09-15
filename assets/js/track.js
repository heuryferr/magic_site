/* assets/js/track.js
   ====================================================================
   Magic Stat — atribuição da campanha + contador de visitas.

   O que faz (uma vez, ao carregar a página):
     1. lê os parâmetros da campanha da URL (os e-mails do Magic Stat Mail
        mandam `utm_content=<conta>`);
     2. repassa esses parâmetros para os links de download
        (`/api/download?...`) — assim o contador grava o clique POR CONTA;
     3. repassa também para o link do Gumroad (aparece no `referrer` da venda);
     4. envia um "beacon" para `/api/visit`, que soma a VISITA por dia,
        por país (header do Vercel) e por conta.

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
    var qs = params.toString();

    // 2) e 3) leva a atribuição para os botões (download e Gumroad)
    if (qs) {
      document.querySelectorAll('a[href^="/api/download"]').forEach(function (a) {
        try {
          var u = new URL(a.getAttribute("href"), location.origin);
          params.forEach(function (v, k) { u.searchParams.set(k, v); });
          a.setAttribute("href", u.pathname + "?" + u.searchParams.toString());
        } catch (e) { /* link intacto */ }
      });
      document.querySelectorAll('a[href*="gumroad.com"]').forEach(function (a) {
        try {
          var u2 = new URL(a.href);
          params.forEach(function (v, k) { u2.searchParams.set(k, v); });
          a.href = u2.toString();
        } catch (e) { /* link intacto */ }
      });
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
