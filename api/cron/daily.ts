import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getConfig } from '../../src/config/index.js';
import { verifyTelegramSecret } from '../../src/utils/security.js';
import * as companyRepo from '../../src/repositories/company.repository.js';
import * as invoiceRepo from '../../src/repositories/invoice.repository.js';
import { renderDashboard } from '../../src/services/finance.service.js';
import { push } from '../../src/services/telegram.service.js';
import { money } from '../../src/utils/format.js';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    const config = getConfig();

    const header = req.headers.authorization ?? '';
    const expected = `Bearer ${config.cronSecret}`;
    if (!verifyTelegramSecret(header, expected)) {
        res.status(401).send('unauthorized');
        return;
    }

    const today = new Date().toISOString().slice(0, 10);
    const companies = await companyRepo.listLinkedCompanies();
    let sent = 0;

    for (const company of companies) {
        if (!company.telegram_chat_id) {
            continue;
        }
        if (company.last_digest_date === today) {
            continue;
        }

        let digest = await renderDashboard(company);

        const pending = await invoiceRepo.pending(company.id);
        const now = new Date();
        const overdue = pending.filter((invoice) => {
            if (!invoice.due_at) {
                return false;
            }
            return new Date(invoice.due_at) < now;
        });
        if (overdue.length > 0) {
            const lines = overdue.map((invoice) => {
                return `${invoice.ref} · ${invoice.customer_name} · ${money(invoice.amount_kobo)}`;
            });
            digest = `${digest}\n\nOVERDUE INVOICES\n${lines.join('\n')}`;
        }

        await push(company.telegram_chat_id, digest);
        await companyRepo.markDigestSent(company.id, today);
        sent = sent + 1;
    }

    res.json({ ok: true, digestsSent: sent });
}
