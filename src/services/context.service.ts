import type { Context } from 'telegraf';
import type { Company, Membership, NettUser } from '../types/domain.js';
import * as userRepo from '../repositories/user.repository.js';
import * as companyRepo from '../repositories/company.repository.js';
import { UserFacingError } from '../utils/errors.js';

export interface ActorContext {
    user: NettUser;
    company: Company;
    membership: Membership;
}

export async function ensureUser(ctx: Context): Promise<NettUser> {
    if (!ctx.from) {
        throw new UserFacingError('Telegram user information is missing.');
    }

    let fullName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ');
    if (!fullName) {
        fullName = 'NETT user';
    }

    return userRepo.findOrCreate({
        telegramUserId: String(ctx.from.id),
        username: ctx.from.username,
        fullName,
    });
}

export async function resolveActor(ctx: Context): Promise<ActorContext> {
    const user = await ensureUser(ctx);

    if (ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup') {
        const company = await companyRepo.findByChatId(String(ctx.chat.id));
        if (!company) {
            throw new UserFacingError(
                'This Telegram group is not linked to a NETT company. An owner should use /linkroom.',
            );
        }
        const membership = await companyRepo.getMembership(company.id, user.id);
        if (!membership) {
            throw new UserFacingError(
                'You are not a member of the company linked to this room. Use an invite code in a private chat with NETT.',
            );
        }
        return { user, company, membership };
    }

    const companies = await companyRepo.listForUser(user.id);
    if (companies.length === 0) {
        throw new UserFacingError(
            'You do not belong to a company yet. Use /createcompany Company Name or /join INVITE_CODE.',
        );
    }
    if (companies.length > 1) {
        throw new UserFacingError(
            'You belong to several companies. Use the linked company Telegram group for finance actions.',
        );
    }
    return {
        user,
        company: companies[0]!.company,
        membership: companies[0]!.membership,
    };
}
