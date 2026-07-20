import { Markup, type Context } from 'telegraf';
import { message } from 'telegraf/filters';
import { getConfig } from '../config/index.js';
import * as companyRepo from '../repositories/company.repository.js';
import * as vendorRepo from '../repositories/vendor.repository.js';
import * as expenseRepo from '../repositories/expense.repository.js';
import * as invoiceRepo from '../repositories/invoice.repository.js';
import * as budgetRepo from '../repositories/budget.repository.js';
import * as sessionRepo from '../repositories/session.repository.js';
import * as auditRepo from '../repositories/audit.repository.js';
import { ensureUser, resolveActor } from '../services/context.service.js';
import { getBot } from '../services/telegram.service.js';
import { validateAccount, getBanks, isMockMode } from '../services/monnify.service.js';
import { createRequest, decide, pay, authorize, companyForRequest } from '../services/request.service.js';
import { createInvoice, reconcileInvoice, applyProviderPayment } from '../services/invoice.service.js';
import { renderBudget, renderDashboard } from '../services/finance.service.js';
import { UserFacingError, errorMessage } from '../utils/errors.js';
import { hasRole, canPay } from '../utils/permissions.js';
import { rateLimit } from '../utils/rateLimit.js';
import { maskAccount, money, monthKey, parseAmountToKobo, splitPipeArgs } from '../utils/format.js';
import type { Company, ExpenseRequest, Membership, Role } from '../types/domain.js';

export const bot = getBot();

function banner(): string {
    const config = getConfig();
    if (config.simulationBanner || config.monnify.mode !== 'live') {
        return '🧪 SANDBOX / DEMO: No real money is moved unless you deliberately switch to approved live credentials.\n\n';
    }
    return '';
}

const HELP_BODY = `NETT FINANCE ROOM

NETT is a finance operations bot for company Telegram rooms.

SETUP
/createcompany Company Name
/companies
/linkroom [company slug]  - run inside a Telegram group
/invite approver
/join INVITE_CODE
/policy 2

VENDORS AND PAYMENTS
/vendor Nickname | Account Number | Bank Code | Legal Name
/vendors
/request Amount | Vendor Nickname | Purpose | Category
/requests
/approve EXP-REF
/reject EXP-REF
/pay EXP-REF
/authorize EXP-REF | 123456

COLLECTIONS
/invoice Amount | Customer Name | customer@email.com | Description
/invoices
/reconcile

FINANCE CONTROL
/dashboard
/budget Category | Amount
/budgets
/status REFERENCE
/cancel`;

function commandText(ctx: Context): string {
    let text = '';
    if (ctx.message && 'text' in ctx.message) {
        text = ctx.message.text;
    }
    return text.replace(/^\/\w+(?:@\w+)?\s*/i, '').trim();
}

async function reply(
    ctx: Context,
    text: string,
    extra?: Parameters<Context['reply']>[1],
): Promise<void> {
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 4000) {
        const cut = remaining.lastIndexOf('\n', 4000);
        let index = 4000;
        if (cut > 1000) {
            index = cut;
        }
        chunks.push(remaining.slice(0, index));
        remaining = remaining.slice(index);
    }
    chunks.push(remaining);
    for (const chunk of chunks) {
        await ctx.reply(chunk, extra);
    }
}

function requestKeyboard(ref: string, approved = false) {
    if (approved) {
        return Markup.inlineKeyboard([
            Markup.button.callback('Pay supplier', `pay:${ref}`),
            Markup.button.callback('View details', `details:${ref}`),
        ]);
    }
    return Markup.inlineKeyboard([
        Markup.button.callback('Approve', `approve:${ref}`),
        Markup.button.callback('Reject', `reject:${ref}`),
        Markup.button.callback('Details', `details:${ref}`),
    ]);
}

async function renderRequest(request: ExpenseRequest): Promise<string> {
    const vendor = await vendorRepo.findById(request.vendor_id);
    const approvals = await expenseRepo.countApproved(request.id);

    let vendorLine = 'Unknown (Unknown)';
    let accountLine = 'Unknown';
    if (vendor) {
        vendorLine = `${vendor.nickname} (${vendor.account_name})`;
        accountLine = maskAccount(vendor.account_number);
    }

    return [
        `EXPENSE REQUEST ${request.ref}`,
        `Status: ${request.status}`,
        `Amount: ${money(request.amount_kobo, request.currency)}`,
        `Vendor: ${vendorLine}`,
        `Account: ${accountLine}`,
        `Purpose: ${request.purpose}`,
        `Category: ${request.category}`,
        `Approvals: ${approvals}/${request.required_approvals}`,
    ].join('\n');
}

async function notifyRoom(
    company: Company,
    text: string,
    keyboard?: ReturnType<typeof requestKeyboard>,
): Promise<void> {
    if (!company.telegram_chat_id) {
        return;
    }
    await bot.telegram.sendMessage(company.telegram_chat_id, text, keyboard);
}

// inline buttons only send a ref when clicked. so the user must prove they are part of the company making the request
async function membershipForRequest(ctx: Context, ref: string): Promise<{
    request: ExpenseRequest;
    membership: Membership;
    userId: string;
}> {
    const user = await ensureUser(ctx);
    const request = await expenseRepo.findByRef(ref);
    if (!request) {
        throw new UserFacingError('Expense request not found.');
    }
    const membership = await companyRepo.getMembership(request.company_id, user.id);
    if (!membership) {
        throw new UserFacingError('You are not a member of this company.');
    }
    return { request, membership, userId: user.id };
}

bot.use(async (ctx, next) => {
    if (ctx.from) {
        const allowed = rateLimit(`tg:${ctx.from.id}`, 20, 60_000);
        if (!allowed) {
            if (ctx.callbackQuery) {
                await ctx.answerCbQuery('Slow down a little.').catch(() => undefined);
            } else {
                await ctx.reply('Slow down a little and try again in a minute.').catch(() => undefined);
            }
            return;
        }
    }
    await next();
});

bot.catch(async (error, ctx) => {
    console.error('Telegram handler error:', error);
    let text = 'Something went wrong. The error was logged; please try again.';
    if (error instanceof UserFacingError) {
        text = error.message;
    }
    await reply(ctx, text).catch(() => undefined);
});

bot.start(async (ctx) => {
    const user = await ensureUser(ctx);
    const companies = await companyRepo.listForUser(user.id);

    let summary = 'Create a workspace with /createcompany Company Name, or join one with /join INVITE_CODE.';
    if (companies.length === 1) {
        summary = 'You currently belong to 1 company workspace. Use /companies to view it.';
    } else if (companies.length > 1) {
        summary = `You currently belong to ${companies.length} company workspaces. Use /companies to view them.`;
    }

    await reply(
        ctx,
        `${banner()}Welcome to NETT Finance Room, ${user.full_name}.\n\n${summary}\n\nUse /help to see every command.`,
    );
});

bot.help(async (ctx) => {
    await reply(ctx, `${banner()}${HELP_BODY}`);
});

bot.command('createcompany', async (ctx) => {
    const user = await ensureUser(ctx);
    const name = commandText(ctx);
    if (name.length < 2) {
        throw new UserFacingError('Use: /createcompany Company Name');
    }
    const company = await companyRepo.create(name, user.id, getConfig().defaultRequiredApprovals);
    await auditRepo.log({
        companyId: company.id,
        actorUserId: user.id,
        action: 'company_created',
        entityType: 'company',
        entityId: company.id,
    });
    await reply(
        ctx,
        `Company created: ${company.name}\nSlug: ${company.slug}\n\nNext: create a Telegram group, add this bot, then run /linkroom ${company.slug} inside the group.`,
    );
});

bot.command('companies', async (ctx) => {
    const user = await ensureUser(ctx);
    const companies = await companyRepo.listForUser(user.id);
    if (companies.length === 0) {
        return reply(ctx, 'You do not belong to a NETT company yet.');
    }
    const lines = companies.map(({ company, membership }) => {
        const room = company.telegram_chat_title ?? 'not linked';
        return `${company.name}\nSlug: ${company.slug}\nRole: ${membership.role}\nRoom: ${room}`;
    });
    await reply(ctx, lines.join('\n\n'));
});

bot.command('linkroom', async (ctx) => {
    if (!ctx.chat || !['group', 'supergroup'].includes(ctx.chat.type)) {
        throw new UserFacingError(
            'Run /linkroom inside the Telegram group that will become the company finance room.',
        );
    }
    const user = await ensureUser(ctx);
    const slug = commandText(ctx).toLowerCase();
    const companies = await companyRepo.listForUser(user.id);
    const owned = companies.filter((entry) => entry.membership.role === 'owner');

    let selected;
    if (slug) {
        selected = owned.find((entry) => entry.company.slug === slug);
    } else if (owned.length === 1) {
        selected = owned[0];
    }
    if (!selected) {
        throw new UserFacingError(
            'Use /linkroom COMPANY-SLUG. You can find the slug with /companies in a private chat.',
        );
    }

    let title = selected.company.name;
    if ('title' in ctx.chat) {
        title = ctx.chat.title;
    }

    const company = await companyRepo.linkRoom(selected.company.id, String(ctx.chat.id), title);
    await auditRepo.log({
        companyId: company.id,
        actorUserId: user.id,
        action: 'telegram_room_linked',
        entityType: 'company',
        entityId: company.id,
        details: { chatId: String(ctx.chat.id), title },
    });
    await reply(
        ctx,
        `${company.name} is now linked to this Telegram group. Team members can create requests, approve spending, issue invoices, and view company finance summaries here.`,
    );
});

bot.command('invite', async (ctx) => {
    const actor = await resolveActor(ctx);
    if (!hasRole(actor.membership.role, 'admin')) {
        throw new UserFacingError('Only an owner or admin can create invites.');
    }
    const role = commandText(ctx).toLowerCase() as Role;
    if (!['admin', 'approver', 'requester', 'viewer'].includes(role)) {
        throw new UserFacingError(
            'Use: /invite admin, /invite approver, /invite requester, or /invite viewer',
        );
    }
    const code = await companyRepo.createInvite(
        actor.company.id,
        role as Exclude<Role, 'owner'>,
        actor.user.id,
    );
    await reply(
        ctx,
        `Invite created for role: ${role}\nCode: ${code}\nExpires in 7 days.\n\nThe person should open a private chat with NETT and send: /join ${code}`,
    );
});

bot.command('join', async (ctx) => {
    const user = await ensureUser(ctx);
    const code = commandText(ctx).toUpperCase();
    if (!code) {
        throw new UserFacingError('Use: /join INVITE_CODE');
    }
    const joined = await companyRepo.acceptInvite(code, user.id);
    await auditRepo.log({
        companyId: joined.company.id,
        actorUserId: user.id,
        action: 'member_joined',
        entityType: 'membership',
        details: { role: joined.role },
    });

    let roomHint = 'The owner has not linked a finance room yet.';
    if (joined.company.telegram_chat_title) {
        roomHint = `Open the linked group: ${joined.company.telegram_chat_title}.`;
    }
    await reply(ctx, `You joined ${joined.company.name} as ${joined.role}. ${roomHint}`);
});

bot.command('policy', async (ctx) => {
    const actor = await resolveActor(ctx);
    if (actor.membership.role !== 'owner') {
        throw new UserFacingError('Only the company owner can change the approval policy.');
    }
    const count = Number(commandText(ctx));
    if (!Number.isInteger(count) || count < 1 || count > 10) {
        throw new UserFacingError('Use: /policy 2 (between 1 and 10 approvals)');
    }
    await companyRepo.setApprovalPolicy(actor.company.id, count);
    await auditRepo.log({
        companyId: actor.company.id,
        actorUserId: actor.user.id,
        action: 'approval_policy_changed',
        entityType: 'company',
        entityId: actor.company.id,
        details: { requiredApprovals: count },
    });

    let plural = 's';
    if (count === 1) {
        plural = '';
    }
    await reply(ctx, `New policy: every expense request needs ${count} approval${plural} before payment.`);
});

bot.command('banks', async (ctx) => {
    const banks = await getBanks();
    const lines = banks.slice(0, 30).map((bank) => `${bank.name}: ${bank.code}`);
    await reply(ctx, `Supported banks (first 30):\n\n${lines.join('\n')}`);
});

bot.command('vendor', async (ctx) => {
    const actor = await resolveActor(ctx);
    if (!hasRole(actor.membership.role, 'requester')) {
        throw new UserFacingError('Your role cannot add vendors.');
    }
    const [nickname, accountNumber, bankCode, legalName] = splitPipeArgs(commandText(ctx));
    if (!nickname || !accountNumber || !bankCode) {
        throw new UserFacingError('Use: /vendor Nickname | 0123456789 | 057 | Legal Business Name');
    }
    if (!/^\d{10}$/.test(accountNumber)) {
        throw new UserFacingError('The account number must contain exactly 10 digits.');
    }

    const validation = await validateAccount(accountNumber, bankCode);

    let verificationSource = 'monnify_name_enquiry';
    if (isMockMode()) {
        verificationSource = 'monnify_mock';
    }

    const vendor = await vendorRepo.create({
        company_id: actor.company.id,
        nickname,
        legal_name: legalName ?? validation.accountName,
        bank_code: bankCode,
        bank_name: null,
        account_number: accountNumber,
        account_name: validation.accountName,
        verified: true,
        verification_source: verificationSource,
        created_by: actor.user.id,
    });
    await auditRepo.log({
        companyId: actor.company.id,
        actorUserId: actor.user.id,
        action: 'vendor_added',
        entityType: 'vendor',
        entityId: vendor.id,
        details: { nickname, accountName: vendor.account_name, bankCode },
    });
    await reply(
        ctx,
        `Vendor saved and account checked.\n\nNickname: ${vendor.nickname}\nResolved account name: ${vendor.account_name}\nBank code: ${vendor.bank_code}\nAccount: ${maskAccount(vendor.account_number)}\nVerification: ${vendor.verification_source}`,
    );
});

bot.command('vendors', async (ctx) => {
    const actor = await resolveActor(ctx);
    const vendors = await vendorRepo.list(actor.company.id);
    if (vendors.length === 0) {
        return reply(ctx, 'No vendors have been saved. Use /vendor to add one.');
    }
    const lines = vendors.map((vendor) => {
        return `${vendor.nickname}\n${vendor.account_name}\n${maskAccount(vendor.account_number)} · bank code ${vendor.bank_code}`;
    });
    await reply(ctx, lines.join('\n\n'));
});

bot.command('request', async (ctx) => {
    const actor = await resolveActor(ctx);
    if (!hasRole(actor.membership.role, 'requester')) {
        throw new UserFacingError('Your role cannot create expense requests.');
    }
    const [amountText, vendorNickname, purpose, category = 'General'] = splitPipeArgs(commandText(ctx));

    let amountKobo: number | null = null;
    if (amountText) {
        amountKobo = parseAmountToKobo(amountText);
    }
    if (!amountKobo || !vendorNickname || !purpose) {
        throw new UserFacingError('Use: /request 780000 | Vendor Nickname | Purpose | Category');
    }

    const vendor = await vendorRepo.findByNickname(actor.company.id, vendorNickname);
    if (!vendor) {
        throw new UserFacingError(`Vendor "${vendorNickname}" was not found. Add it first with /vendor.`);
    }

    const request = await createRequest({
        company: actor.company,
        requester: actor.user,
        vendor,
        amountKobo,
        purpose,
        category,
    });
    const text = await renderRequest(request);
    await reply(ctx, text, requestKeyboard(request.ref));

    const sameChat = String(ctx.chat?.id) === actor.company.telegram_chat_id;
    if (actor.company.telegram_chat_id && !sameChat) {
        await notifyRoom(actor.company, text, requestKeyboard(request.ref));
    }
});

bot.command('requests', async (ctx) => {
    const actor = await resolveActor(ctx);
    const requests = await expenseRepo.list(actor.company.id, 15);
    if (requests.length === 0) {
        return reply(ctx, 'No expense requests yet.');
    }
    const lines = requests.map((request) => {
        return `${request.ref} · ${money(request.amount_kobo)}\n${request.status} · ${request.purpose}`;
    });
    await reply(ctx, lines.join('\n\n'));
});

bot.command('approve', async (ctx) => {
    const actor = await resolveActor(ctx);
    const ref = commandText(ctx).toUpperCase();
    if (!ref) {
        throw new UserFacingError('Use: /approve EXP-REFERENCE');
    }
    const result = await decide({
        ref,
        companyId: actor.company.id,
        userId: actor.user.id,
        decision: 'APPROVED',
        role: actor.membership.role,
    });
    await reply(ctx, `Approved ${ref}. ${result.approvals}/${result.request.required_approvals} approvals received.`);
    if (result.request.status === 'APPROVED') {
        await notifyRoom(
            actor.company,
            `${await renderRequest(result.request)}\n\nApproval threshold reached. An owner or admin can now release payment.`,
            requestKeyboard(ref, true),
        );
    }
});

bot.command('reject', async (ctx) => {
    const actor = await resolveActor(ctx);
    const ref = commandText(ctx).toUpperCase();
    if (!ref) {
        throw new UserFacingError('Use: /reject EXP-REFERENCE');
    }
    await decide({
        ref,
        companyId: actor.company.id,
        userId: actor.user.id,
        decision: 'REJECTED',
        role: actor.membership.role,
    });
    await reply(ctx, `Rejected ${ref}.`);
    await notifyRoom(actor.company, `EXPENSE REQUEST REJECTED\n${ref}\nRejected by ${actor.user.full_name}`);
});

bot.command('pay', async (ctx) => {
    const actor = await resolveActor(ctx);
    const ref = commandText(ctx).toUpperCase();
    if (!ref) {
        throw new UserFacingError('Use: /pay EXP-REFERENCE');
    }
    const updated = await pay({
        ref,
        companyId: actor.company.id,
        userId: actor.user.id,
        role: actor.membership.role,
    });

    let payoutMessage = 'The provider returned a non-success status. Review the request before retrying.';
    if (updated.status === 'PENDING_AUTHORIZATION') {
        payoutMessage = `Monnify sent an OTP to the merchant email. Use /authorize ${updated.ref} | OTP`;
    } else if (updated.monnify_status === 'READY_FOR_PAYOUT') {
        payoutMessage =
            'The request remains approved. Monnify sandbox disbursement must be activated before NETT can submit it.';
    } else if (updated.status === 'PROCESSING') {
        payoutMessage = 'Monnify accepted the payout for processing. This is not yet a final completion.';
    } else if (updated.status === 'PAID') {
        payoutMessage = 'Monnify reported a terminal successful payout status.';
    }

    await reply(ctx, `${await renderRequest(updated)}\n\n${payoutMessage}`);
    await notifyRoom(actor.company, await renderRequest(updated));
});

bot.command('authorize', async (ctx) => {
    const actor = await resolveActor(ctx);
    const [ref, otp] = splitPipeArgs(commandText(ctx));
    if (!ref || !otp) {
        throw new UserFacingError('Use: /authorize EXP-REFERENCE | 123456');
    }
    const updated = await authorize({
        ref: ref.toUpperCase(),
        otp,
        companyId: actor.company.id,
        userId: actor.user.id,
        role: actor.membership.role,
    });

    // The message carries an OTP; remove it where Telegram grants delete rights.
    try {
        await ctx.deleteMessage();
    } catch {
        // Telegram may not grant delete rights in this chat.
    }

    await reply(ctx, `Authorization submitted for ${ref}. Current status: ${updated.status}.`);
    await notifyRoom(actor.company, await renderRequest(updated));
});

bot.command('invoice', async (ctx) => {
    const actor = await resolveActor(ctx);
    if (!hasRole(actor.membership.role, 'requester')) {
        throw new UserFacingError('Your role cannot create customer invoices.');
    }
    const [amountText, customerName, customerEmail, description] = splitPipeArgs(commandText(ctx));

    let amountKobo: number | null = null;
    if (amountText) {
        amountKobo = parseAmountToKobo(amountText);
    }
    const emailLooksValid = customerEmail ? /^\S+@\S+\.\S+$/.test(customerEmail) : false;
    if (!amountKobo || !customerName || !customerEmail || !description || !emailLooksValid) {
        throw new UserFacingError('Use: /invoice 450000 | Customer Name | customer@email.com | Description');
    }

    const invoice = await createInvoice({
        company: actor.company,
        creator: actor.user,
        customerName,
        customerEmail,
        amountKobo,
        description,
    });
    await reply(
        ctx,
        `CUSTOMER INVOICE ${invoice.ref}\nCustomer: ${invoice.customer_name}\nAmount: ${money(invoice.amount_kobo)}\nDescription: ${invoice.description}\nStatus: ${invoice.status}\n\nSecure payment link:\n${invoice.checkout_url}\n\nThe invoice is only marked paid after a Monnify webhook or server-side verification.`,
    );
    await notifyRoom(
        actor.company,
        `NEW CUSTOMER INVOICE\n${invoice.ref}\n${invoice.customer_name}\n${money(invoice.amount_kobo)}\n${invoice.description}\n\nPayment link: ${invoice.checkout_url}`,
    );
});

bot.command('invoices', async (ctx) => {
    const actor = await resolveActor(ctx);
    const invoices = await invoiceRepo.list(actor.company.id, 15);
    if (invoices.length === 0) {
        return reply(ctx, 'No customer invoices yet.');
    }
    const lines = invoices.map((invoice) => {
        return `${invoice.ref} · ${money(invoice.amount_kobo)}\n${invoice.customer_name} · ${invoice.status}`;
    });
    await reply(ctx, lines.join('\n\n'));
});

bot.command('reconcile', async (ctx) => {
    const actor = await resolveActor(ctx);
    if (!hasRole(actor.membership.role, 'admin')) {
        throw new UserFacingError('Only an owner or admin can run reconciliation.');
    }
    if (isMockMode()) {
        throw new UserFacingError(
            'Mock mode uses the local demo payment page. Open an invoice link to mark it paid. Switch MONNIFY_MODE=sandbox to test provider reconciliation.',
        );
    }
    const pending = await invoiceRepo.pending(actor.company.id);
    if (pending.length === 0) {
        return reply(ctx, 'No pending invoices need reconciliation.');
    }

    const results: string[] = [];
    for (const invoice of pending) {
        try {
            const updated = await reconcileInvoice(invoice.ref, actor.company.id);
            results.push(`${invoice.ref}: ${updated.status} (${money(updated.amount_paid_kobo)})`);
        } catch (error) {
            results.push(`${invoice.ref}: ERROR - ${errorMessage(error)}`);
        }
    }
    await reply(ctx, `RECONCILIATION RESULTS\n\n${results.join('\n')}`);
});

bot.command('dashboard', async (ctx) => {
    const actor = await resolveActor(ctx);
    await reply(ctx, await renderDashboard(actor.company));
});

bot.command('cashflow', async (ctx) => {
    const actor = await resolveActor(ctx);
    await reply(ctx, await renderDashboard(actor.company));
});

bot.command('budget', async (ctx) => {
    const actor = await resolveActor(ctx);
    if (!hasRole(actor.membership.role, 'admin')) {
        throw new UserFacingError('Only an owner or admin can set budgets.');
    }
    const [category, amountText] = splitPipeArgs(commandText(ctx));

    let amountKobo: number | null = null;
    if (amountText) {
        amountKobo = parseAmountToKobo(amountText);
    }
    if (!category || amountKobo === null) {
        throw new UserFacingError('Use: /budget Technology | 3000000');
    }

    await budgetRepo.upsert({
        company_id: actor.company.id,
        category,
        period_month: monthKey(),
        amount_kobo: amountKobo,
        created_by: actor.user.id,
    });
    await auditRepo.log({
        companyId: actor.company.id,
        actorUserId: actor.user.id,
        action: 'budget_set',
        entityType: 'budget',
        details: { category, amountKobo, month: monthKey() },
    });
    await reply(ctx, `Budget saved: ${category} = ${money(amountKobo)} for this month.`);
});

bot.command('budgets', async (ctx) => {
    const actor = await resolveActor(ctx);
    await reply(ctx, await renderBudget(actor.company));
});

bot.command('status', async (ctx) => {
    const actor = await resolveActor(ctx);
    const ref = commandText(ctx).toUpperCase();
    if (!ref) {
        throw new UserFacingError('Use: /status REFERENCE');
    }

    const expense = await expenseRepo.findByRef(ref);
    if (expense) {
        if (expense.company_id !== actor.company.id) {
            throw new UserFacingError('Reference does not belong to this company.');
        }
        return reply(ctx, await renderRequest(expense));
    }

    const invoice = await invoiceRepo.findByRef(ref);
    if (invoice) {
        if (invoice.company_id !== actor.company.id) {
            throw new UserFacingError('Reference does not belong to this company.');
        }
        return reply(
            ctx,
            `INVOICE ${invoice.ref}\nCustomer: ${invoice.customer_name}\nAmount: ${money(invoice.amount_kobo)}\nPaid: ${money(invoice.amount_paid_kobo)}\nStatus: ${invoice.status}\nCheckout: ${invoice.checkout_url ?? 'n/a'}`,
        );
    }

    throw new UserFacingError('No expense request or customer invoice was found with that reference.');
});

bot.command('cancel', async (ctx) => {
    const user = await ensureUser(ctx);
    await sessionRepo.clear(user.id);
    await reply(ctx, 'Current draft cancelled. Existing submitted requests and invoices were not changed.');
});

bot.action(/^approve:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const ref = ctx.match[1]!.toUpperCase();
    const { request, membership, userId } = await membershipForRequest(ctx, ref);

    const result = await decide({
        ref,
        companyId: request.company_id,
        userId,
        decision: 'APPROVED',
        role: membership.role,
    });
    await ctx
        .editMessageText(
            await renderRequest(result.request),
            requestKeyboard(result.request.ref, result.request.status === 'APPROVED'),
        )
        .catch(() => undefined);

    if (result.request.status === 'APPROVED') {
        const company = await companyForRequest(result.request);
        await notifyRoom(
            company,
            `${await renderRequest(result.request)}\n\nApproval threshold reached.`,
            requestKeyboard(ref, true),
        );
    }
});

bot.action(/^reject:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const ref = ctx.match[1]!.toUpperCase();
    const { request, membership, userId } = await membershipForRequest(ctx, ref);

    const result = await decide({
        ref,
        companyId: request.company_id,
        userId,
        decision: 'REJECTED',
        role: membership.role,
    });
    await ctx.editMessageText(await renderRequest(result.request)).catch(() => undefined);
});

bot.action(/^pay:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const ref = ctx.match[1]!.toUpperCase();
    const { request, membership, userId } = await membershipForRequest(ctx, ref);

    if (!canPay(membership.role)) {
        throw new UserFacingError('Only an owner or admin can release payment.');
    }

    const updated = await pay({ ref, companyId: request.company_id, userId, role: membership.role });
    await ctx.editMessageText(await renderRequest(updated)).catch(() => undefined);

    if (updated.status === 'PENDING_AUTHORIZATION') {
        await reply(ctx, `Monnify is waiting for OTP authorization. Use /authorize ${ref} | OTP in a private chat or this room.`);
    }
});

bot.action(/^details:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const ref = ctx.match[1]!.toUpperCase();
    const { request } = await membershipForRequest(ctx, ref);
    await reply(ctx, await renderRequest(request));
});

bot.on(message('text'), async (ctx) => {
    if (ctx.message.text.startsWith('/')) {
        return;
    }
    const lower = ctx.message.text.trim().toLowerCase();
    if (lower === 'help' || lower === 'menu') {
        return reply(ctx, `${banner()}${HELP_BODY}`);
    }
    await reply(
        ctx,
        'I did not understand that as a command. Use /help. For dependable financial operations, NETT uses explicit commands and confirmation buttons rather than guessing amounts or recipients.',
    );
});

export async function configureBotCommands(): Promise<void> {
    await bot.telegram.setMyCommands([
        { command: 'dashboard', description: 'View cash movement and open work' },
        { command: 'request', description: 'Create an expense request' },
        { command: 'invoice', description: 'Create a customer payment invoice' },
        { command: 'requests', description: 'List expense requests' },
        { command: 'invoices', description: 'List customer invoices' },
        { command: 'vendors', description: 'List saved vendors' },
        { command: 'budgets', description: 'View monthly budgets' },
        { command: 'help', description: 'Show full guide' },
    ]);
}

// Used by the mock checkout demo page.
export async function markMockInvoicePaid(ref: string): Promise<void> {
    const invoice = await invoiceRepo.findByRef(ref);
    if (!invoice) {
        throw new Error('Invoice not found.');
    }
    const updated = await applyProviderPayment({
        ref,
        status: 'PAID',
        amountPaidKobo: invoice.amount_kobo,
        settlementAmountKobo: invoice.amount_kobo,
        transactionReference: `MOCK-${ref}`,
        paidOn: new Date().toISOString(),
    });
    if (!updated) {
        return;
    }
    const company = await companyRepo.findById(updated.company_id);
    if (!company) {
        throw new Error('Company not found for mock invoice.');
    }
    await notifyRoom(
        company,
        `MOCK COLLECTION CONFIRMED\n${updated.ref}\n${updated.customer_name}\n${money(updated.amount_paid_kobo)}\nStatus: ${updated.status}`,
    );
}
