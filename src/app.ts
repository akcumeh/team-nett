import express, { type Request, type Response } from 'express';
import { getConfig } from './config/index.js';
import { verifyMonnifySignature } from './utils/security.js';
import { processMonnifyWebhook } from './services/webhook.service.js';
import * as invoiceRepo from './repositories/invoice.repository.js';
import { markMockInvoicePaid } from './controllers/telegram.controller.js';
import { escapeHtml, money } from './utils/format.js';

function page(title: string, body: string): string {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;background:#f4f6f8;margin:0;padding:32px;color:#17202a}.card{max-width:620px;margin:auto;background:white;border-radius:16px;padding:28px;box-shadow:0 8px 30px rgba(0,0,0,.08)}h1{margin-top:0}.button{display:inline-block;background:#111827;color:white;padding:14px 20px;border:0;border-radius:10px;text-decoration:none;font-weight:700;cursor:pointer}.muted{color:#667085}.banner{background:#fff4ce;padding:12px;border-radius:8px;margin-bottom:20px}</style></head><body><main class="card">${body}</main></body></html>`;
}

export function createApp(): express.Express {
    const app = express();
    app.disable('x-powered-by');

    app.get('/health', (req: Request, res: Response) => {
        const config = getConfig();
        res.json({ ok: true, service: 'nett-finance-room', monnifyMode: config.monnify.mode });
    });

    app.get('/payment/return', (req: Request, res: Response) => {
        res.type('html').send(
            page(
                'Payment received',
                '<h1>Payment submitted</h1><p>NETT will verify the payment with Monnify and update your Telegram finance room. You can close this page.</p>',
            ),
        );
    });

    app.get('/demo/pay/:ref', async (req: Request, res: Response) => {
        const config = getConfig();
        if (config.monnify.mode !== 'mock') {
            return res.status(404).send('not found');
        }
        const ref = String(req.params.ref);
        const invoice = await invoiceRepo.findByRef(ref);
        if (!invoice) {
            return res.status(404).type('html').send(page('Invoice not found', '<h1>Invoice not found</h1>'));
        }
        res.type('html').send(
            page(
                'NETT Demo Payment',
                `<div class="banner">SANDBOX DEMO. NO REAL MONEY WILL MOVE.</div><h1>${escapeHtml(invoice.customer_name)}</h1><p>${escapeHtml(invoice.description)}</p><h2>${money(invoice.amount_kobo)}</h2><p class="muted">Reference: ${escapeHtml(invoice.ref)}</p><form method="post"><button class="button" type="submit">Simulate successful Monnify payment</button></form>`,
            ),
        );
    });

    app.post('/demo/pay/:ref', async (req: Request, res: Response) => {
        const config = getConfig();
        if (config.monnify.mode !== 'mock') {
            return res.status(404).send('not found');
        }
        const ref = String(req.params.ref);
        const invoice = await invoiceRepo.findByRef(ref);
        if (!invoice) {
            return res.status(404).type('html').send(page('Invoice not found', '<h1>Invoice not found</h1>'));
        }
        await markMockInvoicePaid(ref);
        res.type('html').send(
            page(
                'Payment simulated',
                `<div class="banner">SANDBOX DEMO</div><h1>Payment confirmed</h1><p>${escapeHtml(invoice.ref)} has been marked paid in the NETT demo.</p><p>Return to Telegram to see the finance room update.</p>`,
            ),
        );
    });

    // Raw body capture must come before any JSON parsing: the Monnify signature
    // is computed over the exact bytes sent, so a re-serialized body would never match.
    app.post(
        '/webhooks/monnify',
        express.raw({ type: '*/*', limit: '1mb' }),
        async (req: Request, res: Response) => {
            const config = getConfig();
            if (!config.monnify.secretKey) {
                return res.status(503).send('Monnify secret is not configured.');
            }

            const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body ?? '');
            const header = req.headers['monnify-signature'];
            let supplied: string | undefined;
            if (Array.isArray(header)) {
                supplied = header[0];
            } else {
                supplied = header;
            }

            const valid = verifyMonnifySignature(
                rawBody,
                supplied,
                config.monnify.secretKey,
                config.monnify.webhookSignatureMode,
            );
            if (!valid) {
                return res.status(401).send('Invalid signature.');
            }

            let payload: unknown;
            try {
                payload = JSON.parse(rawBody);
            } catch {
                return res.status(400).send('Invalid JSON.');
            }

            try {
                await processMonnifyWebhook(payload, rawBody);
                res.status(200).send('processed');
            } catch (error) {
                console.error('Monnify webhook processing failed:', error);
                res.status(500).send('processing failed');
            }
        },
    );

    return app;
}
