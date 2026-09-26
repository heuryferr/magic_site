// api/app-open.js
// ======================================================================
// Magic Stat — O APP ABRIU (beacon de abertura).
// ----------------------------------------------------------------------
// Pedido do dono (2026-09-26): *"se o cara baixou e instalou, já na hora de
// abrir nós sabemos: um cara na Eslováquia, 19:45 local, acabou de ligar o
// trial e está testando o software"*.
//
// POR QUE ESTA ROTA EXISTE:
//   O unico ping antigo era o de INICIO DE TRIAL: UMA vez por MAQUINA e para
//   sempre. Com ele era impossivel responder "quantas pessoas estao usando o
//   app" — e o painel ficava comparando MILHARES de requisicoes (robo, scanner
//   de e-mail, prefetch; o /api/download conta todos por definicao) com uns
//   poucos trials. Esta rota conta CADA abertura, com o status REAL da licenca.
//
//   POST /api/app-open
//   {
//     "event": "app_open",
//     "install_id": "uuid-anonimo",
//     "platform": "linux|macos|windows",
//     "app_version": "4.5.1",
//     "status": "TRIAL|LICENSED|BLOCKED|TAMPERED",
//     "reason": "TRIAL_ACTIVE|TRIAL_EXPIRED|...",
//     "days_left": 2,
//     "first_open": "1|0"
//   }
//
// Respostas: 200 {success:true} | 400 payload invalido | 503 banco fora.
// Fonte: Postgres (Neon). SEM dados pessoais: sem email, sem IP, sem hardware —
// pais/estado/cidade sao COARSE (cabecalho do Vercel), como nas outras rotas.
// ======================================================================

import { registrarAbertura, registrarFeature } from "./_db.js";

const json = (res, status, body) => res.status(status).json(body);

function limpaTexto(valor, max = 60) {
  return String(valor || "")
    .replace(/[<>&"'`\\]/g, "")
    .trim()
    .slice(0, max);
}
function regiao(req) {
  return limpaTexto(req.headers["x-vercel-ip-country-region"], 8).toUpperCase();
}
function cidade(req) {
  const bruto = String(req.headers["x-vercel-ip-city"] || "");
  let c = bruto;
  try {
    c = decodeURIComponent(bruto);
  } catch (err) {
    /* '%' invalido: fica como veio */
  }
  return limpaTexto(c, 60);
}
function pais(req) {
  return (
    String(req.headers["x-vercel-ip-country"] || "??")
      .toUpperCase()
      .replace(/[^A-Z]/g, "")
      .slice(0, 2) || "??"
  );
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, {
      success: false,
      error: "method_not_allowed",
      message: "Use POST.",
    });
  }

  const {
    install_id,
    platform,
    app_version = "",
    os_release = "",
    status = "",
    reason = "",
    days_left = 0,
    first_open = "",
    event = "app_open",
    sessao = "",
    duracao_s = 0,
    aberto_s = 0,
    feature = "",
    detail = "",
  } = req.body ?? {};

  const validos = ["macos", "windows", "linux"];
  if (!install_id || typeof install_id !== "string" ||
      !validos.includes(platform)) {
    return json(res, 400, {
      success: false,
      error: "bad_request",
      message: "install_id (string) e platform (macos|windows|linux) sao obrigatorios.",
    });
  }

  // Recursos usados (dono, 26/09) vão para a tabela própria; abertura,
  // batida e fechamento seguem para app_opens. Mesma função, sem rota nova
  // (o plano limita 12 funções).
  if (feature) {
    const gravou = await registrarFeature({
      install_id, sessao, feature, detail, duracao_s, aberto_s,
      platform, app_version: String(app_version || '').slice(0, 20),
      cc: pais(req), region: regiao(req), city: cidade(req),
    });
    if (gravou === null) {
      return json(res, 503, {
        success: false,
        error: 'feature_registry_unavailable',
        message: 'Falha ao registrar o uso do recurso.',
      });
    }
    return json(res, 200, { success: true, registrado: gravou });
  }

  const registrado = await registrarAbertura({
    install_id,
    platform,
    app_version: String(app_version || "").slice(0, 20),
    os_release: String(os_release || "").slice(0, 40),
    status: String(status || "").slice(0, 20),
    reason: String(reason || "").slice(0, 30),
    days_left: Number(days_left) || 0,
    first_open: String(first_open || "") === "1",
    event: String(event || "app_open").slice(0, 20),
    sessao: String(sessao || "").slice(0, 40),
    duracao_s: Number(duracao_s) || 0,
    aberto_s: Number(aberto_s) || 0,
    cc: pais(req),
    region: regiao(req),
    city: cidade(req),
  });
  if (registrado === null) {
    return json(res, 503, {
      success: false,
      error: "open_registry_unavailable",
      message: "Falha ao registrar a abertura.",
    });
  }
  return json(res, 200, { success: true, registrado });
}
