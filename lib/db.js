const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Serverless instances each get their own pool, so keep it small.
  max: Number(process.env.PG_POOL_MAX || 5),
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS slots (
  id         TEXT PRIMARY KEY,
  provider   TEXT NOT NULL,
  start_text TEXT NOT NULL,          -- returned exactly as it was sent to /reset
  end_text   TEXT NOT NULL,
  start_at   TIMESTAMPTZ NOT NULL,   -- used for sorting and the "already started" check
  end_at     TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  seq        BIGSERIAL PRIMARY KEY,  -- insertion order, used for "oldest first" and cursors
  id         TEXT NOT NULL UNIQUE,
  slot_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Level 3: the database itself refuses a second confirmed booking for a slot,
-- so simultaneous requests can't both win.
CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_booking_per_slot
  ON bookings (slot_id) WHERE status = 'confirmed';

CREATE INDEX IF NOT EXISTS bookings_by_email ON bookings (email, seq);

-- Level 4: the stored response for each Idempotency-Key.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key          TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  status_code  INT NOT NULL,
  response     JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Level 5: one row per booking attempt, for the per-email rate limit.
CREATE TABLE IF NOT EXISTS booking_attempts (
  id           BIGSERIAL PRIMARY KEY,
  email        TEXT NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS booking_attempts_by_email ON booking_attempts (email, attempted_at);
`;

let ready;

// Create the tables if they don't exist yet, once per process. Running the DDL
// on every cold start would take table locks that deadlock with bookings already
// in flight on other instances, so check first with a plain read.
const LAST_OBJECT = "public.booking_attempts_by_email";

function ensureSchema() {
  if (!ready) {
    ready = (async () => {
      const { rows } = await pool.query("SELECT to_regclass($1) IS NOT NULL AS exists", [LAST_OBJECT]);
      if (rows[0].exists) return;
      await withTransaction(async (db) => {
        // Stops two cold-starting instances racing each other on CREATE TABLE.
        await db.query("SELECT pg_advisory_xact_lock(0, 42)");
        await db.query(SCHEMA);
      });
    })().catch((err) => {
      ready = undefined;
      throw err;
    });
  }
  return ready;
}

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, ensureSchema, withTransaction };
