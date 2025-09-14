/**
 * NVRBRTH minimal production-ready backend for Stripe Checkout (CommonJS).
 * - CORS allow-list via ALLOWED_ORIGINS (comma-separated, no trailing slashes)
 * - POST /create-checkout-session resolves Stripe prices by price id OR lookup_key
 * - POST /webhook uses raw body for signature verification
 * - GET  /ping healthcheck
 */
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const bodyParser = require("body-parser");

const app = express();

// ---- ENV (configure on Render) ----
// STRIPE_SECRET_KEY=sk_live_...
// STRIPE_WEBHOOK_SECRET=whsec_...
// ALLOWED_ORIGINS=https://nvrbrth.store,https://legendary-sunflower-10d7b9.netlify.app,http://localhost:5173,http://localhost:3000
// FRONTEND_BASE_URL=https://nvrbrth.store
// PORT=<render provided>
const {
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  ALLOWED_ORIGINS = "",
  FRONTEND_BASE_URL = "",
} = process.env;

if (!STRIPE_SECRET_KEY) {
  console.warn("WARNING: STRIPE_SECRET_KEY is not set. Set it in Render env vars.");
}
const stripe = new Stripe(STRIPE_SECRET_KEY || "", { apiVersion: "2024-06-20" });

// --- CORS allow list ---
const origins = ALLOWED_ORIGINS.split(",").map(s => s.trim()).filter(Boolean);
function applyCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (origin && origins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
    res.header("Access-Control-Allow-Credentials", "true");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }
}
// Handle preflight quickly
app.use((req, res, next) => {
  if (req.method === "OPTIONS") {
    applyCorsHeaders(req, res);
    return res.sendStatus(204);
  }
  applyCorsHeaders(req, res);
  next();
});
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // allow curl/postman
    return cb(null, origins.includes(origin));
  },
  credentials: true,
}));

// Healthcheck
app.get("/ping", (_req, res) => res.json({ ok: true }));

// Webhook must be before express.json and use raw body
app.post("/webhook", bodyParser.raw({ type: "application/json" }), (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      console.log("✅ checkout.session.completed", session.id, session.mode, session.amount_total);
      // TODO: fulfill order, email, etc.
      break;
    }
    default:
      console.log("ℹ️ Unhandled event", event.type);
  }
  res.json({ received: true });
});

// For non-webhook routes use JSON parser
app.use(express.json());

// Optional friendly SKU -> lookup_key mapping
const friendlyMap = {
  "vein-001": "host001_compression_vein001",
  "vein001": "host001_compression_vein001",
  "vein-002": "host001_compression_vein002",
  "vein002": "host001_compression_vein002",
  "obsidian-001": "host001_compression_obsidian",
  "obsidian": "host001_compression_obsidian",
  "corrode-001": "host001_compression_corrode",
  "corrode": "host001_compression_corrode",
  "skinlock-exe": "host001_compression_skinlock",
  "skinlock": "host001_compression_skinlock",
  "reaper-001": "host001_tee_reaper",
  "reaper": "host001_tee_reaper",
  "wrath-001": "host001_tee_wrath",
  "wraith-001": "host001_tee_wrath",
  "wrath": "host001_tee_wrath",
  "within-001": "host001_hoodie_within",
  "within": "host001_hoodie_within",
  "nullvoid-001": "host001_hoodie_nullvoid",
  "nullvoid": "host001_hoodie_nullvoid",
};

async function resolveLineItem(item) {
  // Accepts { price }, { lookup_key }, or { sku } (mapped to lookup_key)
  if (!item) throw new Error("Invalid item");
  if (item.price && String(item.price).startsWith("price_")) {
    return { price: item.price, quantity: item.quantity || 1 };
  }
  let lk = item.lookup_key;
  if (!lk && item.sku && friendlyMap[item.sku]) lk = friendlyMap[item.sku];

  if (!lk) throw new Error("Item needs price or lookup_key/sku");

  // Search active price by lookup_key
  const prices = await stripe.prices.search({
    query: `lookup_key:'${lk}' AND active:'true'`,
    limit: 1,
  });
  if (!prices.data.length) {
    throw new Error(`No active Stripe price for lookup_key ${lk}`);
  }
  return { price: prices.data[0].id, quantity: item.quantity || 1 };
}

// Create Checkout Session
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { items, success_url, cancel_url, mode = "payment", customer_email } = req.body || {};
    if (!Array.isArray(items) || !items.length) throw new Error("Cart is empty or invalid");

    const line_items = [];
    for (const it of items) {
      line_items.push(await resolveLineItem(it));
    }

    const successUrl = success_url || (FRONTEND_BASE_URL ? `${FRONTEND_BASE_URL}/thankyou.html` : undefined);
    const cancelUrl = cancel_url || (FRONTEND_BASE_URL ? `${FRONTEND_BASE_URL}/basket.html` : undefined);
    if (!successUrl || !cancelUrl) {
      throw new Error("Missing success_url/cancel_url and FRONTEND_BASE_URL");
    }

    const session = await stripe.checkout.sessions.create({
      mode,
      line_items,
      allow_promotion_codes: true,
      shipping_address_collection: { allowed_countries: ["GB", "IE", "US", "CA", "AU", "NZ", "DE", "FR", "NL", "ES", "IT", "SE", "NO", "DK"] },
      success_url: successUrl,
      cancel_url: cancelUrl,
      customer_email: customer_email || undefined,
      billing_address_collection: "auto",
      // automatic_tax: { enabled: false }, // toggle if you enable Stripe Tax
    });

    res.json({ id: session.id, url: session.url });
  } catch (e) {
    console.error("create-checkout-session error:", e);
    res.status(400).json({ error: String(e.message || e) });
  }
});

const port = process.env.PORT || 8787;
app.listen(port, () => {
  console.log(`NVRBRTH server listening on ${port}. Allowed origins: ${origins.join(", ")}`);
});
