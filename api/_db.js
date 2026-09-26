// ======================================================================
// Postgres (Neon) — o "caderninho" do SITE: LOG de cliques + agregados.
// ----------------------------------------------------------------------
// Substitui o Redis nas contagens de DOWNLOAD e VISITA (o Redis ficou
// RESERVADO para a licença: 2 máquinas por chave).
//
// O Vercel é serverless (não tem disco), por isso os dados moram aqui.
// Best-effort TOTAL: se o banco faltar ou falhar, NADA quebra — o download
// redireciona igual e as leituras devolvem "sem dados".
//
// Configuração: variável DATABASE_URL na Vercel (connection string do Neon,
// modo "pooled"). As tabelas são criadas/ajustadas sozinhas no primeiro uso.
// ======================================================================

//: Fuso usado para definir o "dia" (o mesmo -180 = UTC-3 do site antigo).
const TZ_MIN = 180;
const DIA = `to_char((ts - interval '${TZ_MIN} minutes')::date, 'YYYY-MM-DD')`;

let _pool = null;
let _schemaOk = false;

async function getPool() {
  if (_pool) return _pool;
  const url = process.env.DATABASE_URL
    || process.env.POSTGRES_URL
    || process.env.NEON_DATABASE_URL
    || "";
  if (!url) return null;
  try {
    const { default: pg } = await import("pg");
    _pool = new pg.Pool({
      connectionString: url.replace(/[?&]channel_binding=[^&]*/g, ""),
      ssl: { rejectUnauthorized: false },
      max: 1,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 8000,
    });
  } catch (err) {
    console.error("pg indisponivel:", err?.message ?? err);
    return null;
  }
  return _pool;
}

// Gancho de teste: injeta um pool falso (o real vem da DATABASE_URL).
export function _usarPool(p) {
  _pool = p;
  _schemaOk = true;
}

async function ensureSchema(db) {
  if (_schemaOk) return;
  // CLIQUE no botão de download (1 linha por clique).
  await db.query(`CREATE TABLE IF NOT EXISTS clicks (
    id bigserial PRIMARY KEY,
    ts timestamptz NOT NULL DEFAULT now(),
    file text NOT NULL,
    cc text, region text, city text, ua text, conta text, ref text,
    path text, uhash text)`);
  // As duas colunas novas (a tabela já existia antes delas).
  await db.query("ALTER TABLE clicks ADD COLUMN IF NOT EXISTS path text");
  await db.query("ALTER TABLE clicks ADD COLUMN IF NOT EXISTS uhash text");
  await db.query("CREATE INDEX IF NOT EXISTS clicks_ts_idx ON clicks (ts DESC)");
  // VISITA à página (beacon do /api/visit) — 1 linha por carregamento.
  await db.query(`CREATE TABLE IF NOT EXISTS visits (
    id bigserial PRIMARY KEY,
    ts timestamptz NOT NULL DEFAULT now(),
    cc text, region text, city text, ua text, conta text, ref text,
    path text, uhash text)`);
  await db.query("ALTER TABLE visits ADD COLUMN IF NOT EXISTS path text");
  await db.query("ALTER TABLE visits ADD COLUMN IF NOT EXISTS uhash text");
  await db.query("CREATE INDEX IF NOT EXISTS visits_ts_idx ON visits (ts DESC)");
  // TRIALS (beacon /api/trial-start): 1 linha por INSTALACAO (o indice unico
  // em install_id e o dedupe — a mesma instalacao conta uma vez).
  await db.query(`CREATE TABLE IF NOT EXISTS trials (
    id bigserial PRIMARY KEY,
    ts timestamptz NOT NULL DEFAULT now(),
    install_id text NOT NULL, platform text)`);
  await db.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS trials_install_idx ON trials (install_id)");
  // Geolocalizacao COARSE da instalacao, dos cabecalhos do Vercel
  // (pais/estado/cidade). Pedido do dono (2026-09-23): "se puder dizer
  // mais: sistema operacional, pais cidade". SEM IP e sem nada que
  // identifique a pessoa — e a mesma coisa que as tabelas clicks/visits
  // ja guardam.
  await db.query("ALTER TABLE trials ADD COLUMN IF NOT EXISTS cc text");
  await db.query("ALTER TABLE trials ADD COLUMN IF NOT EXISTS region text");
  await db.query("ALTER TABLE trials ADD COLUMN IF NOT EXISTS city text");
  // VENDAS/licencas ativadas (registro do verify-license).
  await db.query(`CREATE TABLE IF NOT EXISTS sales (
    id bigserial PRIMARY KEY,
    ts timestamptz NOT NULL DEFAULT now(),
    license_key text, platform text, country text, email text)`);
  await db.query("CREATE INDEX IF NOT EXISTS sales_ts_idx ON sales (ts DESC)");
  // AVISO DE ATUALIZACAO MOSTRADO (beacon /api/update-notice): 1 linha por
  // (INSTALACAO, VERSAO OFERECIDA). O indice unico e o dedupe: a insistencia
  // de ~15 min do dialogo nao infla o numero.
  await db.query(`CREATE TABLE IF NOT EXISTS update_notices (
    id bigserial PRIMARY KEY,
    ts timestamptz NOT NULL DEFAULT now(),
    install_id text NOT NULL,
    offered_version text NOT NULL,
    from_version text, platform text, kind text)`);
  await db.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS update_notices_unique_idx ON update_notices (install_id, offered_version)");
  await db.query("CREATE INDEX IF NOT EXISTS update_notices_ts_idx ON update_notices (ts DESC)");
  // ABERTURAS DO APP (beacon /api/app-open): cada abertura e uma
  // linha. O numero de INSTALACOES ativas e count(distinct
  // install_id) — por isso aberturas e instalacoes sao contadas
  // separado (abrir 5x no dia = 1 instalacao ativa, 5 aberturas).
  await db.query(`CREATE TABLE IF NOT EXISTS app_opens (
    id bigserial PRIMARY KEY,
    ts timestamptz NOT NULL DEFAULT now(),
    install_id text NOT NULL, platform text, app_version text,
    os_release text, status text, reason text, days_left int,
    first_open boolean DEFAULT false, cc text, region text,
    city text)`);
  await db.query("CREATE INDEX IF NOT EXISTS app_opens_ts_idx ON app_opens (ts DESC)");
  await db.query("CREATE INDEX IF NOT EXISTS app_opens_install_idx ON app_opens (install_id)");
  _schemaOk = true;
}

// ── Gravação (chamada pelos handlers; nunca lança) ────────────────────
async function _insere(tabela, dados) {
  try {
    const db = await getPool();
    if (!db) return false;
    await ensureSchema(db);
    // A tabela `visits` NÃO tem a coluna `file` (só o clique tem) — por isso a
    // lista de colunas é montada por tabela.
    const colunas = ["cc", "region", "city", "ua", "conta", "ref", "path",
                     "uhash"];
    const valores = [dados.cc || "", dados.region || "", dados.city || "",
                     dados.ua || "", dados.conta || "", dados.ref || "",
                     dados.path || "/", dados.uhash || ""];
    if (tabela === "clicks") {
      colunas.push("file");
      valores.push(dados.file || "");
    }
    const marcadores = colunas.map((_c, i) => `$${i + 1}`).join(",");
    await db.query(
      `INSERT INTO ${tabela} (${colunas.join(",")}) VALUES (${marcadores})`,
      valores);
    return true;
  } catch (err) {
    console.error(`${tabela} insert error:`, err?.message ?? err);
    return false;
  }
}

export function registrarClique(dados) { return _insere("clicks", dados); }
export function registrarVisita(dados) { return _insere("visits", dados); }

// Trial: devolve "novo", "duplicado" ou null (sem banco / falha).
export async function registrarTrial(dados) {
  try {
    const db = await getPool();
    if (!db) return null;
    await ensureSchema(db);
    const r = await db.query(
      `INSERT INTO trials (install_id, platform, cc, region, city)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (install_id) DO NOTHING`,
      [dados.install_id || "", dados.platform || "",
       dados.cc || "", dados.region || "", dados.city || ""]);
    return r.rowCount > 0 ? "novo" : "duplicado";
  } catch (err) {
    console.error("trial insert error:", err?.message ?? err);
    return null;
  }
}

// Venda / licenca ativada. Best-effort (nunca lanca).
export async function registrarVenda(dados) {
  try {
    const db = await getPool();
    if (!db) return false;
    await ensureSchema(db);
    await db.query(
      `INSERT INTO sales (license_key, platform, country, email)
       VALUES ($1,$2,$3,$4)`,
      [dados.license_key || "", dados.platform || "", dados.country || "??",
       dados.email || ""]);
    return true;
  } catch (err) {
    console.error("sale insert error:", err?.message ?? err);
    return false;
  }
}

// ── Leitura: LOG das últimas requisições (mesmo formato do Redis antigo) ─
export async function ultimosCliques(n = 500) {
  try {
    const db = await getPool();
    if (!db) return null;
    await ensureSchema(db);
    const { rows } = await db.query(
      `SELECT ts, file, cc, region, city, ua, conta, ref
         FROM clicks ORDER BY ts DESC, id DESC LIMIT $1`, [n]);
    return rows.map((r) => ({
      t: new Date(r.ts).toISOString(),
      f: r.file || "",
      cc: r.cc || "",
      rg: r.region || "",
      ct: r.city || "",
      ua: r.ua || "",
      conta: r.conta || "",
      ref: r.ref || "",
    }));
  } catch (err) {
    console.error("clicks select error:", err?.message ?? err);
    return null;
  }
}

// ── Leitura: AGREGADOS (a mesma forma que o app já sabia consumir) ─────
// Devolve {clicks:{rows}, visits:{rows}, origin:{...}} — assim o app troca a
// fonte sem mudar a lógica de gravação dele.
export async function agregados(days = 30) {
  const db = await getPool();
  if (!db) return null;
  await ensureSchema(db);
  const n = Math.max(1, Math.min(365, Number(days) || 30));
  const janela = `${n} days`;

  const q = (sql) => db.query(sql, [janela]).then((r) => r.rows);

  // 1) cliques por dia (total, únicos, por sistema)
  const clk = await q(
    `SELECT ${DIA} AS dia, count(*) AS total,
            count(DISTINCT uhash) AS uniq,
            count(*) FILTER (WHERE file='macos') AS macos,
            count(*) FILTER (WHERE file='windows') AS windows,
            count(*) FILTER (WHERE file='linux') AS linux
       FROM clicks WHERE ts >= now() - ($1)::interval
      GROUP BY 1 ORDER BY 1`);
  // 2) multi-sistema por dia (mesmo visitante pedindo mais de um sistema)
  const multi = await q(
    `SELECT dia, count(*) AS n FROM (
       SELECT ${DIA} AS dia, uhash FROM clicks
        WHERE ts >= now() - ($1)::interval AND uhash <> ''
        GROUP BY 1,2 HAVING count(DISTINCT file) > 1) x
      GROUP BY 1 ORDER BY 1`);
  // 3) visitas por dia
  const vis = await q(
    `SELECT ${DIA} AS dia, count(*) AS views, count(DISTINCT uhash) AS uniq
       FROM visits WHERE ts >= now() - ($1)::interval
      GROUP BY 1 ORDER BY 1`);
  // 4) país × sistema por dia (é o que a aba Países usa)
  const ccf = await q(
    `SELECT dia, name, count(*) AS n FROM (
       SELECT ${DIA} AS dia, cc || '|' || file AS name FROM clicks
        WHERE ts >= now() - ($1)::interval AND cc <> '') x
      GROUP BY 1,2 ORDER BY 1,3 DESC`);

  // 5) dimensões (janela inteira) — país, conta, navegador, origem, página
  const dims = (tabela, coluna, limit = 60) =>
    q(`SELECT ${coluna} AS name, count(*) AS n FROM ${tabela}
        WHERE ts >= now() - ($1)::interval AND ${coluna} <> ''
        GROUP BY 1 ORDER BY 2 DESC LIMIT ${limit}`);
  const ccut = (tabela) =>
    q(`SELECT cc || '|' || conta AS name, count(*) AS n FROM ${tabela}
        WHERE ts >= now() - ($1)::interval AND cc <> '' AND conta <> ''
        GROUP BY 1 ORDER BY 2 DESC LIMIT 60`);

  const [
    clkCc, clkUtm, clkUa, clkRef, clkPath, clkCcut,
    visCc, visUtm, visUa, visRef, visPath, visCcut,
  ] = await Promise.all([
    dims("clicks", "cc"), dims("clicks", "conta"), dims("clicks", "ua"),
    dims("clicks", "ref"), dims("clicks", "path"), ccut("clicks"),
    dims("visits", "cc"), dims("visits", "conta"), dims("visits", "ua"),
    dims("visits", "ref"), dims("visits", "path"), ccut("visits"),
  ]);

  const num = (v) => Number(v || 0);
  const porDia = (rows, campo) =>
    Object.fromEntries(rows.map((r) => [String(r.dia).slice(0, 10), num(r[campo])]));

  const multiDia = porDia(multi, "n");
  const clkRows = clk.map((r) => {
    const date = String(r.dia).slice(0, 10);
    return {
      date,
      total: num(r.total),
      unique: num(r.uniq),
      macos: num(r.macos),
      windows: num(r.windows),
      linux: num(r.linux),
      bots: 0,
      people: num(r.uniq),
      multi: multiDia[date] || 0,
    };
  });
  const visRows = vis.map((r) => ({
    date: String(r.dia).slice(0, 10),
    views: num(r.views),
    unique: num(r.uniq),
    bots: 0,
  }));

  const lista = (rows) => rows.map((r) => ({ name: r.name, count: num(r.n) }));

  // 6) TRIALS iniciados e VENDAS/licencas ativadas (o fim do funil).
  const tri = await q(
    `SELECT ${DIA} AS dia, count(*) AS total,
            count(*) FILTER (WHERE platform='macos') AS macos,
            count(*) FILTER (WHERE platform='windows') AS windows,
            count(*) FILTER (WHERE platform='linux') AS linux
       FROM trials WHERE ts >= now() - ($1)::interval
      GROUP BY 1 ORDER BY 1`);
  const trialsRows = tri.map((r) => ({
    date: String(r.dia).slice(0, 10), total: num(r.total), macos: num(r.macos),
    windows: num(r.windows), linux: num(r.linux),
  }));
  const trialsTotais = { total: 0, macos: 0, windows: 0, linux: 0 };
  trialsRows.forEach((r) => {
    trialsTotais.total += r.total;
    trialsTotais.macos += r.macos;
    trialsTotais.windows += r.windows;
    trialsTotais.linux += r.linux;
  });
  // VENDAS: licencas DISTINTAS (a mesma chave revalidando nao e venda nova),
  // atribuidas ao dia em que apareceram pela primeira vez.
  const vdia = await q(
    `SELECT dia, count(*) AS sales FROM (
       SELECT license_key, min(${DIA}) AS dia FROM sales
        WHERE ts >= now() - ($1)::interval AND license_key <> ''
        GROUP BY license_key) x
      GROUP BY 1 ORDER BY 1`);
  const vplat = await q(
    `SELECT platform AS name, count(DISTINCT license_key) AS n FROM sales
      WHERE ts >= now() - ($1)::interval AND license_key <> ''
      GROUP BY 1 ORDER BY 2 DESC LIMIT 20`);
  const vpais = await q(
    `SELECT country AS name, count(DISTINCT license_key) AS n FROM sales
      WHERE ts >= now() - ($1)::interval AND license_key <> ''
      GROUP BY 1 ORDER BY 2 DESC LIMIT 20`);
  const vendasRows = vdia.map((r) => ({
    date: String(r.dia).slice(0, 10), sales: num(r.sales),
  }));
  const vendasTotal = vendasRows.reduce((a, r) => a + r.sales, 0);

  return {
    clicks: { rows: clkRows },
    visits: { rows: visRows },
    trials: { ok: true, window_days: n, rows: trialsRows,
              totals: trialsTotais },
    sales: { ok: true, window_days: n, rows: vendasRows, total: vendasTotal,
             by_platform: lista(vplat), by_country: lista(vpais) },
    origin: {
      ok: true,
      clicks_country: lista(clkCc),
      clicks_utm: lista(clkUtm),
      clicks_ua: lista(clkUa),
      clicks_ref: lista(clkRef),
      clicks_path: lista(clkPath),
      clicks_ccut: lista(clkCcut),
      clicks_ccf: [],
      clicks_ccf_dias: ccf.map((r) => ({
        day: String(r.dia).slice(0, 10), name: r.name, count: num(r.n),
      })),
      visits_country: lista(visCc),
      visits_utm: lista(visUtm),
      visits_ua: lista(visUa),
      visits_ref: lista(visRef),
      visits_path: lista(visPath),
      visits_ccut: lista(visCcut),
    },
  };
}

// ── Aviso de atualizacao MOSTRADO (beacon /api/update-notice) ──────────
// Devolve "novo", "duplicado" ou null (sem banco / falha). Nunca lanca.
export async function registrarAviso(dados) {
  try {
    const db = await getPool();
    if (!db) return null;
    await ensureSchema(db);
    const r = await db.query(
      `INSERT INTO update_notices
         (install_id, offered_version, from_version, platform, kind)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (install_id, offered_version) DO NOTHING`,
      [dados.install_id || "", dados.offered_version || "",
       dados.from_version || "", dados.platform || "",
       dados.kind || "available"]);
    return r.rowCount > 0 ? "novo" : "duplicado";
  } catch (err) {
    console.error("update_notice insert error:", err?.message ?? err);
    return null;
  }
}

// Contagem dos avisos por versao oferecida, com quebra por plataforma e pela
// versao de ORIGEM ("quem esta atras"). null quando nao ha banco.
export async function contagemAvisos() {
  try {
    const db = await getPool();
    if (!db) return null;
    await ensureSchema(db);
    const totais = await db.query(
      `SELECT offered_version,
              count(*)::int AS total,
              count(*) FILTER (WHERE platform = 'macos')::int   AS macos,
              count(*) FILTER (WHERE platform = 'windows')::int AS windows,
              count(*) FILTER (WHERE platform = 'linux')::int   AS linux
         FROM update_notices
        GROUP BY offered_version
        ORDER BY offered_version DESC`);
    const origens = await db.query(
      `SELECT offered_version, COALESCE(NULLIF(from_version, ''), '?') AS from_version,
              count(*)::int AS n
         FROM update_notices
        GROUP BY offered_version, from_version`);
    const porVersao = {};
    for (const r of origens.rows) {
      const alvo = (porVersao[r.offered_version] =
        porVersao[r.offered_version] || {});
      alvo[r.from_version] = r.n;
    }
    return totais.rows.map((r) => ({
      offered_version: r.offered_version,
      total: r.total,
      macos: r.macos,
      windows: r.windows,
      linux: r.linux,
      from: porVersao[r.offered_version] || {},
    }));
  } catch (err) {
    console.error("update_notice read error:", err?.message ?? err);
    return null;
  }
}

// ── Instalacoes (trial iniciado = instalou e abriu o app) ───────────────
// O app manda UM beacon anonimo quando o trial comeca, e o indice unico em
// install_id garante UMA linha por instalacao — e por isso que esta contagem e
// "pessoas que instalaram", nao "downloads".
//
// AS INSTALACOES DE QA FICAM FORA DOS NUMEROS: os probes usam install_id com
// prefixo `teste-`/`zzz-probe-` (ex.: o POST que prova que a tubulacao grava).
// Elas continuam sendo contadas em `qa_teste` para a conta FECHAR — nada e
// escondido, so nao se mistura cliente com teste do dono.
const QA_INSTALL = "(install_id LIKE 'teste-%' OR install_id LIKE 'zzz-probe%' OR length(install_id) < 32)";

// Devolve null sem banco/falha (a rota responde 503 honesto, nunca 0 fingido).
export async function contagemInstalacoes() {
  try {
    const db = await getPool();
    if (!db) return null;
    await ensureSchema(db);
    const q = (sql) => db.query(sql);
    const limpo = `NOT ${QA_INSTALL}`;
    const total = await q("SELECT count(*)::int AS n FROM trials");
    const qa = await q(
      `SELECT count(*)::int AS n FROM trials WHERE ${QA_INSTALL}`);
    const porDia = await q(
      `SELECT ${DIA} AS dia, count(*)::int AS n
         FROM trials WHERE ${limpo} GROUP BY dia ORDER BY dia DESC LIMIT 90`);
    const porSo = await q(
      `SELECT COALESCE(NULLIF(platform, ''), '?') AS plataforma,
              count(*)::int AS n
         FROM trials WHERE ${limpo} GROUP BY plataforma ORDER BY n DESC`);
    const porPais = await q(
      `SELECT COALESCE(NULLIF(cc, ''), '??') AS cc, count(*)::int AS n
         FROM trials WHERE ${limpo} GROUP BY cc ORDER BY n DESC LIMIT 60`);
    const porCidade = await q(
      `SELECT COALESCE(NULLIF(city, ''), '—') AS cidade,
              COALESCE(NULLIF(cc, ''), '??') AS cc, count(*)::int AS n
         FROM trials WHERE ${limpo} GROUP BY cidade, cc ORDER BY n DESC LIMIT 60`);
    const janela = await q(
      `SELECT min(ts) AS primeiro, max(ts) AS ultimo
         FROM trials WHERE ${limpo}`);
    const nTotal = total.rows[0].n;
    const nQa = qa.rows[0].n;
    return {
      total: nTotal,
      qa_teste: nQa,
      total_reais: nTotal - nQa,
      por_dia: porDia.rows,
      por_sistema: porSo.rows,
      por_pais: porPais.rows,
      por_cidade: porCidade.rows,
      primeiro: janela.rows[0].primeiro,
      ultimo: janela.rows[0].ultimo,
    };
  } catch (err) {
    console.error("instalacoes read error:", err?.message ?? err);
    return null;
  }
}

// Linhas CRUAS das ultimas instalacoes (auditoria: "de onde veio este
// numero?"). O install_id vai TRUNCADO e nao identifica ninguem: e um UUID
// aleatorio da instalacao, sem email e sem IP. `qa` marca nossos testes.
export async function listarInstalacoes(limite = 60) {
  try {
    const db = await getPool();
    if (!db) return null;
    await ensureSchema(db);
    const n = Math.max(1, Math.min(500, Number(limite) || 60));
    const r = await db.query(
      `SELECT ts, platform, cc, region, city, left(install_id, 8) AS install_id,
              ${QA_INSTALL} AS qa
         FROM trials ORDER BY ts DESC LIMIT ${n}`);
    return r.rows;
  } catch (err) {
    console.error("instalacoes list error:", err?.message ?? err);
    return null;
  }
}

// ── ABERTURAS DO APP (beacon /api/app-open) ─────────────────────────────
// Cada abertura do app = 1 linha. `count(distinct install_id)` = installs
// REALMENTE EM USO (DAU). Nao ha dado pessoal: sem email/IP/hardware.
export async function registrarAbertura(dados) {
  try {
    const db = await getPool();
    if (!db) return null;
    await ensureSchema(db);
    const r = await db.query(
      `INSERT INTO app_opens
         (install_id, platform, app_version, os_release, status, reason,
          days_left, first_open, cc, region, city)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [dados.install_id || "", dados.platform || "", dados.app_version || "",
       dados.os_release || "", dados.status || "", dados.reason || "",
       Number(dados.days_left) || 0, Boolean(dados.first_open),
       dados.cc || "", dados.region || "", dados.city || ""]);
    return r.rowCount > 0 ? "novo" : "duplicado";
  } catch (err) {
    console.error("app_open insert error:", err?.message ?? err);
    return null;
  }
}

// Leitor: por dia (instalacoes distintas = DAU, aberturas, quantas em trial /
// licenciadas / bloqueadas), total, por sistema, os ULTIMOS eventos (com pais,
// cidade e hora — "quem acabou de abrir") e as instalacoes ativas em 7 dias.
export async function contagemAberturas(dias = 90) {
  try {
    const db = await getPool();
    if (!db) return null;
    await ensureSchema(db);
    const n = Math.max(1, Math.min(365, Number(dias) || 90));
    const q = (sql, p) => db.query(sql, p);
    const porDia = await q(
      `SELECT ${DIA} AS dia,
              count(DISTINCT install_id)::int AS instalacoes,
              count(*)::int AS aberturas,
              count(*) FILTER (WHERE first_open)::int AS primeiras,
              count(DISTINCT install_id) FILTER (WHERE status = 'TRIAL')::int AS em_trial,
              count(DISTINCT install_id) FILTER (WHERE status = 'LICENSED')::int AS licenciadas,
              count(DISTINCT install_id) FILTER (
                WHERE status NOT IN ('TRIAL', 'LICENSED'))::int AS bloqueadas
         FROM app_opens WHERE ts >= now() - ($1)::interval
        GROUP BY dia ORDER BY dia DESC`, [`${n} days`]);
    const total = await q(
      `SELECT count(DISTINCT install_id)::int AS instalacoes,
              count(*)::int AS aberturas,
              min(ts) AS primeira, max(ts) AS ultima FROM app_opens`);
    const porSo = await q(
      `SELECT COALESCE(NULLIF(platform, ''), '?') AS plataforma,
              count(DISTINCT install_id)::int AS instalacoes
         FROM app_opens GROUP BY plataforma ORDER BY 2 DESC`);
    const ultimas = await q(
      `SELECT ts, platform, app_version, status, reason, days_left, cc, region,
              city, left(install_id, 8) AS install_id, first_open
         FROM app_opens ORDER BY ts DESC LIMIT 60`);
    const porVersao = await q(
      `SELECT COALESCE(NULLIF(app_version, ''), '?') AS versao,
              count(DISTINCT install_id)::int AS instalacoes,
              count(*)::int AS aberturas,
              min(ts) AS primeira, max(ts) AS ultima
         FROM app_opens GROUP BY versao ORDER BY ultima DESC LIMIT 30`);
    const porStatus = await q(
      `SELECT COALESCE(NULLIF(status, ''), '?') AS status,
              count(DISTINCT install_id)::int AS instalacoes
         FROM app_opens GROUP BY status ORDER BY 2 DESC`);
    // Atualizou x primeira vez: a PRIMEIRA versao vista e comparada com a
    // ULTIMA, por instalacao.
    const porInstalacao = await q(
      `SELECT install_id, left(install_id, 8) AS curto,
              count(*)::int AS aberturas,
              count(DISTINCT (ts - interval '180 minutes')::date)::int AS dias,
              min(ts) AS primeira, max(ts) AS ultima,
              (array_agg(NULLIF(app_version,'') ORDER BY ts ASC))[1] AS v_entrada,
              (array_agg(NULLIF(app_version,'') ORDER BY ts DESC))[1] AS v_atual,
              (array_agg(NULLIF(city,'') ORDER BY ts DESC))[1] AS cidade,
              (array_agg(NULLIF(cc,'') ORDER BY ts DESC))[1] AS cc,
              (array_agg(NULLIF(status,'') ORDER BY ts DESC))[1] AS status,
              (array_agg(NULLIF(platform,'') ORDER BY ts DESC))[1] AS plataforma
         FROM app_opens GROUP BY install_id ORDER BY ultima DESC LIMIT 300`);
    const resumoInst = await q(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE v1 IS NOT NULL AND v2 IS NOT NULL
                                 AND v1 <> v2)::int AS atualizaram
         FROM (SELECT install_id,
                      (array_agg(NULLIF(app_version,'') ORDER BY ts ASC))[1] AS v1,
                      (array_agg(NULLIF(app_version,'') ORDER BY ts DESC))[1] AS v2
                 FROM app_opens GROUP BY install_id) x`);
    const semana = await q(
      `SELECT count(DISTINCT install_id)::int AS n FROM app_opens
        WHERE ts >= now() - interval '7 days'`);
    const hoje = await q(
      `SELECT count(DISTINCT install_id)::int AS n FROM app_opens
        WHERE ts >= now() - interval '24 hours'`);
    const mes = await q(
      `SELECT count(DISTINCT install_id)::int AS n FROM app_opens
        WHERE ts >= now() - interval '30 days'`);
    return {
      por_dia: porDia.rows,
      por_versao: porVersao.rows,
      por_status: porStatus.rows,
      total: total.rows[0],
      por_sistema: porSo.rows,
      ultimas: ultimas.rows,
      ativas_7d: semana.rows[0].n,
      ativas_24h: hoje.rows[0].n,
      ativas_30d: mes.rows[0].n,
      instalacoes_total: resumoInst.rows[0].total,
      atualizaram: resumoInst.rows[0].atualizaram,
      estreia: resumoInst.rows[0].total -
               resumoInst.rows[0].atualizaram,
      por_instalacao: porInstalacao.rows,
    };
  } catch (err) {
    console.error("app_opens read error:", err?.message ?? err);
    return null;
  }
}
