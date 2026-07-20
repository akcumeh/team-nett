import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/repositories/webhook.repository.js');
vi.mock('../src/repositories/expense.repository.js');
vi.mock('../src/repositories/company.repository.js');
vi.mock('../src/repositories/audit.repository.js');
vi.mock('../src/services/invoice.service.js');
vi.mock('../src/services/telegram.service.js');

import * as webhookRepo from '../src/repositories/webhook.repository.js';
import * as companyRepo from '../src/repositories/company.repository.js';
import * as invoiceService from '../src/services/invoice.service.js';
import { processMonnifyWebhook } from '../src/services/webhook.service.js';

const payload = {
    eventType: 'SUCCESSFUL_TRANSACTION',
    eventData: {
        paymentReference: 'INV-TEST-1',
        paymentStatus: 'PAID',
        amountPaid: 5000,
        settlementAmount: 4950,
        transactionReference: 'MNFY-1',
    },
};

beforeEach(() => {
    vi.resetAllMocks();
});

describe('processMonnifyWebhook', () => {
    it('drops a duplicate delivery before touching any state', async () => {
        vi.mocked(webhookRepo.claim).mockResolvedValue(false);

        await processMonnifyWebhook(payload, JSON.stringify(payload));

        expect(invoiceService.applyProviderPayment).not.toHaveBeenCalled();
        expect(webhookRepo.finish).not.toHaveBeenCalled();
    });

    it('processes a first delivery and converts naira to kobo', async () => {
        vi.mocked(webhookRepo.claim).mockResolvedValue(true);
        vi.mocked(invoiceService.applyProviderPayment).mockResolvedValue(null);

        await processMonnifyWebhook(payload, JSON.stringify(payload));

        expect(invoiceService.applyProviderPayment).toHaveBeenCalledWith(
            expect.objectContaining({
                ref: 'INV-TEST-1',
                amountPaidKobo: 500_000,
                settlementAmountKobo: 495_000,
            }),
        );
        expect(webhookRepo.finish).toHaveBeenCalledWith('SUCCESSFUL_TRANSACTION:INV-TEST-1');
    });

    it('records the error and rethrows when processing fails', async () => {
        vi.mocked(webhookRepo.claim).mockResolvedValue(true);
        vi.mocked(invoiceService.applyProviderPayment).mockRejectedValue(new Error('db down'));

        await expect(processMonnifyWebhook(payload, JSON.stringify(payload))).rejects.toThrow('db down');
        expect(webhookRepo.finish).toHaveBeenCalledWith('SUCCESSFUL_TRANSACTION:INV-TEST-1', 'db down');
    });

    it('ignores events with no matching invoice', async () => {
        vi.mocked(webhookRepo.claim).mockResolvedValue(true);
        vi.mocked(invoiceService.applyProviderPayment).mockResolvedValue(null);

        await processMonnifyWebhook(payload, JSON.stringify(payload));

        expect(companyRepo.findById).not.toHaveBeenCalled();
    });
});
