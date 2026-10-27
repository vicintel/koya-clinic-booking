// Runs the API against a real Postgres database, level by level.
//   DATABASE_URL=postgres:///koya_booking_test npm test
// Set BASE_URL (and API_KEY) to run the same checks against a deployed copy instead.
const test = require("node:test");
const assert = require("node:assert/strict");

const API_KEY = process.env.API_KEY || "test-key";
let base = process.env.BASE_URL;
let server;

test.before(async () => {
  if (base) return;
  process.env.API_KEY = API_KEY;
  process.env.PG_POOL_MAX = "20";
  const app = require("../lib/booking-app");
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${server.address().port}`;
});

test.after(async () => {
  if (server) {
    server.close();
    await require("../lib/db").pool.end();
  }
});

async function call(method, path, { body, key = API_KEY, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(key ? { "X-API-Key": key } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

const future = (hours) => new Date(Date.now() + hours * 3600e3).toISOString().replace(/\.\d{3}Z$/, "Z");
const SLOTS = [
  { id: "s2", provider: "Dr Bisi", start: future(26), end: future(26.5) },
  { id: "s1", provider: "Dr Ade", start: future(24), end: future(24.5) },
  { id: "s3", provider: "Dr Ade", start: future(48), end: future(48.5) },
  { id: "past", provider: "Dr Ade", start: "2020-01-01T09:00:00Z", end: "2020-01-01T09:30:00Z" },
];
const reset = (slots = SLOTS) => call("POST", "/reset", { body: { slots } });
const book = (body, headers) => call("POST", "/bookings", { body, headers });

test("level 1: reset, list slots, book, look up", async () => {
  assert.equal((await reset()).status, 200);

  const slots = await call("GET", "/slots");
  assert.equal(slots.status, 200);
  assert.deepEqual(slots.body.slots.map((s) => s.id), ["past", "s1", "s2", "s3"]);
  assert.deepEqual(slots.body.slots[1], { ...SLOTS[1], available: true });

  const ade = await call("GET", "/slots?provider=Dr%20Ade");
  assert.deepEqual(ade.body.slots.map((s) => s.id), ["past", "s1", "s3"]);

  const created = await book({ slot_id: "s1", name: "Ada Obi", email: "ada@example.com" });
  assert.equal(created.status, 201);
  assert.equal(created.body.status, "confirmed");
  assert.equal(created.body.slot_id, "s1");
  assert.ok(created.body.id && created.body.created_at);

  const fetched = await call("GET", `/bookings/${created.body.id}`);
  assert.deepEqual(fetched.body, created.body);
  assert.equal((await call("GET", "/bookings/nope")).status, 404);

  const after = await call("GET", "/slots");
  assert.equal(after.body.slots.find((s) => s.id === "s1").available, false);
});

test("level 2: API key and validation", async () => {
  await reset();
  assert.equal((await call("GET", "/slots", { key: null })).status, 401);
  assert.equal((await call("GET", "/slots", { key: "wrong" })).status, 401);
  assert.equal((await call("POST", "/reset", { key: null, body: { slots: [] } })).status, 401);
  assert.deepEqual((await call("GET", "/slots", { key: null })).body, { error: "missing or invalid API key" });

  const good = { slot_id: "s1", name: "Ada", email: "a@example.com" };
  for (const bad of [
    { ...good, slot_id: undefined },
    { ...good, name: "" },
    { ...good, name: "   " },
    { ...good, email: undefined },
    { ...good, email: "not-an-email" },
    { ...good, email: "a@b" },
  ]) {
    const res = await book(bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal(typeof res.body.error, "string");
  }
  assert.equal((await book("{not json")).status, 400);
  assert.equal((await book({ ...good, slot_id: "missing" })).status, 404);
  assert.equal((await book({ ...good, slot_id: "past" })).status, 400);

  const trimmed = await book({ slot_id: "s1", name: "  Ada Obi  ", email: "  Ada@Example.COM " });
  assert.equal(trimmed.status, 201);
  assert.equal(trimmed.body.name, "Ada Obi");
  assert.equal(trimmed.body.email, "ada@example.com");
});

test("level 3: no double booking under concurrency, cancelling frees the slot", async () => {
  await reset();
  const results = await Promise.all(
    Array.from({ length: 25 }, (_, i) => book({ slot_id: "s2", name: `P${i}`, email: `p${i}@example.com` })),
  );
  const statuses = results.map((r) => r.status).sort();
  assert.equal(statuses.filter((s) => s === 201).length, 1);
  assert.equal(statuses.filter((s) => s === 409).length, 24);

  const winner = results.find((r) => r.status === 201).body;
  const cancelled = await call("DELETE", `/bookings/${winner.id}`);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, "cancelled");
  assert.equal((await call("DELETE", `/bookings/${winner.id}`)).status, 409);
  assert.equal((await call("DELETE", "/bookings/nope")).status, 404);

  const slot = (await call("GET", "/slots")).body.slots.find((s) => s.id === "s2");
  assert.equal(slot.available, true);
  assert.equal((await book({ slot_id: "s2", name: "Next", email: "next@example.com" })).status, 201);
});

test("level 4: idempotency keys", async () => {
  await reset();
  const body = { slot_id: "s1", name: "Ada", email: "ada@example.com" };
  const headers = { "Idempotency-Key": "key-1" };

  const first = await book(body, headers);
  const again = await book({ email: "ada@example.com", name: "Ada", slot_id: "s1" }, headers);
  assert.equal(first.status, 201);
  assert.equal(again.status, 201);
  assert.equal(again.body.id, first.body.id);

  assert.equal((await book({ ...body, name: "Someone else" }, headers)).status, 422);

  // Concurrent retries with one key make one booking.
  const burst = await Promise.all(
    Array.from({ length: 10 }, () => book({ slot_id: "s3", name: "B", email: "b@example.com" }, { "Idempotency-Key": "key-2" })),
  );
  assert.ok(burst.every((r) => r.status === 201));
  assert.equal(new Set(burst.map((r) => r.body.id)).size, 1);

  // An error response is replayed too.
  const missing = await book({ ...body, slot_id: "nope" }, { "Idempotency-Key": "key-3" });
  const missingAgain = await book({ ...body, slot_id: "nope" }, { "Idempotency-Key": "key-3" });
  assert.equal(missing.status, 404);
  assert.equal(missingAgain.status, 404);
});

test("level 4: paging through a person's bookings", async () => {
  const slots = Array.from({ length: 7 }, (_, i) => ({
    id: `p${i}`, provider: "Dr Ade", start: future(24 + i), end: future(24.5 + i),
  }));
  await reset(slots);
  const ids = [];
  for (let i = 0; i < 5; i++) {
    ids.push((await book({ slot_id: `p${i}`, name: "Ada", email: i % 2 ? "ADA@example.com" : "ada@example.com" })).body.id);
  }
  await book({ slot_id: "p5", name: "Other", email: "other@example.com" });

  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const q = `/bookings?email=Ada@Example.com&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const page = await call("GET", q);
    assert.equal(page.status, 200);
    seen.push(...page.body.bookings.map((b) => b.id));
    cursor = page.body.next_cursor;
    pages++;
  } while (cursor);
  assert.deepEqual(seen, ids);
  assert.equal(pages, 3);

  const all = await call("GET", "/bookings?email=ada@example.com");
  assert.equal(all.body.bookings.length, 5);
  assert.equal(all.body.next_cursor, null);

  for (const limit of ["0", "51", "abc", "1.5", "-1", ""]) {
    assert.equal((await call("GET", `/bookings?email=ada@example.com&limit=${limit}`)).status, 400, limit);
  }
  assert.equal((await call("GET", "/bookings?email=ada@example.com&cursor=zzz")).status, 400);
  assert.equal((await call("GET", "/bookings")).status, 400);
});

test("level 5: 5 attempts per email per minute", async () => {
  await reset();
  const spam = (i) => book({ slot_id: i % 2 ? "nope" : "s1", name: "Spam", email: "spam@example.com" });
  const first5 = await Promise.all([0, 1, 2, 3, 4].map(spam));
  assert.ok(first5.every((r) => r.status !== 429), first5.map((r) => r.status).join());

  const sixth = await spam(5);
  assert.equal(sixth.status, 429);
  const retryAfter = Number(sixth.headers.get("retry-after"));
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60, String(retryAfter));

  // Case and spaces don't get around it; other emails aren't affected.
  assert.equal((await book({ slot_id: "s2", name: "Spam", email: " SPAM@example.com " })).status, 429);
  assert.equal((await book({ slot_id: "s2", name: "Ok", email: "ok@example.com" })).status, 201);

  // A burst of 12 at once still lets exactly 5 through.
  const burst = await Promise.all(
    Array.from({ length: 12 }, () => book({ slot_id: "nope", name: "B", email: "burst@example.com" })),
  );
  assert.equal(burst.filter((r) => r.status !== 429).length, 5);
});
