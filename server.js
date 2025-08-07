// server.js
// NVRBRTH backend — Checkout + Webhooks + Orders + Inventory (minimalistic)

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// ⚠️ DO NOT hardcode secrets — use env vars
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY; // set on Render
const Stripe = require('stripe');
const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

const app = express();
const PORT = process.env.PORT || 5000;

// ----- Middleware -----
// CORS: allow your frontend origins
app.use(cors({
  origin: [
    'https://nvrbrth.store',
    'http://localhost:3000',
    'http://127.0.0.1:3000'
  ],
  credentials: false
}));

// NOTE: Webhooks need raw body. We add JSON parser AFTER mounting webhook route.
app.get('/', (_req, res) => res.send('✅ NVRBRTH backend is alive and kicking'));

// ---------- INVENTORY / PRICING (server-side authority) ----------
// productId -> price/name (unit_amount in pence)
const PRICE_MAP = {
  // EXAMPLES — change to your real variants
  'skinlock_ss_black_s': { name: 'SKINLOCK SS Tee — Black — S', unit_amount: 3500, currency: 'gbp' },
  'skinlock_ss_black_m': { name: 'SKINLOCK SS Tee — Black — M', unit_amount: 3500, currency: 'gbp' },
  'skinlock_ss_black_l': { name: 'SKINLOCK SS Tee — Black — L', unit_amount: 3500, currency: 'gbp' },
  'skinlock_ls_comp_m' : { name: 'SKINLOCK LS Compression — M',  unit_amount: 5200, currency: 'gbp' },
};

// super simple stock tracker (optional). If you don’t want stock control, remove this.
const STOCK = {
  'skinlock_ss_black_s': 10,
  'skinlock_ss_black_m': 10,
  'skinlock_ss_black_l': 10,
  'skinlock_ls_comp_m' : 5,
};

// helper: clamp quantity and check stock
function makeLineItems(cart) {
  if (!Array.isArray(cart) || cart.length === 0) throw new Error('Cart empty');
  return cart.map(({ productId, quantity }) => {
    const p = PRICE_MAP[productId];
    if (!p) throw new Error(`Unknown productId: ${productId}`);
    const q = Math.max(1, Math.min(Number(quantity) || 1, 10));
    if (STOCK[productId] !== undefined && STOCK[productId] <= 0) {
      throw new Error(`Out of stock: ${productId}`);
    }
    return {
      price_data: {
        currency: p.currency,
        product_data: { name: p.name },
        unit_amount: p.unit_amount,
      },
      quantity: q,
    };
  });
}

// ---------- WEBHOOK (MOUNT BEFORE JSON PARSER) ----------
const WEBHOOK_PATH = '/webhooks/stripe';
app.post(WEBHOOK_PATH, express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET; // set from Stripe Dashboard/CLI

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('❌ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      // fetch line items to save detailed order (descriptions/prices)
      const items = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100 });

      // decrement stock (best-effort)
      try {
        items.data.forEach(li => {
          // Find productId from our metadata cart if present
          // We stored cart JSON in session.metadata.cart
          // If not present, do a best-effort name match (not ideal)
        });
        // If you stored cart in metadata (we do below), use it to decrement precisely:
        if (session.metadata?.cart) {
          const cart = JSON.parse(session.metadata.cart);
          cart.forEach(({ productId, quantity }) => {
            if (STOCK[productId] !== undefined) {
              STOCK[productId] = Math.max(0, STOCK[productId] - (Number(quantity) || 1));
            }
          });
        }
      } catch (e) {
        console.warn('⚠️ Stock decrement issue:', e.message);
      }

      const record = {
        id: session.id,
        payment_status: session.payment_status,
        amount_total: session.amount_total,
        currency: session.currency,
        customer_email: session.customer_details?.email || session.customer_email,
        shipping: session.shipping_details || null,
        metadata: session.metadata || {},
        line_items: items.data.map(i => ({
          description: i.description,
          quantity: i.quantity,
          amount_subtotal: i.amount_subtotal,
          amount_total: i.amount_total
        })),
        created: Date.now()
      };

      fs.appendFileSync(path.join(process.cwd(), 'orders.json'), JSON.stringify(record) + '\n');
      console.log('✅ Order saved:', record.id);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('❌ Webhook handler error:', err);
    res.status(500).send('Webhook handler error');
  }
});

// ---------- JSON PARSER AFTER WEBHOOK ----------
app.use(express.json());

// ---------- CHECKOUT (dynamic from cart) ----------
app.post('/api/checkout', async (req, res) => {
  try {
    const { cart, customer_email } = req.body;

    const line_items = makeLineItems(cart);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email,
      line_items,
      shipping_address_collection: { allowed_countries: ['GB','IE','US','CA','AU','NZ','DE','FR','ES','IT','NL','SE'] },
      allow_promotion_codes: true,
      success_url: 'https://nvrbrth.store/thankyou.html?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://nvrbrth.store/basket.html?canceled=1',
      // keep a compact copy of the original cart to reconcile later
      metadata: { cart: JSON.stringify(cart || []) },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('checkout error:', err.message);
    res.status(400).json({ error: err.message || 'Failed to create session' });
  }
});

// ---------- SINGLE-ITEM CHECKOUT (legacy demo; keep if you want) ----------
app.post('/api/create-checkout-session', async (_req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'gbp',
          product_data: { name: 'HOST_001 Tee' },
          unit_amount: 3500,
        },
        quantity: 1,
      }],
      success_url: 'https://nvrbrth.store/thankyou.html?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://nvrbrth.store/basket.html',
    });
    res.json({ url: session.url });
  } catch (error) {
    console.error('❌ Stripe error:', error);
    res.status(500).json({ error: 'Stripe session creation failed' });
  }
});

// ---------- ORDER SUMMARY (for thank-you page) ----------
app.get('/api/order-summary/:sessionId', async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['line_items'] });
    res.json({
      id: session.id,
      status: session.payment_status,
      email: session.customer_details?.email || session.customer_email,
      amount_total: session.amount_total,
      currency: session.currency,
      shipping: session.shipping_details || null,
      line_items: (session.line_items?.data || []).map(i => ({
        description: i.description, quantity: i.quantity, amount_total: i.amount_total
      }))
    });
  } catch (e) {
    res.status(404).json({ error: 'Order not found' });
  }
});

// ---------- DEV HELPERS ----------
app.get('/api/stock', (_req, res) => res.json(STOCK));
app.get('/api/prices', (_req, res) => res.json(PRICE_MAP));

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
