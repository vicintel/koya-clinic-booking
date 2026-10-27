const crypto = require("crypto");
const { pool, withTransaction } = require("./db");

const RATE_LIMIT = 5; // booking attempts per email
const RATE_WINDOW_SECONDS = 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Advisory lock namespaces, so the two kinds of lock never collide.
const IDEMPOTENCY_LOCK = 1;
const EMAIL_LOCK = 2;

const ok = (status, body, headers) => ({ status, body, headers });
const fail = (status, message, headers) => ({ status, body: { error: message }, headers });

function toBooking(row) {
  return {
    id: row.id,
    slot_id: row.slot_id,
    name: row.name,
    email: row.email,
    status: row.status,
    created_at: row.created_at.toISOString(),
  };
}

const BOOKING_COLUMNS = "seq, id, slot_id, name, email, status, created_at";

const isNonEmptyString = (v) => typeof v === "string" && v.trim() !== "";
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// ---- /reset ---------------------------------------------------------------

async function reset(body) {
  if (!isPlainObject(body) || !Array.isArray(body.slots)) {
    return fail(400, "slots must be an array");
  }

  const seen = new Set();
  for (const slot of body.slots) {
    if (!isPlainObject(slot)) return fail(400, "each slot must be an object");
    for (const field of ["id", "provider", "start", "end"]) {
      if (!isNonEmptyString(slot[field])) return fail(400, `each slot needs a ${field}`);
    }
    if (Number.isNaN(Date.parse(slot.start)) || Number.isNaN(Date.parse(slot.end))) {
      return fail(400, `slot ${slot.id} has an invalid start or end`);
    }
    if (seen.has(slot.id)) return fail(400, `duplicate slot id ${slot.id}`);
    seen.add(slot.id);
  }

  const slots = body.slots;
  await withTransaction(async (db) => {
    await db.query("TRUNCATE bookings, slots, idempotency_keys, booking_attempts RESTART IDENTITY");
    await db.query(
      `INSERT INTO slots (id, provider, start_text, end_text, start_at, end_at)
       SELECT id, provider, start_text, end_text, start_iso::timestamptz, end_iso::timestamptz
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
         AS t(id, provider, start_text, end_text, start_iso, end_iso)`,
      [
        slots.map((s) => s.id),
        slots.map((s) => s.provider),
        slots.map((s) => s.start),
        slots.map((s) => s.end),
        slots.map((s) => new Date(s.start).toISOString()),
        slots.map((s) => new Date(s.end).toISOString()),
      ],
    );
  });

  return ok(200, { ok: true, slots: slots.length });
}

// ---- GET /slots -----------------------------------------------------------

async function listSlots(provider) {
  const { rows } = await pool.query(
    `SELECT s.id, s.provider, s.start_text, s.end_text,
            NOT EXISTS (
              SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed'
            ) AS available
     FROM slots s
     WHERE $1::text IS NULL OR s.provider = $1
     ORDER BY s.start_at, s.id`,
    [typeof provider === "string" ? provider : null],
  );
  return ok(200, {
    slots: rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      start: r.start_text,
      end: r.end_text,
      available: r.available,
    })),
  });
}

// ---- POST /bookings -------------------------------------------------------

function requestHash(body) {
  // Canonical JSON (sorted keys), so {"a":1,"b":2} and {"b":2,"a":1} count as the same body.
  const canonical = (v) =>
    Array.isArray(v)
      ? `[${v.map(canonical).join(",")}]`
      : isPlainObject(v)
        ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`
        : JSON.stringify(v ?? null);
  return crypto.createHash("sha256").update(canonical(body)).digest("hex");
}

async function createBooking(body, idempotencyKey) {
  return withTransaction(async (db) => {
    let hash;
    if (idempotencyKey) {
      hash = requestHash(body);
      // Requests sharing a key run one at a time, so concurrent retries can't both book.
      await db.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [IDEMPOTENCY_LOCK, idempotencyKey]);
      const { rows } = await db.query(
        "SELECT request_hash, status_code, response FROM idempotency_keys WHERE key = $1",
        [idempotencyKey],
      );
      if (rows.length) {
        if (rows[0].request_hash !== hash) {
          return fail(422, "Idempotency-Key was already used with a different request body");
        }
        return ok(rows[0].status_code, rows[0].response);
      }
    }

    const result = await attemptBooking(db, body);

    // Remember the outcome for retries. A 429 is temporary, so a retry after
    // waiting should get a real answer rather than the stored 429.
    if (idempotencyKey && result.status !== 429) {
      await db.query(
        "INSERT INTO idempotency_keys (key, request_hash, status_code, response) VALUES ($1, $2, $3, $4)",
        [idempotencyKey, hash, result.status, JSON.stringify(result.body)],
      );
    }
    return result;
  });
}

async function attemptBooking(db, body) {
  const fields = isPlainObject(body) ? body : {};

  // Level 5 runs before validation: failed attempts count towards the limit too.
  const rateEmail = isNonEmptyString(fields.email) ? fields.email.trim().toLowerCase() : null;
  if (rateEmail) {
    const limited = await checkRateLimit(db, rateEmail);
    if (limited) return limited;
  }

  if (!isPlainObject(body)) return fail(400, "request body must be a JSON object");
  for (const field of ["slot_id", "name", "email"]) {
    if (!isNonEmptyString(fields[field])) return fail(400, `${field} is required`);
  }
  const name = fields.name.trim();
  const email = fields.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return fail(400, "email is not valid");

  const { rows: slots } = await db.query(
    "SELECT start_at <= clock_timestamp() AS started FROM slots WHERE id = $1",
    [fields.slot_id],
  );
  if (!slots.length) return fail(404, "slot not found");
  if (slots[0].started) return fail(400, "slot has already started");

  // If another confirmed booking for this slot exists (or is being committed right now),
  // the partial unique index makes this insert do nothing instead of double-booking.
  const { rows } = await db.query(
    `INSERT INTO bookings (id, slot_id, name, email, status)
     VALUES ($1, $2, $3, $4, 'confirmed')
     ON CONFLICT (slot_id) WHERE status = 'confirmed' DO NOTHING
     RETURNING ${BOOKING_COLUMNS}`,
    [crypto.randomUUID(), fields.slot_id, name, email],
  );
  if (!rows.length) return fail(409, "slot is already booked");
  return ok(201, toBooking(rows[0]));
}

async function checkRateLimit(db, email) {
  // One request per email at a time, so a burst can't all read "4 attempts" at once.
  await db.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [EMAIL_LOCK, email]);
  await db.query(
    `DELETE FROM booking_attempts
     WHERE email = $1 AND attempted_at <= clock_timestamp() - make_interval(secs => $2)`,
    [email, RATE_WINDOW_SECONDS],
  );
  const { rows } = await db.query(
    `SELECT count(*)::int AS attempts,
            extract(epoch FROM min(attempted_at) + make_interval(secs => $2) - clock_timestamp()) AS wait
     FROM booking_attempts WHERE email = $1`,
    [email, RATE_WINDOW_SECONDS],
  );
  if (rows[0].attempts >= RATE_LIMIT) {
    const retryAfter = Math.max(1, Math.ceil(Number(rows[0].wait)));
    return fail(429, "too many booking attempts for this email, try again later", {
      "Retry-After": String(retryAfter),
    });
  }
  await db.query("INSERT INTO booking_attempts (email) VALUES ($1)", [email]);
  return null;
}

// ---- GET /bookings --------------------------------------------------------

const encodeCursor = (seq) => Buffer.from(String(seq)).toString("base64url");
function decodeCursor(cursor) {
  const seq = Buffer.from(cursor, "base64url").toString();
  return /^\d{1,18}$/.test(seq) ? seq : null;
}

async function listBookings(query) {
  if (!isNonEmptyString(query.email)) return fail(400, "email is required");

  let limit = 10;
  if (query.limit !== undefined) {
    if (typeof query.limit !== "string" || !/^\d+$/.test(query.limit)) {
      return fail(400, "limit must be a whole number from 1 to 50");
    }
    limit = Number(query.limit);
    if (limit < 1 || limit > 50) return fail(400, "limit must be a whole number from 1 to 50");
  }

  let after = "0";
  if (query.cursor !== undefined && query.cursor !== "") {
    after = typeof query.cursor === "string" ? decodeCursor(query.cursor) : null;
    if (after === null) return fail(400, "cursor is not valid");
  }

  // Fetch one extra row to know whether there's another page.
  const { rows } = await pool.query(
    `SELECT ${BOOKING_COLUMNS} FROM bookings
     WHERE email = $1 AND seq > $2
     ORDER BY seq
     LIMIT $3`,
    [query.email.trim().toLowerCase(), after, limit + 1],
  );
  const page = rows.slice(0, limit);
  const more = rows.length > limit;
  return ok(200, {
    bookings: page.map(toBooking),
    next_cursor: more ? encodeCursor(page[page.length - 1].seq) : null,
  });
}

// ---- GET /bookings/:id and DELETE /bookings/:id ---------------------------

async function getBooking(id) {
  const { rows } = await pool.query(`SELECT ${BOOKING_COLUMNS} FROM bookings WHERE id = $1`, [id]);
  return rows.length ? ok(200, toBooking(rows[0])) : fail(404, "booking not found");
}

async function cancelBooking(id) {
  const { rows } = await pool.query(
    `UPDATE bookings SET status = 'cancelled'
     WHERE id = $1 AND status = 'confirmed'
     RETURNING ${BOOKING_COLUMNS}`,
    [id],
  );
  if (rows.length) return ok(200, toBooking(rows[0]));
  const existing = await getBooking(id);
  return existing.status === 404 ? existing : fail(409, "booking is already cancelled");
}

module.exports = { reset, listSlots, createBooking, listBookings, getBooking, cancelBooking };
