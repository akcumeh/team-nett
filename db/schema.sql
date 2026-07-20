create extension if not exists pgcrypto;

drop table if exists nett_webhook_events cascade;
drop table if exists nett_audit_logs cascade;
drop table if exists nett_sessions cascade;
drop table if exists nett_budgets cascade;
drop table if exists nett_customer_invoices cascade;
drop table if exists nett_approvals cascade;
drop table if exists nett_expense_requests cascade;
drop table if exists nett_vendors cascade;
drop table if exists nett_invites cascade;
drop table if exists nett_memberships cascade;
drop table if exists nett_companies cascade;
drop table if exists nett_users cascade;

create table nett_users (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id text unique not null,
  telegram_username text,
  full_name text not null,
  email text,
  created_at timestamptz not null default now()
);

create table nett_companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  owner_user_id uuid not null references nett_users(id),
  base_currency text not null default 'NGN',
  required_approvals int not null default 2 check (required_approvals between 1 and 10),
  telegram_chat_id text,
  telegram_chat_title text,
  last_digest_date date,
  created_at timestamptz not null default now()
);

create table nett_memberships (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references nett_companies(id) on delete cascade,
  user_id uuid not null references nett_users(id) on delete cascade,
  role text not null check (role in ('owner','admin','approver','requester','viewer')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique(company_id, user_id)
);

create table nett_invites (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references nett_companies(id) on delete cascade,
  code text unique not null,
  role text not null check (role in ('admin','approver','requester','viewer')),
  created_by uuid not null references nett_users(id),
  expires_at timestamptz not null,
  used_by uuid references nett_users(id),
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table nett_vendors (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references nett_companies(id) on delete cascade,
  nickname text not null,
  legal_name text not null,
  bank_code text not null,
  bank_name text,
  account_number text not null,
  account_name text not null,
  verified boolean not null default false,
  verification_source text not null default 'manual',
  created_by uuid not null references nett_users(id),
  created_at timestamptz not null default now(),
  unique(company_id, nickname)
);

create table nett_expense_requests (
  id uuid primary key default gen_random_uuid(),
  ref text unique not null,
  company_id uuid not null references nett_companies(id) on delete cascade,
  requester_user_id uuid not null references nett_users(id),
  vendor_id uuid not null references nett_vendors(id),
  amount_kobo bigint not null check (amount_kobo > 0),
  currency text not null default 'NGN',
  purpose text not null,
  category text not null default 'General',
  invoice_file_id text,
  status text not null default 'PENDING_APPROVAL' check (status in ('PENDING_APPROVAL','APPROVED','PENDING_AUTHORIZATION','PROCESSING','PAID','REJECTED','FAILED','CANCELLED')),
  required_approvals int not null,
  monnify_reference text,
  monnify_status text,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

create table nett_approvals (
  id uuid primary key default gen_random_uuid(),
  expense_request_id uuid not null references nett_expense_requests(id) on delete cascade,
  user_id uuid not null references nett_users(id),
  decision text not null check (decision in ('APPROVED','REJECTED')),
  comment text,
  created_at timestamptz not null default now(),
  unique(expense_request_id, user_id)
);

create table nett_customer_invoices (
  id uuid primary key default gen_random_uuid(),
  ref text unique not null,
  company_id uuid not null references nett_companies(id) on delete cascade,
  created_by uuid not null references nett_users(id),
  customer_name text not null,
  customer_email text not null,
  amount_kobo bigint not null check (amount_kobo > 0),
  currency text not null default 'NGN',
  description text not null,
  status text not null default 'PENDING' check (status in ('PENDING','PAID','PARTIALLY_PAID','OVERPAID','FAILED','EXPIRED','REVERSED')),
  checkout_url text,
  monnify_transaction_reference text,
  amount_paid_kobo bigint not null default 0,
  settlement_amount_kobo bigint not null default 0,
  due_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

create table nett_budgets (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references nett_companies(id) on delete cascade,
  category text not null,
  period_month date not null,
  amount_kobo bigint not null check (amount_kobo >= 0),
  created_by uuid not null references nett_users(id),
  created_at timestamptz not null default now(),
  unique(company_id, category, period_month)
);

create table nett_sessions (
  user_id uuid primary key references nett_users(id) on delete cascade,
  state text not null,
  context jsonb not null default '{}',
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create table nett_audit_logs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references nett_companies(id) on delete cascade,
  actor_user_id uuid references nett_users(id),
  action text not null,
  entity_type text not null,
  entity_id text,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table nett_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  event_key text unique not null,
  event_type text not null,
  payload jsonb not null,
  processed boolean not null default false,
  error text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create index idx_nett_memberships_user on nett_memberships(user_id) where active = true;
create index idx_nett_invites_company on nett_invites(company_id);
create index idx_nett_expense_company_status on nett_expense_requests(company_id, status, created_at desc);
create index idx_nett_invoice_company_status on nett_customer_invoices(company_id, status, created_at desc);
create index idx_nett_approvals_request on nett_approvals(expense_request_id);
create index idx_nett_audit_company on nett_audit_logs(company_id, created_at desc);

alter table nett_users enable row level security;
alter table nett_companies enable row level security;
alter table nett_memberships enable row level security;
alter table nett_invites enable row level security;
alter table nett_vendors enable row level security;
alter table nett_expense_requests enable row level security;
alter table nett_approvals enable row level security;
alter table nett_customer_invoices enable row level security;
alter table nett_budgets enable row level security;
alter table nett_sessions enable row level security;
alter table nett_audit_logs enable row level security;
alter table nett_webhook_events enable row level security;
