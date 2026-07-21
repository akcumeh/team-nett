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

interface GeminiResponse {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
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
    if (!config.geminiApiKey) {
        throw new Error('GEMINI_API_KEY is not configured.');
    }

    let supportedMediaType = 'image/jpeg';
    if (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mediaType)) {
        supportedMediaType = mediaType;
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent?key=${config.geminiApiKey}`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            contents: [
                {
                    role: 'user',
                    parts: [
                        { inline_data: { mime_type: supportedMediaType, data: imageBytes.toString('base64') } },
                        { text: PROMPT },
                    ],
                },
            ],
            systemInstruction: {
                parts: [
                    {
                        text: 'You extract invoice facts for a finance approval workflow. Never invent details. If a value is not visible, use null. Return only valid JSON and no markdown.',
                    },
                ],
            },
            generationConfig: { temperature: 0, maxOutputTokens: 900 },
        }),
    });

    const body = (await response.json()) as GeminiResponse;
    if (!response.ok) {
        throw new Error(`Gemini invoice extraction failed: ${body.error?.message ?? response.statusText}`);
    }

    const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
        throw new Error('Gemini returned no invoice extraction text.');
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(cleanJson(text));
    } catch {
        throw new Error('Gemini returned invoice data that was not valid JSON.');
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
