// api/update-notice.js
// ======================================================================
// Magic Stat — o app MOSTROU o aviso de atualização (beacon anônimo).
// ----------------------------------------------------------------------
// Pedido do dono (2026-09-23): *"O app não conta quando mostra o aviso ...
// SO QUERO QUE O APP GRAVE ISSO"*. Antes, a única medida era o DOWNLOAD — o
// efeito, não a EXPOSIÇÃO: não dava para saber quantas pessoas viram a
// mensagem.
//
//   POST /api/update-notice
//   {
//     "install_id":      "uuid-aletorio",    // NÃO identifica a pessoa
//     "platform":        "linux",            // macos | windows | linux
//     "app_version":     "4.0.0",            // de onde o cliente veio
//     "offered_version": "4.5.1",            // o alvo do aviso
//     "notice_kind":     "available"         // available | required
//   }
//
// Respostas:
//   200 { success:true }                       — contado
//   200 { success:true, duplicate:true }       — mesma instalação já contada
//                                                para ESTA versão oferecida
//   400 { success:false, error:"bad_request" } — payload inválido
//   503 { success:false, error:"notice_registry_unavailable" } — banco fora
//   500 { success:false, error:"server_error" }— falha inesperada
//
// Armazenamento: POSTGRES (Neon), tabela `update_notices` — o MESMO banco das
// contagens do site (o Redis ficou reservado à licença). O dedupe é o índice
// ÚNICO em (install_id, offered_version): a mesma instalação conta UMA vez por
// versão oferecida — é isso que impede a insistência de ~15 min de inflar o
// número.
//
// Leitura: GET /api/update-notice-stats?token=STATS_TOKEN
//
// SEM dados pessoais: sem email, sem IP, sem hardware_id, sem conteúdo.
// ======================================================================

import { registrarAviso } from "./_db.js";

const json = (res, status, body) => res.status(status).json(body);

const VALID_PLATFORMS = ["macos", "windows", "linux"];

// Versão em formato de chave segura: só [0-9A-Za-z._-], até 32 chars. Sem isso,
// uma "offered_version" esquisita viraria linha nova no banco a cada chamada.
function versaoSegura(v) {
  return String(v ?? "")
    .trim()
    .replace(/[^0-9A-Za-z._-]/g, "")
    .slice(0, 32);
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
    offered_version = "",
    notice_kind = "available",
  } = req.body ?? {};

  if (
    !install_id ||
    typeof install_id !== "string" ||
    !VALID_PLATFORMS.includes(platform)
  ) {
    return json(res, 400, {
      success: false,
      error: "bad_request",
      message:
        "install_id (string) e platform (macos|windows|linux) são obrigatórios.",
    });
  }

  const offered = versaoSegura(offered_version);
  if (!offered) {
    return json(res, 400, {
      success: false,
      error: "bad_request",
      message: "offered_version é obrigatório (a versão que o aviso anunciava).",
    });
  }

  const resultado = await registrarAviso({
    install_id,
    offered_version: offered,
    from_version: versaoSegura(app_version),
    platform,
    kind: versaoSegura(notice_kind) || "available",
  });

  if (resultado === null) {
    // Sem banco configurado (ou falha): declarado como indisponível. O app
    // ignora em silêncio — analytics NUNCA aparece para o usuário.
    return json(res, 503, {
      success: false,
      error: "notice_registry_unavailable",
      reason: "registry_error",
      message: "Falha ao acessar o registro de avisos.",
    });
  }
  if (resultado === "duplicado") {
    return json(res, 200, { success: true, duplicate: true });
  }
  return json(res, 200, { success: true });
}
