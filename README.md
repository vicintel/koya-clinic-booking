# Clinic booking API

Koya Cohort 4 assessment, Task 1. An API for booking clinic appointment slots, plus a web page that uses it. Built to the [spec](https://koyaacademy.com/assessment-api).

**Stack:** Node.js + Express on Vercel, with Postgres (Neon) for storage.

## How each level is handled

| Level | Requirement | How |
|---|---|---|
| 1 | List slots, book one, look one up | `GET /slots` (earliest first, optional `provider`), `POST /bookings`, `GET /bookings/{id}`, `POST /reset` |
| 2 | API key, validation | Every API request needs `X-API-Key` (constant-time compare), else 401. Missing/empty fields or a bad email give 400, an unknown slot 404, a slot that has started 400. Name and email are trimmed and email is stored in lower case. |
| 3 | No double booking, cancelling | A partial unique index (`UNIQUE (slot_id) WHERE status = 'confirmed'`) lets the database reject a second confirmed booking, so it holds even when requests arrive at the same instant. `DELETE /bookings/{id}` sets `cancelled`, which frees the slot. |
| 4 | Idempotent retries, paging | The response for each `Idempotency-Key` is stored with a hash of the body. A repeat with the same body replays the stored status and booking. A different body gets 422. Requests sharing a key are serialised with a Postgres advisory lock, so concurrent retries can't both book. `GET /bookings?email=` pages oldest first with an opaque cursor. |
| 5 | Stop spam | At most 5 attempts per email per 60 seconds, failed ones included. The 6th gets 429 with `Retry-After` (seconds until the oldest attempt leaves the window). The check takes a per-email advisory lock, so a burst can't slip through. |

All errors are `{"error": "..."}`. `POST /reset` also clears idempotency keys and rate-limit counters, so each test run starts clean.

## The web page

`/` is a booking page: see available slots, book one, get a confirmation, look a booking up by reference. It calls `/ui/*` routes that run the same booking code (including validation, the double-booking guard, idempotency and the rate limit). The API key never reaches the browser, and those routes can't reset data or cancel bookings.

## Run it locally

```bash
npm install
createdb koya_booking
DATABASE_URL=postgres:///koya_booking API_KEY=dev-key node dev.js
```

Tables are created on the first request.

## Tests

```bash
createdb koya_booking_test
DATABASE_URL=postgres:///koya_booking_test npm test
```

The suite covers every level, including 25 simultaneous bookings for one slot (exactly one succeeds), concurrent retries with one idempotency key, and a burst of 12 attempts from one email (exactly 5 get through). Set `BASE_URL` and `API_KEY` to run the same checks against a deployed copy.

## Deploy (Vercel)

Set `DATABASE_URL` (Postgres, pooled connection string) and `API_KEY` in the project's environment variables, then run `vercel --prod`. `vercel.json` sends every route to the one Express function.
