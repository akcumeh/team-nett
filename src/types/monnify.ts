export interface MonnifyEnvelope<T> {
    requestSuccessful: boolean;
    responseMessage: string;
    responseCode: string;
    responseBody: T;
}

export interface MonnifyCheckout {
    transactionReference: string;
    paymentReference: string;
    merchantName?: string;
    enabledPaymentMethod?: string[];
    checkoutUrl: string;
}

// Monnify speaks naira; the adapter converts to kobo before anything else sees it.
export interface MonnifyVerification {
    paymentReference: string;
    transactionReference: string;
    amountPaidKobo: number;
    totalPayableKobo: number;
    settlementAmountKobo: number;
    paymentStatus: string;
    paymentMethod?: string;
    paidOn?: string;
    customerName?: string;
    customerEmail?: string;
}

export interface MonnifyAccountValidation {
    accountNumber: string;
    accountName: string;
    bankCode?: string;
}

export interface MonnifyTransferResult {
    amountKobo: number;
    reference: string;
    status: string;
    dateCreated?: string;
    destinationAccountName?: string;
    destinationBankName?: string;
    destinationAccountNumber?: string;
    responseMessage?: string;
}

export interface MonnifyBank {
    name: string;
    code: string;
    ussdTemplate?: string;
}
