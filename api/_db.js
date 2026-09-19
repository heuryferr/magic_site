// ======================================================================
// Postgres (Neon) — onde mora o LOG DE CLIQUES no download.
// ----------------------------------------------------------------------
// Substitui o Redis, que ficou RESERVADO para a licença (2 máquinas por chave).
// O Vercel é serverless (não tem disco), então o log precisa de um banco.
//
// Best-effort TOTAL: se o banco não estiver configurado ou falhar, NADA quebra
// — o download redireciona do mesmo jeito e a leitura devolve "sem dados".
//
// Configuração: variável de ambiente DATABASE_URL na Vercel (a connection
// string do Neon, a "pooled"). A tabela é criada sozinha no primeiro uso.
// ======================================================================

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
    // Import dinâmico: o `pg` só é carregado quando existe banco configurado.
    const { default: pg } = await import("pg");
    _pool = new pg.Pool({
      connectionString: url,
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
  await db.query(`CREATE TABLE IF NOT EXISTS clicks (
    id bigserial PRIMARY KEY,
    ts timestamptz NOT NULL DEFAULT now(),
    file text NOT NULL,
    cc text, region text, city text, ua text, conta text, ref text)`);
  await db.query(
    "CREATE INDEX IF NOT EXISTS clicks_ts_idx ON clicks (ts DESC)");
  _schemaOk = true;
}

// Grava UM clique. Devolve true/false; NUNCA lança.
export async function registrarClique(dados) {
  try {
    const db = await getPool();
    if (!db) return false;
    await ensureSchema(db);
    await db.query(
      `INSERT INTO clicks (file, cc, region, city, ua, conta, ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [dados.file || "", dados.cc || "", dados.region || "",
       dados.city || "", dados.ua || "", dados.conta || "",
       dados.ref || ""]);
    return true;
  } catch (err) {
    console.error("clicks insert error:", err?.message ?? err);
    return false;
  }
}

// Últimos N cliques no MESMO formato do antigo log do Redis
// ({t,f,cc,rg,ct,ua,conta,ref}) — assim o app não sente a troca.
// Devolve null quando não há banco configurado.
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
