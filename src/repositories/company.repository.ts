import type { Company, Membership, Role } from '../types/domain.js';
import { db, assertData } from './db.js';
import { makeInviteCode, slugify } from '../utils/ids.js';
import { UserFacingError } from '../utils/errors.js';

export async function create(
    name: string,
    ownerUserId: string,
    requiredApprovals: number,
): Promise<Company> {
    const inserted = await db()
        .from('nett_companies')
        .insert({
            name,
            slug: slugify(name),
            owner_user_id: ownerUserId,
            required_approvals: requiredApprovals,
        })
        .select('*')
        .single();
    const company = assertData(inserted.data as Company | null, inserted.error, 'create company');

    const member = await db().from('nett_memberships').insert({
        company_id: company.id,
        user_id: ownerUserId,
        role: 'owner',
    });
    if (member.error) {
        throw new Error(`create owner membership: ${member.error.message}`);
    }
    return company;
}

export async function listForUser(
    userId: string,
): Promise<Array<{ company: Company; membership: Membership }>> {
    const result = await db()
        .from('nett_memberships')
        .select('*, company:nett_companies(*)')
        .eq('user_id', userId)
        .eq('active', true)
        .order('created_at');
    if (result.error) {
        throw new Error(`list companies: ${result.error.message}`);
    }

    const rows = (result.data ?? []) as Array<Membership & { company: Company }>;
    return rows.map((row) => {
        const membership: Membership = {
            id: row.id,
            company_id: row.company_id,
            user_id: row.user_id,
            role: row.role,
            active: row.active,
            created_at: row.created_at,
        };
        return { company: row.company, membership };
    });
}

export async function getMembership(companyId: string, userId: string): Promise<Membership | null> {
    const result = await db()
        .from('nett_memberships')
        .select('*')
        .eq('company_id', companyId)
        .eq('user_id', userId)
        .eq('active', true)
        .maybeSingle();
    if (result.error) {
        throw new Error(`get membership: ${result.error.message}`);
    }
    return result.data as Membership | null;
}

export async function findByChatId(chatId: string): Promise<Company | null> {
    const result = await db()
        .from('nett_companies')
        .select('*')
        .eq('telegram_chat_id', chatId)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
    if (result.error) {
        throw new Error(`find company room: ${result.error.message}`);
    }
    return result.data as Company | null;
}

export async function listAllByChatId(chatId: string): Promise<Company[]> {
    const result = await db()
        .from('nett_companies')
        .select('*')
        .eq('telegram_chat_id', chatId)
        .order('created_at', { ascending: true });
    if (result.error) {
        throw new Error(`list companies for room: ${result.error.message}`);
    }
    return (result.data ?? []) as Company[];
}

export async function findById(companyId: string): Promise<Company | null> {
    const result = await db().from('nett_companies').select('*').eq('id', companyId).maybeSingle();
    if (result.error) {
        throw new Error(`find company: ${result.error.message}`);
    }
    return result.data as Company | null;
}

export async function linkRoom(companyId: string, chatId: string, title: string): Promise<Company> {
    const existing = await listAllByChatId(chatId);
    const linkedToOther = existing.find((company) => company.id !== companyId);
    if (linkedToOther) {
        throw new UserFacingError(
            `This group is already linked to ${linkedToOther.name} (${linkedToOther.slug}). Run \`/unlinkroom ${linkedToOther.slug}\` first if you meant to replace it.`,
        );
    }

    const result = await db()
        .from('nett_companies')
        .update({ telegram_chat_id: chatId, telegram_chat_title: title })
        .eq('id', companyId)
        .select('*')
        .single();
    return assertData(result.data as Company | null, result.error, 'link room');
}

export async function unlinkRoom(companyId: string): Promise<void> {
    const result = await db()
        .from('nett_companies')
        .update({ telegram_chat_id: null, telegram_chat_title: null })
        .eq('id', companyId);
    if (result.error) {
        throw new Error(`unlink room: ${result.error.message}`);
    }
}

export async function setApprovalPolicy(companyId: string, count: number): Promise<void> {
    const result = await db()
        .from('nett_companies')
        .update({ required_approvals: count })
        .eq('id', companyId);
    if (result.error) {
        throw new Error(`set approval policy: ${result.error.message}`);
    }
}

export async function createInvite(
    companyId: string,
    role: Exclude<Role, 'owner'>,
    creatorId: string,
): Promise<string> {
    const code = makeInviteCode();
    const sevenDaysFromNow = new Date(Date.now() + 7 * 86_400_000).toISOString();

    const result = await db().from('nett_invites').insert({
        company_id: companyId,
        code,
        role,
        created_by: creatorId,
        expires_at: sevenDaysFromNow,
    });
    if (result.error) {
        throw new Error(`create invite: ${result.error.message}`);
    }
    return code;
}

export async function acceptInvite(
    code: string,
    userId: string,
): Promise<{ company: Company; role: Role }> {
    const inviteResult = await db()
        .from('nett_invites')
        .select('*')
        .eq('code', code.toUpperCase())
        .is('used_at', null)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle();
    if (inviteResult.error) {
        throw new Error(`find invite: ${inviteResult.error.message}`);
    }

    const invite = inviteResult.data;
    if (!invite) {
        throw new Error('This invite is invalid, expired, or already used.');
    }

    const targetCompany = await findById(invite.company_id);
    if (targetCompany?.owner_user_id === userId) {
        throw new UserFacingError(
            `You already own ${targetCompany.name} and keep owner access permanently. This invite would downgrade you, so it has been ignored.`,
        );
    }

    const upsert = await db()
        .from('nett_memberships')
        .upsert(
            { company_id: invite.company_id, user_id: userId, role: invite.role, active: true },
            { onConflict: 'company_id,user_id' },
        );
    if (upsert.error) {
        throw new Error(`join company: ${upsert.error.message}`);
    }

    const used = await db()
        .from('nett_invites')
        .update({ used_by: userId, used_at: new Date().toISOString() })
        .eq('id', invite.id);
    if (used.error) {
        throw new Error(`mark invite used: ${used.error.message}`);
    }

    const company = await findById(invite.company_id);
    if (!company) {
        throw new Error('Company no longer exists.');
    }
    return { company, role: invite.role as Role };
}

export async function listLinkedCompanies(): Promise<Company[]> {
    const result = await db()
        .from('nett_companies')
        .select('*')
        .not('telegram_chat_id', 'is', null);
    if (result.error) {
        throw new Error(`list linked companies: ${result.error.message}`);
    }
    return (result.data ?? []) as Company[];
}

export async function markDigestSent(companyId: string, date: string): Promise<void> {
    const result = await db()
        .from('nett_companies')
        .update({ last_digest_date: date })
        .eq('id', companyId);
    if (result.error) {
        throw new Error(`mark digest: ${result.error.message}`);
    }
}
