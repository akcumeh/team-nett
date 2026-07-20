export type Role = 'owner' | 'admin' | 'approver' | 'requester' | 'viewer';

export type RequestStatus =
    | 'PENDING_APPROVAL'
    | 'APPROVED'
    | 'PENDING_AUTHORIZATION'
    | 'PROCESSING'
    | 'PAID'
    | 'REJECTED'
    | 'FAILED'
    | 'CANCELLED';

export type InvoiceStatus =
    | 'PENDING'
    | 'PAID'
    | 'PARTIALLY_PAID'
    | 'OVERPAID'
    | 'FAILED'
    | 'EXPIRED'
    | 'REVERSED';

export interface NettUser {
    id: string;
    telegram_user_id: string;
    telegram_username: string | null;
    full_name: string;
    email: string | null;
    created_at: string;
}

export interface Company {
    id: string;
    name: string;
    slug: string;
    owner_user_id: string;
    base_currency: string;
    required_approvals: number;
    telegram_chat_id: string | null;
    telegram_chat_title: string | null;
    last_digest_date: string | null;
    created_at: string;
}

export interface Membership {
    id: string;
    company_id: string;
    user_id: string;
    role: Role;
    active: boolean;
    created_at: string;
}

export interface Invite {
    id: string;
    company_id: string;
    code: string;
    role: Exclude<Role, 'owner'>;
    created_by: string;
    expires_at: string;
    used_by: string | null;
    used_at: string | null;
    created_at: string;
}

export interface Vendor {
    id: string;
    company_id: string;
    nickname: string;
    legal_name: string;
    bank_code: string;
    bank_name: string | null;
    account_number: string;
    account_name: string;
    verified: boolean;
    verification_source: string;
    created_by: string;
    created_at: string;
}

// Amounts are integer kobo end to end; naira only exists in the formatting layer.
export interface ExpenseRequest {
    id: string;
    ref: string;
    company_id: string;
    requester_user_id: string;
    vendor_id: string;
    amount_kobo: number;
    currency: string;
    purpose: string;
    category: string;
    invoice_file_id: string | null;
    status: RequestStatus;
    required_approvals: number;
    monnify_reference: string | null;
    monnify_status: string | null;
    paid_at: string | null;
    created_at: string;
}

export interface Approval {
    id: string;
    expense_request_id: string;
    user_id: string;
    decision: 'APPROVED' | 'REJECTED';
    comment: string | null;
    created_at: string;
}

export interface CustomerInvoice {
    id: string;
    ref: string;
    company_id: string;
    created_by: string;
    customer_name: string;
    customer_email: string;
    amount_kobo: number;
    currency: string;
    description: string;
    status: InvoiceStatus;
    checkout_url: string | null;
    monnify_transaction_reference: string | null;
    amount_paid_kobo: number;
    settlement_amount_kobo: number;
    due_at: string | null;
    paid_at: string | null;
    created_at: string;
}

export interface Budget {
    id: string;
    company_id: string;
    category: string;
    period_month: string;
    amount_kobo: number;
    created_by: string;
    created_at: string;
}

export interface Session {
    user_id: string;
    state: string;
    context: Record<string, unknown>;
    expires_at: string;
    updated_at: string;
}

export interface AuditLog {
    id: string;
    company_id: string | null;
    actor_user_id: string | null;
    action: string;
    entity_type: string;
    entity_id: string | null;
    details: Record<string, unknown>;
    created_at: string;
}

export interface WebhookEvent {
    id: string;
    provider: string;
    event_key: string;
    event_type: string;
    payload: Record<string, unknown>;
    processed: boolean;
    error: string | null;
    created_at: string;
    processed_at: string | null;
}
