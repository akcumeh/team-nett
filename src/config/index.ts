import 'dotenv/config'
import { z } from "zod";

const bool = z
    .string()
    .optional()
    .transform((v) => (v ?? 'false').toLowerCase() === 'true');

const envSchema = z.object({
    TG_BOT_TOKEN: z.string().min(43),
    TG_WEBHOOK_SECRET: z.string().min(1),
    SUPABASE_URL: z.string().url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    PUBLIC_BASE_URL: z.string().url(),
    PORT: z.coerce.number().int().positive().default(3000),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    MONNIFY_MODE: z.enum(['mock', 'sandbox', 'live']).default('mock'),
    MONNIFY_API_KEY: z.string().optional(),
    MONNIFY_SECRET_KEY: z.string().optional(),
    MONNIFY_CONTRACT_CODE: z.string().optional(),
    MONNIFY_WALLET_ACCOUNT: z.string().optional(),
    MONNIFY_DISBURSEMENTS_ENABLED: bool,
    MONNIFY_MFA_ENABLED: bool,
    MONNIFY_WEBHOOK_SIGNATURE_MODE: z.enum(['auto', 'hmac', 'legacy']).default('auto'),
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_MODEL: z.string().default('claude-haiku-4-5'),
    ADMIN_TELEGRAM_ID: z.string().optional(),
    DEFAULT_REQUIRED_APPROVALS: z.coerce.number().int().min(1).max(10).default(2),
    DAILY_DIGEST_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(7),
    SIMULATION_BANNER: bool,
    CRON_SECRET: z.string().min(1),
});

export type AppConfig = {
    nodeEnv: 'development' | 'production' | 'test';
    port: number;
    botToken: string;
    tgWebhookSecret: string;
    supabaseUrl: string;
    supabaseServiceRoleKey: string;
    publicBaseUrl: string;
    monnify: {
        mode: 'mock' | 'sandbox' | 'live';
        apiKey?: string;
        secretKey?: string;
        contractCode?: string;
        walletAccount?: string;
        disbursementsEnabled: boolean;
        mfaEnabled: boolean;
        webhookSignatureMode: 'auto' | 'hmac' | 'legacy';
        baseUrl: string;
    };
    anthropicApiKey?: string;
    anthropicModel: string;
    adminTelegramId?: string;
    defaultRequiredApprovals: number;
    dailyDigestHourUtc: number;
    simulationBanner: boolean;
    cronSecret: string;
};

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
    if (cached) return cached;

    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
        const details = parsed.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('\n');
        throw new Error(`Invalid environment configuration:\n${details}`);
    }

    const e = parsed.data;

    let monnifyBaseUrl = 'https://sandbox.monnify.com';
    if (e.MONNIFY_MODE === 'live') {
        monnifyBaseUrl = 'https://api.monnify.com';
    }

    if (e.MONNIFY_MODE !== 'mock') {
        const missing: string[] = [];
        if (!e.MONNIFY_API_KEY) {
            missing.push('MONNIFY_API_KEY');
        }
        if (!e.MONNIFY_SECRET_KEY) {
            missing.push('MONNIFY_SECRET_KEY');
        }
        if (!e.MONNIFY_CONTRACT_CODE) {
            missing.push('MONNIFY_CONTRACT_CODE');
        }
        if (missing.length > 0) {
            throw new Error(
                `Missing Monnify variables for ${e.MONNIFY_MODE} mode: ${missing.join(', ')}`,
            );
        }
    }

    cached = {
        nodeEnv: e.NODE_ENV,
        port: e.PORT,
        botToken: e.TG_BOT_TOKEN,
        tgWebhookSecret: e.TG_WEBHOOK_SECRET,
        supabaseUrl: e.SUPABASE_URL,
        supabaseServiceRoleKey: e.SUPABASE_SERVICE_ROLE_KEY,
        publicBaseUrl: e.PUBLIC_BASE_URL.replace(/\/$/, ''),
        monnify: {
            mode: e.MONNIFY_MODE,
            apiKey: e.MONNIFY_API_KEY,
            secretKey: e.MONNIFY_SECRET_KEY,
            contractCode: e.MONNIFY_CONTRACT_CODE,
            walletAccount: e.MONNIFY_WALLET_ACCOUNT,
            disbursementsEnabled: e.MONNIFY_DISBURSEMENTS_ENABLED,
            mfaEnabled: e.MONNIFY_MFA_ENABLED,
            webhookSignatureMode: e.MONNIFY_WEBHOOK_SIGNATURE_MODE,
            baseUrl: monnifyBaseUrl,
        },
        anthropicApiKey: e.ANTHROPIC_API_KEY,
        anthropicModel: e.ANTHROPIC_MODEL,
        adminTelegramId: e.ADMIN_TELEGRAM_ID,
        defaultRequiredApprovals: e.DEFAULT_REQUIRED_APPROVALS,
        dailyDigestHourUtc: e.DAILY_DIGEST_HOUR_UTC,
        simulationBanner: e.SIMULATION_BANNER,
        cronSecret: e.CRON_SECRET,
    };
    return cached;
}

export function resetConfigForTests(): void {
    cached = null;
}
