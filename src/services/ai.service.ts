import { z } from 'zod';
import { getConfig } from '../config/index.js';

const invoiceSchema = z.object({
    supplierName: z.string().nullable(),
    amount: z.number().positive().nullable(),
    currency: z.string().default('NGN'),
    invoiceNumber: z.string().nullable(),
    dueDate: z.string().nullable(),
    category: z.string().nullable(),
    purpose: z.string().nullable(),
    accountNumber: z.string().nullable(),
    bankName: z.string().nullable(),
    confidence: z.number().min(0).max(1),
});

export interface ExtractedInvoice {
    supplierName: string | null;
    amountKobo: number | null;
    currency: string;
    invoiceNumber: string | null;
    dueDate: string | null;
    category: string | null;
    purpose: string | null;
    accountNumber: string | null;
    bankName: string | null;
    confidence: number;
}

interface AnthropicResponse {
    content?: Array<{ type: string; text?: string }>;
    error?: { message?: string };
}

function cleanJson(text: string): string {
    const trimmed = text.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenced) {
        return fenced[1]!.trim();
    }
    return trimmed;
}

const PROMPT = `Return this exact JSON shape: {"supplierName":string|null,"amount":number|null,"currency":string,"invoiceNumber":string|null,"dueDate":string|null,"category":string|null,"purpose":string|null,"accountNumber":string|null,"bankName":string|null,"confidence":number}. Extract the supplier, total amount in naira, invoice number, due date, likely expense category, short payment purpose and any bank details. Confidence must be between 0 and 1. This is only a draft and will require human confirmation.`;

export async function extractInvoiceFromImage(
    imageBytes: Buffer,
    mediaType: string,
): Promise<ExtractedInvoice> {
    const config = getConfig();
    if (!config.anthropicApiKey) {
        throw new Error('ANTHROPIC_API_KEY is not configured.');
    }

    let supportedMediaType = 'image/jpeg';
    if (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mediaType)) {
        supportedMediaType = mediaType;
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key': config.anthropicApiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            model: config.anthropicModel,
            max_tokens: 900,
            temperature: 0,
            system: 'You extract invoice facts for a finance approval workflow. Never invent details. If a value is not visible, use null. Return only valid JSON and no markdown.',
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: supportedMediaType,
                                data: imageBytes.toString('base64'),
                            },
                        },
                        { type: 'text', text: PROMPT },
                    ],
                },
            ],
        }),
    });

    const body = (await response.json()) as AnthropicResponse;
    if (!response.ok) {
        throw new Error(`Anthropic invoice extraction failed: ${body.error?.message ?? response.statusText}`);
    }

    const text = body.content?.find((block) => block.type === 'text')?.text;
    if (!text) {
        throw new Error('Anthropic returned no invoice extraction text.');
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(cleanJson(text));
    } catch {
        throw new Error('Anthropic returned invoice data that was not valid JSON.');
    }

    const extracted = invoiceSchema.parse(parsed);

    let amountKobo: number | null = null;
    if (extracted.amount !== null) {
        amountKobo = Math.round(extracted.amount * 100);
    }

    return {
        supplierName: extracted.supplierName,
        amountKobo,
        currency: extracted.currency,
        invoiceNumber: extracted.invoiceNumber,
        dueDate: extracted.dueDate,
        category: extracted.category,
        purpose: extracted.purpose,
        accountNumber: extracted.accountNumber,
        bankName: extracted.bankName,
        confidence: extracted.confidence,
    };
}
