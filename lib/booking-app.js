const crypto = require("crypto");
const path = require("path");
const express = require("express");
const { ensureSchema } = require("./db");
const service = require("./service");

const app = express();
app.disable("x-powered-by");

const send = (res, result) => {
  if (result.headers) res.set(result.headers);
  res.status(result.status).json(result.body);
};

// CORS, so the API can be called from other origins too. Preflights skip the key check.
app.use((req, res, next) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-Key, Idempotency-Key",
    "Access-Control-Expose-Headers": "Retry-After",
  });
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

app.use(async (req, res, next) => {
  try {
    await ensureSchema();
    next();
  } catch (err) {
    next(err);
  }
});

// Accept a JSON body whatever Content-Type the client sends.
const json = express.json({ type: () => true, strict: false });

// ---- The web page ---------------------------------------------------------

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));

// The page's own routes. They run the same booking logic as the API, but the
// API key stays on the server instead of being shipped to every browser.
// Only the patient-facing actions are here: no /reset and no cancelling.
const ui = express.Router();
ui.use(json);
ui.get("/slots", async (req, res) => send(res, await service.listSlots(req.query.provider)));
ui.post("/bookings", async (req, res) =>
  send(res, await service.createBooking(req.body, req.get("Idempotency-Key") || null)),
);
ui.get("/bookings/:id", async (req, res) => send(res, await service.getBooking(req.params.id)));
app.use("/ui", ui);

// ---- The API --------------------------------------------------------------

function requireApiKey(req, res, next) {
  const expected = Buffer.from(process.env.API_KEY || "");
  const given = Buffer.from(req.get("X-API-Key") || "");
  const matches =
    expected.length > 0 && given.length === expected.length && crypto.timingSafeEqual(given, expected);
  if (!matches) return res.status(401).json({ error: "missing or invalid API key" });
  next();
}

const api = express.Router();
api.use(requireApiKey, json);
api.post("/reset", async (req, res) => send(res, await service.reset(req.body)));
api.get("/slots", async (req, res) => send(res, await service.listSlots(req.query.provider)));
api.post("/bookings", async (req, res) =>
  send(res, await service.createBooking(req.body, req.get("Idempotency-Key") || null)),
);
api.get("/bookings", async (req, res) => send(res, await service.listBookings(req.query)));
api.get("/bookings/:id", async (req, res) => send(res, await service.getBooking(req.params.id)));
api.delete("/bookings/:id", async (req, res) => send(res, await service.cancelBooking(req.params.id)));
app.use(api);

// ---- Errors ---------------------------------------------------------------

app.use((req, res) => res.status(404).json({ error: "not found" }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "request body is not valid JSON" });
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: "internal server error" });
});

module.exports = app;
