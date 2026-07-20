import { getConfig } from '../config/index.js';
import type {
    MonnifyAccountValidation,
    MonnifyBank,
    MonnifyCheckout,
    MonnifyEnvelope,
    MonnifyTransferResult,
    MonnifyVerification,
} from '../types/monnify.js';
import { UserFacingError } from '../utils/errors.js';

let tokenCache: { token: string; expiresAt: number } | null = null;

function koboToNaira(kobo: number): number {
    return kobo / 100;
}

function nairaToKobo(naira: number): number {
    return Math.round(naira * 100);
}

async function authenticate(): Promise<string> {
    const c = getConfig();
    if (c.monnify.mode === 'mock') {
        return 'mock-token';
    }
    if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
        return tokenCache.token;
    }

    const credentials = Buffer.from(`${c.monnify.apiKey}:${c.monnify.secretKey}`).toString('base64');
    const response = await fetch(`${c.monnify.baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/json' },
    });

    const json = (await response.json()) as MonnifyEnvelope<{ accessToken: string; expiresIn: number }>;
    if (!response.ok || !json.requestSuccessful || !json.responseBody?.accessToken) {
        throw new Error(`Monnify authentication failed: ${json.responseMessage ?? response.statusText}`);
    }

    const lifetimeSeconds = Number(json.responseBody.expiresIn ?? 3600);
    tokenCache = {
        token: json.responseBody.accessToken,
        expiresAt: Date.now() + lifetimeSeconds * 1000,
    };
    return tokenCache.token;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const c = getConfig();
    const token = await authenticate();
    const response = await fetch(`${c.monnify.baseUrl}${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(init.headers ?? {}),
        },
    });

    const text = await response.text();
    let json: MonnifyEnvelope<T>;
    try {
        json = JSON.parse(text) as MonnifyEnvelope<T>;
    } catch {
        throw new Error(`Monnify returned non-JSON (${response.status}): ${text.slice(0, 300)}`);
    }

    if (!response.ok || !json.requestSuccessful) {
        throw new UserFacingError(`Monnify request failed: ${json.responseMessage || response.statusText}`);
    }
    return json.responseBody;
}

export function isMockMode(): boolean {
    return getConfig().monnify.mode === 'mock';
}

export async function initializeCheckout(input: {
    amountKobo: number;
    paymentReference: string;
    customerName: string;
    customerEmail: string;
    description: string;
}): Promise<MonnifyCheckout> {
    const c = getConfig();
    if (c.monnify.mode === 'mock') {
        return {
            transactionReference: `MOCK-${input.paymentReference}`,
            paymentReference: input.paymentReference,
            checkoutUrl: `${c.publicBaseUrl}/demo/pay/${encodeURIComponent(input.paymentReference)}`,
        };
    }

    const body = await request<MonnifyCheckout>('/api/v1/merchant/transactions/init-transaction', {
        method: 'POST',
        body: JSON.stringify({
            amount: koboToNaira(input.amountKobo),
            customerName: input.customerName,
            customerEmail: input.customerEmail,
            paymentReference: input.paymentReference,
            paymentDescription: input.description,
            currencyCode: 'NGN',
            contractCode: c.monnify.contractCode,
            redirectUrl: `${c.publicBaseUrl}/payment/return`,
            paymentMethods: ['ACCOUNT_TRANSFER', 'CARD', 'USSD'],
        }),
    });

    if (!body.checkoutUrl || !body.transactionReference) {
        throw new Error('Monnify did not return checkout details.');
    }
    return body;
}

interface RawVerification {
    paymentReference: string;
    transactionReference: string;
    amountPaid: number;
    totalPayable: number;
    settlementAmount: number;
    paymentStatus: string;
    paymentMethod?: string;
    paidOn?: string;
    customerName?: string;
    customerEmail?: string;
}

export async function verifyPayment(paymentReference: string): Promise<MonnifyVerification> {
    const c = getConfig();
    if (c.monnify.mode === 'mock') {
        throw new Error('Mock payment verification is handled by the local demo endpoint.');
    }

    const raw = await request<RawVerification>(
        `/api/v2/merchant/transactions/query?paymentReference=${encodeURIComponent(paymentReference)}`,
    );
    return {
        paymentReference: raw.paymentReference,
        transactionReference: raw.transactionReference,
        amountPaidKobo: nairaToKobo(Number(raw.amountPaid ?? 0)),
        totalPayableKobo: nairaToKobo(Number(raw.totalPayable ?? 0)),
        settlementAmountKobo: nairaToKobo(Number(raw.settlementAmount ?? 0)),
        paymentStatus: raw.paymentStatus,
        paymentMethod: raw.paymentMethod,
        paidOn: raw.paidOn,
        customerName: raw.customerName,
        customerEmail: raw.customerEmail,
    };
}

export async function validateAccount(
    accountNumber: string,
    bankCode: string,
): Promise<MonnifyAccountValidation> {
    const c = getConfig();
    if (c.monnify.mode === 'mock') {
        if (!/^\d{10}$/.test(accountNumber)) {
            throw new UserFacingError('The account number must contain exactly 10 digits.');
        }
        return {
            accountNumber,
            accountName: `NETT SANDBOX ACCOUNT ${accountNumber.slice(-4)}`,
            bankCode,
        };
    }
    return request<MonnifyAccountValidation>(
        `/api/v2/disbursements/account/validate?accountNumber=${encodeURIComponent(accountNumber)}&bankCode=${encodeURIComponent(bankCode)}`,
    );
}

interface RawTransferResult {
    amount: number;
    reference: string;
    status: string;
    dateCreated?: string;
    destinationAccountName?: string;
    destinationBankName?: string;
    destinationAccountNumber?: string;
    responseMessage?: string;
}

function toTransferResult(raw: RawTransferResult): MonnifyTransferResult {
    return {
        amountKobo: nairaToKobo(Number(raw.amount ?? 0)),
        reference: raw.reference,
        status: raw.status,
        dateCreated: raw.dateCreated,
        destinationAccountName: raw.destinationAccountName,
        destinationBankName: raw.destinationBankName,
        destinationAccountNumber: raw.destinationAccountNumber,
        responseMessage: raw.responseMessage,
    };
}

export async function initiateTransfer(input: {
    amountKobo: number;
    reference: string;
    narration: string;
    bankCode: string;
    accountNumber: string;
    accountName: string;
}): Promise<MonnifyTransferResult> {
    const c = getConfig();

    if (!c.monnify.disbursementsEnabled) {
        return {
            amountKobo: input.amountKobo,
            reference: input.reference,
            status: 'READY_FOR_PAYOUT',
            destinationAccountName: input.accountName,
            destinationAccountNumber: input.accountNumber,
            responseMessage:
                'Disbursement is not enabled. Request Monnify sandbox activation, then set MONNIFY_DISBURSEMENTS_ENABLED=true.',
        };
    }

    if (c.monnify.mode === 'mock') {
        let status = 'SUCCESS';
        if (c.monnify.mfaEnabled) {
            status = 'PENDING_AUTHORIZATION';
        }
        return {
            amountKobo: input.amountKobo,
            reference: input.reference,
            status,
            destinationAccountName: input.accountName,
            destinationAccountNumber: input.accountNumber,
            responseMessage: 'Mock transfer accepted.',
        };
    }

    if (!c.monnify.walletAccount) {
        throw new UserFacingError('MONNIFY_WALLET_ACCOUNT is required for payouts.');
    }

    const raw = await request<RawTransferResult>('/api/v2/disbursements/single', {
        method: 'POST',
        body: JSON.stringify({
            amount: koboToNaira(input.amountKobo),
            reference: input.reference,
            narration: input.narration.slice(0, 100),
            destinationBankCode: input.bankCode,
            destinationAccountNumber: input.accountNumber,
            destinationAccountName: input.accountName,
            currency: 'NGN',
            sourceAccountNumber: c.monnify.walletAccount,
            async: true,
        }),
    });
    return toTransferResult(raw);
}

export async function authorizeTransfer(reference: string, otp: string): Promise<MonnifyTransferResult> {
    const c = getConfig();
    if (c.monnify.mode === 'mock') {
        if (!/^\d{6}$/.test(otp)) {
            throw new UserFacingError('Use any six-digit OTP in mock mode.');
        }
        return { amountKobo: 0, reference, status: 'SUCCESS', responseMessage: 'Mock OTP accepted.' };
    }

    const raw = await request<RawTransferResult>('/api/v2/disbursements/single/validate-otp', {
        method: 'POST',
        body: JSON.stringify({ reference, authorizationCode: otp }),
    });
    return toTransferResult(raw);
}

export async function getBanks(): Promise<MonnifyBank[]> {
    const c = getConfig();
    if (c.monnify.mode === 'mock') {
        return [
            { name: 'Access Bank', code: '044' },
            { name: 'GTBank', code: '058' },
            { name: 'Zenith Bank', code: '057' },
            { name: 'Moniepoint MFB', code: '50515' },
        ];
    }
    return request<MonnifyBank[]>('/api/v1/banks');
}

export function resetMonnifyTokenForTests(): void {
    tokenCache = null;
}
