/**
 * NVRBRTH backend – Express + Stripe + Resend
 * Adds /api/checkout using Stripe lookup keys (with empty-cart fallback).
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const Stripe = require('stripe');
const { Resend } = require('resend');

// ----- Env -----
const {
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  RESEND_API_KEY,
  FROM_EMAIL,
  ALLOWED_ORIGINS,
  FRONTEND_BASE_URL,
  DEFAULT_LOOKUP_KEY
} = process.env;

if (!STRIPE_SECRET_KEY) console.warn('[warn] STRIPE_SECRET_KEY missing');
if (!STRIPE_WEBHOOK_SECRET) console.warn('[warn] STRIPE_WEBHOOK_SECRET missing');
if (!RESEND_API_KEY) console.warn('[warn] RESEND_API_KEY missing');
if (!FROM_EMAIL) console.warn('[warn] FROM_EMAIL missing');
if (!FRONTEND_BASE_URL) console.warn('[warn] FRONTEND_BASE_URL missing (used for success/cancel URLs)');

const stripe = new Stripe(STRIPE_SECRET_KEY || '', { apiVersion: '2024-06-20' });
const resend = new Resend(RESEND_API_KEY || '');

// ----- App -----
const app = express();

// CORS
const allowList = (ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    console.log('[cors] origin:', origin);
    if (!origin) return cb(null, true);
    if (allowList.length === 0 || allowList.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'), false);
  }
}));
app.options('*', cors()); // preflight

// The Stripe webhook must receive the raw body
app.use('/webhook', express.raw({ type: 'application/json' }));

// JSON for everything else
app.use(bodyParser.json());

// Healthcheck
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// ---- Email template loader (optional) ----
const TEMPLATE_PATH = path.join(__dirname, 'email.html');
let EMAIL_TEMPLATE = null;
try {
  EMAIL_TEMPLATE = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  console.log('[init] Loaded email template:', TEMPLATE_PATH);
} catch (e) {
  console.warn('[warn] email.html not found – will send a simplified email body');
}

async function sendOrderEmail({ to, orderId, amountTotal, currency, lineItems = [], created }) {
  if (!RESEND_API_KEY || !FROM_EMAIL || !to) {
    console.warn('[email] Missing keys or recipient; skipping email send');
    return;
  }

  const fmtCurrency = (amt, curr) => {
    try {
      return new Intl.NumberFormat('en-GB', { style: 'currency', currency: (curr || 'GBP').toUpperCase() }).format((amt || 0) / 100);
    } catch {
      return `£${((amt || 0) / 100).toFixed(2)}`;
    }
  };

  let html = EMAIL_TEMPLATE;
  if (html) {
    const dateStr = created ? new Date(created * 1000).toLocaleString('en-GB', { timeZone: 'Europe/London' }) : new Date().toLocaleString('en-GB');
    const rows = (lineItems || []).map(li => {
      const qty = li.quantity || 1;
      const name = li.description || li.price?.product || 'Item';
      const price = fmtCurrency(li.amount_subtotal ?? (li.price?.unit_amount || 0) * qty, currency);
      return `<tr><td style="padding:6px 0">${name}${li.size ? ` — ${li.size}` : ''}</td><td style="text-align:right">${qty} × ${fmtCurrency(li.price?.unit_amount || 0, currency)}</td><td style="text-align:right">${price}</td></tr>`;
    }).join('');

    html = html
      .replace(/{{ORDER_ID}}/g, orderId || 'N/A')
      .replace(/{{ORDER_DATE}}/g, dateStr)
      .replace(/{{ITEM_ROWS}}/g, rows || '')
      .replace(/{{TOTAL}}/g, fmtCurrency(amountTotal || 0, currency))
      .replace(/{{SUBTOTAL}}/g, '')
      .replace(/{{DISCOUNT_ROW}}/g, '')
      .replace(/{{SHIPPING_ROW}}/g, '')
      .replace(/{{TAX_ROW}}/g, '')
      .replace(/{{SHIPPING_BLOCK}}/g, '');
  } else {
    html = `<div style="font-family:Arial,sans-serif;padding:16px">
      <h2>Order confirmed</h2>
      <p>Thanks for your order ${orderId ? `(${orderId})` : ''}.</p>
      <p>Total: ${fmtCurrency(amountTotal || 0, currency)}</p>
      <p>You'll receive another email when it ships (pre‑order ~1 month).</p>
    </div>`;
  }

  try {
    const res = await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject: 'NVRBRTH — Order Confirmation',
      html
    });
    console.log('[email] Sent:', res?.id || 'ok');
  } catch (err) {
    console.error('[email] Failed:', err?.message || err);
  }
}

// ------------------------------
// Checkout via lookup keys
// ------------------------------

/** Optional explicit mapping: slug -> lookup_key (leave empty if slugs already equal to lookup keys) */
const SLUG_TO_LOOKUP = {
  // 'vein-001': 'lk_vein_001',
  // 'skinlock-exe': 'lk_skinlock_exe',
};

/** Normalize a cart item from the frontend into a lookup key */
function itemToLookupKey(raw) {
  const product = String(raw.productId || raw.base || '').toLowerCase();
  const baseOnly = product.split('_')[0]; // drop size suffix e.g. vein-001_small -> vein-001
  const base = baseOnly.replace(/_/g, '-');
  return SLUG_TO_LOOKUP[base] || base;
}


/** Resolve multiple lookup keys into Stripe Price IDs */
async function resolvePrices(lookupKeys) {
  const uniq = [...new Set(lookupKeys)];
  if (!uniq.length) return new Map();
  const prices = await stripe.prices.list({
    lookup_keys: uniq,
    active: true,
    limit: Math.max(uniq.length, 10),
    expand: ['data.product']
  });
  const map = new Map();
  for (const p of prices.data) {
    if (p.lookup_key) map.set(p.lookup_key, p.id);
  }
  return map;
}

app.post('/api/checkout', async (req, res) => {
  try {
    const {
      email, name, phone,
      address1, city, postcode, country = 'GB',
      cart = []
    } = req.body || {};

    // require a non-empty cart
    if (!Array.isArray(cart) || cart.length === 0) {
      console.warn('[checkout] EMPTY_CART');
      return res.status(400).json({ error: 'EMPTY_CART' });
    }

    console.log('[checkout] origin:', req.headers.origin);
    console.log('[checkout] body:', req.body);

    const wantedLookupKeys = cart.map(itemToLookupKey);
    const priceMap = await resolvePrices(wantedLookupKeys);

    const itemsForSession = cart.map(raw => {
      const lk = itemToLookupKey(raw);
      const price = priceMap.get(lk);
      if (!price) {
        throw new Error(`NO_PRICE_FOR_LOOKUP_KEY_${lk}`);
      }
      const qty = Math.max(1, parseInt(raw.quantity || 1, 10));
      return { price, quantity: qty };
    });

    const success = `${FRONTEND_BASE_URL || ''}/thankyou.html?sid={CHECKOUT_SESSION_ID}`.replace(/\/\//g,'/').replace('https:/','https://');
    const cancel  = `${FRONTEND_BASE_URL || ''}/checkout.html`.replace(/\/\//g,'/').replace('https:/','https://');

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: itemsForSession,
      allow_promotion_codes: true,
      customer_email: email || undefined,
      shipping_address_collection: { allowed_countries: ['GB'] },
      success_url: success,
      cancel_url: cancel,
      metadata: {
        name: name || '',
        phone: phone || '',
        address1: address1 || '',
        city: city || '',
        postcode: postcode || '',
        country: country || 'GB'
      }
    });

    return res.json({ url: session.url, id: session.id });
  } catch (err) {
    console.error('[checkout] error:', err?.message || err);
    return res.status(400).json({ error: err?.message || 'CHECKOUT_CREATE_FAILED' });
  }
});

// Lightweight order fetch for thankyou.html
app.get('/api/orders/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const session = await stripe.checkout.sessions.retrieve(id);
    const lineItems = await stripe.checkout.sessions.listLineItems(id, {
      expand: ['data.price.product']
    });

    const lines = (lineItems.data || []).map(li => ({
      quantity: li.quantity || 1,
      amount_subtotal: li.amount_subtotal || 0,
      amount_total: li.amount_total || 0,
      currency: (li.currency || session.currency || 'gbp').toLowerCase(),
      name: (li.price?.product?.name) || li.description || '',
      size: (li.price?.nickname) || '', // optional: price nickname as size/variant
      price: {
        unit_amount: li.price?.unit_amount || 0,
        currency: (li.price?.currency || session.currency || 'gbp').toLowerCase()
      }
    }));

    return res.json({
      id: session.id,
      status: session.payment_status || session.status || 'created',
      amount_total: session.amount_total || 0,
      currency: (session.currency || 'gbp').toLowerCase(),
      created: session.created,
      email: session.customer_details?.email || '',
      pricing: { lines }
    });
  } catch (e) {
    console.error('[orders] fetch failed:', e?.message || e);
    return res.status(400).json({ error: 'ORDER_LOOKUP_FAILED' });
  }
});

// Optional helper: /session/:id -> redirect to Checkout (handy if frontend only gets an id)
app.get('/session/:id', async (req, res) => {
  try {
    const s = await stripe.checkout.sessions.retrieve(req.params.id);
    if (s && s.url) return res.redirect(s.url);
    return res.status(404).send('Session not found');
  } catch (e) {
    return res.status(400).send('Invalid session');
  }
});

// ---- Webhook ----
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET || '');
  } catch (err) {
    console.error('[webhook] signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        console.log('✅ checkout.session.completed', session.id);

        // Pull details to email customer
        const customerEmail = session.customer_details?.email || session.customer_email;
        const amountTotal = session.amount_total;
        const currency = session.currency;

        // Optionally fetch line items (requires expand or separate API call)
        let lineItems = [];
        try {
          const items = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100 });
          lineItems = items.data || [];
        } catch (e) {
          console.warn('[webhook] listLineItems failed:', e.message);
        }

        await sendOrderEmail({
          to: customerEmail,
          orderId: session.id,
          amountTotal,
          currency,
          lineItems,
          created: session.created
        });

        break;
      }

      case 'payment_intent.succeeded': {
        const intent = event.data.object;
        console.log('💰 payment_intent.succeeded', intent.id, intent.amount);
        break;
      }

      case 'payment_intent.payment_failed': {
        const intent = event.data.object;
        console.warn('❌ payment_intent.payment_failed', intent.id, intent.last_payment_error?.message);
        break;
      }

      case 'charge.refunded': {
        const charge = event.data.object;
        console.log('↩️ charge.refunded', charge.id, charge.amount_refunded);
        break;
      }

      default:
        break;
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[webhook] handler error:', err);
    res.status(500).json({ ok: false });
  }
});

// ----- Start -----
const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`NVRBRTH server running on ${PORT}`);
});