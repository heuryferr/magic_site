// tools/test_privacidade_dataset.mjs
// ======================================================================
// Prova que do ARQUIVO DO CLIENTE só entra o FORMATO (nunca o nome).
// ----------------------------------------------------------------------
// Dono (2026-09-26): *"o nome do arquivo nao precisamos saber, so o formato da
// base mesmo"*. Como o app 4.5.3 ainda manda o nome, a limpeza vive no SERVIDOR
// (vale retroativo, sem build). Este teste injeta um pool de mentira
// (`_usarPool`) e cobra o que foi para o INSERT de `feature_events`:
//
//   1. `dataset:meu_relatorio.csv`  (detail=file) -> `dataset:csv`
//   2. `dataset:pacientes_HIV.xlsx` (detail=file) -> `dataset:xlsx`
//   3. nome SEM extensão            (detail=file) -> `dataset:arquivo`
//   4. o que JÁ é formato           (detail=file) -> fica igual (idempotente)
//   5. EXEMPLO do catálogo          (detail=example) -> mantém o nome (é nosso)
//   6. qualquer outra feature (janela:/analise:/ia:) -> intacta
//
// Rodar:  node tools/test_privacidade_dataset.mjs   (sai 1 se algo falhar)
// ======================================================================

let OK = 0, FAIL = 0;
function check(desc, cond, extra = "") {
  if (cond) { OK++; console.log("  OK    " + desc); }
  else { FAIL++; console.log("  FALHOU " + desc + " " + extra); }
}

// ── Pool de mentira: só guarda o que seria inserido ───────────────────
const inseridos = [];
const poolFalso = {
  async query(sql, params) {
    if (String(sql).includes("INSERT INTO feature_events")) {
      inseridos.push(params);
      return { rowCount: 1, rows: [] };
    }
    return { rows: [], rowCount: 0 };   // ALTERs / UPDATE retroativo / SELECTs
  },
};

const { _usarPool, registrarFeature } = await import("../api/_db.js");
_usarPool(poolFalso);

async function grava(feature, detail) {
  inseridos.length = 0;
  await registrarFeature({
    install_id: "iid-teste", sessao: "s1", feature, detail,
    duracao_s: 0, aberto_s: 0, platform: "linux", app_version: "4.5.3",
  });
  return inseridos.length ? inseridos[0][2] : null;   // params[2] = feature
}

console.log("== 1. arquivo do cliente: só o FORMATO ==");
check("relatorio.csv -> dataset:csv",
      (await grava("dataset:meu_relatorio.csv", "file")) === "dataset:csv");
check("pacientes_HIV.xlsx -> dataset:xlsx",
      (await grava("dataset:pacientes_HIV.xlsx", "file")) === "dataset:xlsx");
check("nome sem extensao -> dataset:arquivo",
      (await grava("dataset:planilha_secreta", "file")) === "dataset:arquivo");
check("o nome NUNCA aparece (nem HIV, nem relatorio)",
      !/hiv|pacientes/i.test(String(await grava("dataset:pacientes_HIV.xlsx", "file"))));

console.log("\n== 2. idempotencia e exemplos ==");
check("o que ja e formato fica igual (idempotente)",
      (await grava("dataset:xlsx", "file")) === "dataset:xlsx");
check("EXEMPLO do catalogo mantem o nome (e nosso, nao do cliente)",
      (await grava("dataset:5 Medical Groups", "example")) === "dataset:5 Medical Groups");
check("exemplo com ponto no nome nao e mexido",
      (await grava("dataset:Survival 2.0", "example")) === "dataset:Survival 2.0");

console.log("\n== 3. nada mais e tocado ==");
for (const f of ["janela:BoxPlotDialog", "analise:means_comparison",
                 "ia:deepseek", "report"]) {
  check(f + " passa intacta", (await grava(f, "")) === f);
}

console.log("\nOK: " + OK + " | FAIL: " + FAIL);
process.exit(FAIL ? 1 : 0);
