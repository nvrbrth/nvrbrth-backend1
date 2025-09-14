# NVRBRTH Stripe Backend (Render)

Production-ready minimal Express server for Stripe Checkout.

## Endpoints
- `GET /ping` – healthcheck -> `{ ok: true }`
- `POST /create-checkout-session`
  - Body: `{ items: [{ price | lookup_key | sku, quantity }], success_url, cancel_url, mode?, customer_email? }`
  - Returns: `{ id, url }` – you can use either `stripe.redirectToCheckout({ sessionId: id })` or `window.location = url`.

- `POST /webhook` – Stripe webhook (raw body). Add this URL to Stripe Dashboard **LIVE**:  
  `https://<your-render-service>.onrender.com/webhook`

## Env Vars (Render)
- `STRIPE_SECRET_KEY` – Live secret key (sk_live_…)
- `STRIPE_WEBHOOK_SECRET` – Live webhook signing secret (whsec_…)
- `ALLOWED_ORIGINS` – comma-separated list of full origins (no trailing slashes):
  `https://nvrbrth.store,https://legendary-sunflower-10d7b9.netlify.app,http://localhost:5173,http://localhost:3000`
- `FRONTEND_BASE_URL` – e.g., `https://nvrbrth.store`

## CORS
One allow-list env var powers both preflight and requests. If you change domains, update this and redeploy.

## Items format
Each item may include **one** of:
- `price`: a Stripe price id (`price_…`)
- `lookup_key`: a Stripe price lookup key (e.g., `host001_compression_vein001`)
- `sku`: a friendly local key which maps internally to the lookup key (e.g., `vein-001`, `skinlock-exe`, `nullvoid-001`).

## Start locally
```
npm i
cp .env.sample .env   # fill in keys
node server.js
```
