import { createApp } from '../src/app.js';

// Express handles these routes: /health, /payment/return, /demo/pay/:ref,
// and POST /webhooks/monnify. Exporting the app keeps the request stream
// unconsumed so the webhook route can capture the raw body for signatures.
export default createApp();
