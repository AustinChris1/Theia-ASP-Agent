

let pool = null;

export function dbEnabled() {
  return !!process.env.DATABASE_URL;
}

export async function getPool() {
  if (!dbEnabled()) return null;
  if (!pool) {
    const mod = await import('pg');
    const { Pool } = mod.default ?? mod;

    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: Number(process.env.DB_POOL_MAX ?? 5),
      idleTimeoutMillis: 30_000
    });
    pool.on('error', (err) => console.warn(`[db] idle client error: ${err.message}`));
  }
  return pool;
}

export async function initSchema() {
  const p = await getPool();
  if (!p) return false;
  await p.query(`
    CREATE TABLE IF NOT EXISTS kv (
      ns   text NOT NULL,
      key  text NOT NULL,
      val  jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (ns, key)
    );
    CREATE TABLE IF NOT EXISTS journal (
      ns   text NOT NULL,
      id   text NOT NULL,
      row  jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (ns, id)
    );
    CREATE INDEX IF NOT EXISTS journal_ns_idx ON journal (ns);
  `);
  console.log('[db] Postgres connected — schema ready');
  return true;
}

export async function kvGet(ns, key) {
  const p = await getPool(); if (!p) return null;
  const r = await p.query('SELECT val FROM kv WHERE ns = $1 AND key = $2', [ns, key]);
  return r.rows[0]?.val ?? null;
}
export async function kvSet(ns, key, val) {
  const p = await getPool(); if (!p) return;

  await p.query(
    `INSERT INTO kv (ns, key, val, updated_at) VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (ns, key) DO UPDATE SET val = EXCLUDED.val, updated_at = now()`,
    [ns, key, JSON.stringify(val)]
  );
}
export async function kvAll(ns) {
  const p = await getPool(); if (!p) return [];
  const r = await p.query('SELECT key, val FROM kv WHERE ns = $1', [ns]);
  return r.rows.map(x => ({ key: x.key, val: x.val }));
}
export async function kvDelete(ns, key) {
  const p = await getPool(); if (!p) return;
  await p.query('DELETE FROM kv WHERE ns = $1 AND key = $2', [ns, key]);
}

export async function journalUpsert(ns, id, row) {
  const p = await getPool(); if (!p) return;
  await p.query(
    `INSERT INTO journal (ns, id, row, updated_at) VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (ns, id) DO UPDATE SET row = EXCLUDED.row, updated_at = now()`,
    [ns, id, JSON.stringify(row)]
  );
}
export async function journalAll(ns) {
  const p = await getPool(); if (!p) return [];
  const r = await p.query('SELECT row FROM journal WHERE ns = $1 ORDER BY updated_at ASC', [ns]);
  return r.rows.map(x => x.row);
}
export async function journalDelete(ns, id) {
  const p = await getPool(); if (!p) return;
  await p.query('DELETE FROM journal WHERE ns = $1 AND id = $2', [ns, id]);
}

export async function dbPing() {
  const p = await getPool(); if (!p) return false;
  try { await p.query('SELECT 1'); return true; } catch { return false; }
}
