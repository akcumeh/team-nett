import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExpenseRequest } from '../src/types/domain.js';

vi.mock('../src/repositories/expense.repository.js');
vi.mock('../src/repositories/company.repository.js');
vi.mock('../src/repositories/vendor.repository.js');
vi.mock('../src/repositories/audit.repository.js');
vi.mock('../src/services/monnify.service.js');

import * as expenseRepo from '../src/repositories/expense.repository.js';
import * as vendorRepo from '../src/repositories/vendor.repository.js';
import { initiateTransfer } from '../src/services/monnify.service.js';
import { decide, pay } from '../src/services/request.service.js';

function makeRequest(overrides: Partial<ExpenseRequest> = {}): ExpenseRequest {
    return {
        id: 'req-1',
        ref: 'EXP-TEST-1',
        company_id: 'company-a',
        requester_user_id: 'user-requester',
        vendor_id: 'vendor-1',
        amount_kobo: 500_000,
        currency: 'NGN',
        purpose: 'Office chairs',
        category: 'General',
        invoice_file_id: null,
        status: 'PENDING_APPROVAL',
        required_approvals: 2,
        monnify_reference: null,
        monnify_status: null,
        paid_at: null,
        created_at: new Date().toISOString(),
        ...overrides,
    };
}

beforeEach(() => {
    vi.resetAllMocks();
});

describe('decide', () => {
    it('rejects a ref that belongs to another company', async () => {
        vi.mocked(expenseRepo.findByRef).mockResolvedValue(makeRequest({ company_id: 'company-a' }));

        await expect(
            decide({
                ref: 'EXP-TEST-1',
                companyId: 'company-b',
                userId: 'user-2',
                decision: 'APPROVED',
                role: 'admin',
            }),
        ).rejects.toThrow('not found');

        expect(expenseRepo.recordDecision).not.toHaveBeenCalled();
    });

    it('blocks self-approval for non-owners', async () => {
        vi.mocked(expenseRepo.findByRef).mockResolvedValue(makeRequest());

        await expect(
            decide({
                ref: 'EXP-TEST-1',
                companyId: 'company-a',
                userId: 'user-requester',
                decision: 'APPROVED',
                role: 'approver',
            }),
        ).rejects.toThrow('your own request');
    });

    it('blocks roles that cannot approve', async () => {
        await expect(
            decide({
                ref: 'EXP-TEST-1',
                companyId: 'company-a',
                userId: 'user-2',
                decision: 'APPROVED',
                role: 'requester',
            }),
        ).rejects.toThrow('cannot approve');
    });

    it('keeps the request pending below the approval threshold', async () => {
        vi.mocked(expenseRepo.findByRef).mockResolvedValue(makeRequest());
        vi.mocked(expenseRepo.countApproved).mockResolvedValue(1);

        const result = await decide({
            ref: 'EXP-TEST-1',
            companyId: 'company-a',
            userId: 'user-2',
            decision: 'APPROVED',
            role: 'approver',
        });

        expect(result.request.status).toBe('PENDING_APPROVAL');
        expect(expenseRepo.transition).not.toHaveBeenCalled();
    });

    it('moves to APPROVED once the threshold is met', async () => {
        vi.mocked(expenseRepo.findByRef).mockResolvedValue(makeRequest());
        vi.mocked(expenseRepo.countApproved).mockResolvedValue(2);
        vi.mocked(expenseRepo.transition).mockResolvedValue(makeRequest({ status: 'APPROVED' }));

        const result = await decide({
            ref: 'EXP-TEST-1',
            companyId: 'company-a',
            userId: 'user-2',
            decision: 'APPROVED',
            role: 'approver',
        });

        expect(result.request.status).toBe('APPROVED');
        expect(expenseRepo.transition).toHaveBeenCalledWith(
            'EXP-TEST-1',
            'company-a',
            ['PENDING_APPROVAL'],
            'APPROVED',
        );
    });
});

describe('pay', () => {
    it('rejects a ref that belongs to another company', async () => {
        vi.mocked(expenseRepo.findByRef).mockResolvedValue(makeRequest({ status: 'APPROVED' }));

        await expect(
            pay({ ref: 'EXP-TEST-1', companyId: 'company-b', userId: 'user-1', role: 'admin' }),
        ).rejects.toThrow('not found');

        expect(initiateTransfer).not.toHaveBeenCalled();
    });

    it('stops when another admin already claimed the payment', async () => {
        vi.mocked(expenseRepo.findByRef).mockResolvedValue(makeRequest({ status: 'APPROVED' }));
        vi.mocked(vendorRepo.findById).mockResolvedValue({
            id: 'vendor-1',
            company_id: 'company-a',
            nickname: 'chairs',
            legal_name: 'Chairs Ltd',
            bank_code: '058',
            bank_name: 'GTBank',
            account_number: '0123456789',
            account_name: 'CHAIRS LTD',
            verified: true,
            verification_source: 'manual',
            created_by: 'user-1',
            created_at: new Date().toISOString(),
        });
        vi.mocked(expenseRepo.transition).mockResolvedValue(null);

        await expect(
            pay({ ref: 'EXP-TEST-1', companyId: 'company-a', userId: 'user-1', role: 'admin' }),
        ).rejects.toThrow('already being processed');

        expect(initiateTransfer).not.toHaveBeenCalled();
    });

    it('pays out when the claim succeeds and the provider says SUCCESS', async () => {
        const approved = makeRequest({ status: 'APPROVED' });
        vi.mocked(expenseRepo.findByRef).mockResolvedValue(approved);
        vi.mocked(vendorRepo.findById).mockResolvedValue({
            id: 'vendor-1',
            company_id: 'company-a',
            nickname: 'chairs',
            legal_name: 'Chairs Ltd',
            bank_code: '058',
            bank_name: 'GTBank',
            account_number: '0123456789',
            account_name: 'CHAIRS LTD',
            verified: true,
            verification_source: 'manual',
            created_by: 'user-1',
            created_at: new Date().toISOString(),
        });
        vi.mocked(expenseRepo.transition)
            .mockResolvedValueOnce(makeRequest({ status: 'PROCESSING' }))
            .mockResolvedValueOnce(makeRequest({ status: 'PAID' }));
        vi.mocked(initiateTransfer).mockResolvedValue({
            amountKobo: 500_000,
            reference: 'EXP-TEST-1',
            status: 'SUCCESS',
        });

        const result = await pay({
            ref: 'EXP-TEST-1',
            companyId: 'company-a',
            userId: 'user-1',
            role: 'admin',
        });

        expect(result.status).toBe('PAID');
        expect(initiateTransfer).toHaveBeenCalledOnce();
    });

    it('blocks roles that cannot pay', async () => {
        await expect(
            pay({ ref: 'EXP-TEST-1', companyId: 'company-a', userId: 'user-1', role: 'approver' }),
        ).rejects.toThrow('owner or admin');
    });
});
