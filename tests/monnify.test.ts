import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTests } from '../src/config/index.js';
import {
    authorizeTransfer,
    getBanks,
    initializeCheckout,
    initiateTransfer,
    resetMonnifyTokenForTests,
    validateAccount,
    verifyPayment,
} from '../src/services/monnify.service.js';

function envelope(body: unknown, successful = true) {
    return {
        requestSuccessful: successful,
        responseMessage: successful ? 'success' : 'failed',
        responseCode: '0',
        responseBody: body,
    };
}

function jsonResponse(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('Monnify mock mode', () => {
    beforeEach(() => {
        process.env.MONNIFY_MODE = 'mock';
        process.env.MONNIFY_DISBURSEMENTS_ENABLED = 'false';
        process.env.MONNIFY_MFA_ENABLED = 'true';
        resetConfigForTests();
        resetMonnifyTokenForTests();
    });

    it('creates a local checkout URL without touching the network', async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);

        const result = await initializeCheckout({
            amountKobo: 500_000,
            paymentReference: 'INV-1',
            customerName: 'Ada',
            customerEmail: 'ada@example.com',
            description: 'Test',
        });

        expect(result.checkoutUrl).toBe('https://nett-test.example.com/demo/pay/INV-1');
        expect(fetchSpy).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    it('validates a mock bank account', async () => {
        const result = await validateAccount('0123456789', '057');
        expect(result.accountName).toContain('6789');
    });

    it('rejects invalid mock account numbers', async () => {
        await expect(validateAccount('123', '057')).rejects.toThrow('10 digits');
    });

    it('keeps a payout ready when disbursement is disabled', async () => {
        const result = await initiateTransfer({
            amountKobo: 500_000,
            reference: 'EXP-1',
            narration: 'Test',
            bankCode: '057',
            accountNumber: '0123456789',
            accountName: 'TEST USER',
        });
        expect(result.status).toBe('READY_FOR_PAYOUT');
    });

    it('asks for OTP when disbursement is enabled and MFA is on', async () => {
        process.env.MONNIFY_DISBURSEMENTS_ENABLED = 'true';
        resetConfigForTests();

        const result = await initiateTransfer({
            amountKobo: 500_000,
            reference: 'EXP-2',
            narration: 'Test',
            bankCode: '057',
            accountNumber: '0123456789',
            accountName: 'TEST USER',
        });
        expect(result.status).toBe('PENDING_AUTHORIZATION');
    });

    it('accepts any six-digit OTP', async () => {
        const result = await authorizeTransfer('EXP-2', '123456');
        expect(result.status).toBe('SUCCESS');
        await expect(authorizeTransfer('EXP-2', 'abc')).rejects.toThrow('six-digit');
    });

    it('returns a static bank list', async () => {
        const banks = await getBanks();
        expect(banks.length).toBeGreaterThan(0);
    });
});

describe('Monnify sandbox mode', () => {
    beforeEach(() => {
        process.env.MONNIFY_MODE = 'sandbox';
        process.env.MONNIFY_API_KEY = 'MK_TEST_KEY';
        process.env.MONNIFY_SECRET_KEY = 'TEST_SECRET';
        process.env.MONNIFY_CONTRACT_CODE = '1234567890';
        resetConfigForTests();
        resetMonnifyTokenForTests();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        delete process.env.MONNIFY_API_KEY;
        delete process.env.MONNIFY_SECRET_KEY;
        delete process.env.MONNIFY_CONTRACT_CODE;
        process.env.MONNIFY_MODE = 'mock';
        resetConfigForTests();
    });

    it('logs in once and reuses the cached token', async () => {
        const fetchSpy = vi.fn(async (url: string | URL | Request) => {
            const address = String(url);
            if (address.includes('/auth/login')) {
                return jsonResponse(envelope({ accessToken: 'token-1', expiresIn: 3600 }));
            }
            return jsonResponse(envelope([{ name: 'GTBank', code: '058' }]));
        });
        vi.stubGlobal('fetch', fetchSpy);

        await getBanks();
        await getBanks();

        const loginCalls = fetchSpy.mock.calls.filter((call) => String(call[0]).includes('/auth/login'));
        expect(loginCalls.length).toBe(1);
    });

    it('logs in again after the token expires', async () => {
        const fetchSpy = vi.fn(async (url: string | URL | Request) => {
            const address = String(url);
            if (address.includes('/auth/login')) {
                return jsonResponse(envelope({ accessToken: 'short-token', expiresIn: 1 }));
            }
            return jsonResponse(envelope([]));
        });
        vi.stubGlobal('fetch', fetchSpy);

        await getBanks();
        await getBanks();

        const loginCalls = fetchSpy.mock.calls.filter((call) => String(call[0]).includes('/auth/login'));
        expect(loginCalls.length).toBe(2);
    });

    it('throws a clear error when authentication fails', async () => {
        const fetchSpy = vi.fn(async () => {
            return jsonResponse(envelope(null, false), 401);
        });
        vi.stubGlobal('fetch', fetchSpy);

        await expect(getBanks()).rejects.toThrow('Monnify authentication failed');
    });

    it('throws a clear error on a non-JSON response', async () => {
        const fetchSpy = vi.fn(async (url: string | URL | Request) => {
            const address = String(url);
            if (address.includes('/auth/login')) {
                return jsonResponse(envelope({ accessToken: 'token-1', expiresIn: 3600 }));
            }
            return new Response('<html>Bad Gateway</html>', { status: 502 });
        });
        vi.stubGlobal('fetch', fetchSpy);

        await expect(getBanks()).rejects.toThrow('non-JSON');
    });

    it('converts naira responses to kobo on verification', async () => {
        const fetchSpy = vi.fn(async (url: string | URL | Request) => {
            const address = String(url);
            if (address.includes('/auth/login')) {
                return jsonResponse(envelope({ accessToken: 'token-1', expiresIn: 3600 }));
            }
            return jsonResponse(
                envelope({
                    paymentReference: 'INV-9',
                    transactionReference: 'MNFY-9',
                    amountPaid: 5000,
                    totalPayable: 5000,
                    settlementAmount: 4950.5,
                    paymentStatus: 'PAID',
                }),
            );
        });
        vi.stubGlobal('fetch', fetchSpy);

        const result = await verifyPayment('INV-9');
        expect(result.amountPaidKobo).toBe(500_000);
        expect(result.settlementAmountKobo).toBe(495_050);
    });
});
