import type { Company, CustomerInvoice, ExpenseRequest } from '../types/domain.js';
import * as expenseRepo from '../repositories/expense.repository.js';
import * as invoiceRepo from '../repositories/invoice.repository.js';
import * as budgetRepo from '../repositories/budget.repository.js';
import { money, monthKey } from '../utils/format.js';

function monthStartIso(): string {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export async function getDashboard(company: Company): Promise<{
    collectedKobo: number;
    spentKobo: number;
    netKobo: number;
    pendingInvoices: CustomerInvoice[];
    pendingRequests: ExpenseRequest[];
}> {
    const start = monthStartIso();
    const [collectedKobo, spentKobo, pendingInvoices, pendingRequests] = await Promise.all([
        invoiceRepo.collectedThisMonthKobo(company.id, start),
        expenseRepo.paidThisMonthKobo(company.id, start),
        invoiceRepo.pending(company.id),
        expenseRepo.listByStatuses(company.id, [
            'PENDING_APPROVAL',
            'APPROVED',
            'PENDING_AUTHORIZATION',
            'PROCESSING',
        ]),
    ]);
    return {
        collectedKobo,
        spentKobo,
        netKobo: collectedKobo - spentKobo,
        pendingInvoices,
        pendingRequests,
    };
}

export async function renderDashboard(company: Company): Promise<string> {
    const d = await getDashboard(company);

    let policyWord = 'approvals';
    if (company.required_approvals === 1) {
        policyWord = 'approval';
    }

    return [
        `NETT FINANCE ROOM for ${company.name}`,
        '',
        'THIS MONTH',
        `Collected: ${money(d.collectedKobo, company.base_currency)}`,
        `Paid out: ${money(d.spentKobo, company.base_currency)}`,
        `Net cash movement: ${money(d.netKobo, company.base_currency)}`,
        '',
        'OPEN WORK',
        `Unpaid customer invoices: ${d.pendingInvoices.length}`,
        `Expense requests in progress: ${d.pendingRequests.length}`,
        '',
        `Approval policy: ${company.required_approvals} ${policyWord}`,
    ].join('\n');
}

export async function renderBudget(company: Company): Promise<string> {
    const period = monthKey();
    const [budgets, spendByCategory] = await Promise.all([
        budgetRepo.list(company.id, period),
        expenseRepo.paidByCategoryKobo(company.id, monthStartIso()),
    ]);

    if (budgets.length === 0) {
        return 'No budgets have been set for this month. Use /budget Category | Amount.';
    }

    const lines: string[] = [];
    for (const budget of budgets) {
        const usedKobo = spendByCategory[budget.category] ?? 0;
        const remainingKobo = budget.amount_kobo - usedKobo;
        lines.push(
            `${budget.category}: ${money(usedKobo)} used of ${money(budget.amount_kobo)} (${money(remainingKobo)} remaining)`,
        );
    }
    return `MONTHLY BUDGETS\n\n${lines.join('\n')}`;
}
