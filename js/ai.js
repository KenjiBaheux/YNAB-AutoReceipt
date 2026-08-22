import { DOM } from './dom.js';
import { showToast, updateProgressCounter } from './ui.js';
import { updateReceiptCard } from './card.js';
import { getYNABCategories } from './config.js';

export const AI_CONFIG_KEYS = {
    systemPrompt: 'ynab_receipt_porter_ai_system_prompt',
    samplingMode: 'ynab_receipt_porter_ai_sampling_mode',
    temperature: 'ynab_receipt_porter_ai_temperature',
    topK: 'ynab_receipt_porter_ai_topk',
    concurrency: 'ynab_receipt_porter_ai_concurrency',
    userPrompt: 'ynab_receipt_porter_ai_user_prompt',
    schema: 'ynab_receipt_porter_ai_schema'
};

export const DEFAULT_SCHEMA = `{
  "type": "object",
  "properties": {
    "merchants": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Up to 5 merchant candidates, most likely first"
    },
    "dates": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Up to 5 date candidates (YYYY-MM-DD), most likely first"
    },
    "amounts": {
      "type": "array",
      "items": { "type": "integer" },
      "description": "Up to 5 amount candidates (whole numbers), most likely first"
    },
    "categories": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Up to 5 suggested YNAB categories, most likely first"
    }
  },
  "required": ["merchants", "dates", "amounts", "categories"]
}`;

export function supportsSamplingMode() {
    return typeof LanguageModel !== 'undefined' && typeof LanguageModel.params !== 'function';
}

export const DEFAULT_SYSTEM_PROMPT = `You are a Japanese receipt parser. Extract Merchant name, Date (YYYY-MM-DD), Total Amount as a whole integer, and Category.

Provide up to 3 candidates for each field, ordered by likelihood (most likely first).
If a field is very certain, you can provide fewer candidates.
Omit any explanations.

Hints for extractions:
- **Total Amount**: Usually preceded by the symbol "¥", and typically presented in a larger or bold font and after the "合計" label. Japanese Yen does not use cents/decimals.
- **Date**: Look for "YYYY/MM/DD", "YYYY-MM-DD", or "YYYY年MM月DD日". It's often at the top.
- **Merchant**: Usually at the very top. Do not confuse generic terms like "領収書" with the vendor name.
- **Category**: Suggest possible YNAB categories.

{{CATEGORIES}}`;

export const DEFAULT_USER_PROMPT = "Extract JSON from this receipt:";

let baseSession = null;
let warmUpSession = null;
let setupPromise = null;

// --- Concurrency Queue ---

export const aiQueue = {
    queue: [],
    activeCount: 0,
    
    getMaxConcurrency() {
        const val = localStorage.getItem(AI_CONFIG_KEYS.concurrency);
        return Math.max(1, parseInt(val) || 1);
    },

    add(taskFn) {
        return new Promise((resolve, reject) => {
            this.queue.push({ taskFn, resolve, reject });
            this.processNext();
        });
    },

    processNext() {
        const limit = this.getMaxConcurrency();
        while (this.activeCount < limit && this.queue.length > 0) {
            const { taskFn, resolve, reject } = this.queue.shift();
            this.activeCount++;
            taskFn()
                .then(resolve)
                .catch(reject)
                .finally(() => {
                    this.activeCount--;
                    this.processNext();
                });
        }
    }
};

// --- AI Setup & Warmup ---

export async function checkAIAvailability() {
    const dot = DOM.aiStatus.querySelector('.dot');
    const text = DOM.aiStatus.querySelector('.status-text');

    dot.className = 'dot loading';
    text.textContent = 'Checking AI availability...';

    try {
        if (typeof LanguageModel === 'undefined') {
            throw new Error('LanguageModel API not found. Please use a browser that supports it.');
        }

        const availability = await LanguageModel.availability({
            expectedInputs: [
                { type: "text", languages: ["en", "ja"] },
                { type: "image" }
            ],
            expectedOutputs: [{ type: "text", languages: ["ja"] }]
        });

        if (availability === 'available') {
            dot.className = 'dot ok';
            text.textContent = 'AI Model Ready';
            showToast('Built-in AI is ready!', 'success');
            warmUpAI();
        } else if (availability === 'downloadable') {
            dot.className = 'dot loading';
            text.textContent = 'AI Model downloading...';
            showToast('AI Model needs to be downloaded.', 'info');
        } else {
            throw new Error(`AI not available: ${availability}`);
        }
    } catch (err) {
        dot.className = 'dot error';
        text.textContent = 'AI Error';
        showToast(err.message, 'error');
        console.error(err);
    }
}

export async function warmUpAI() {
    if (baseSession || warmUpSession) return;

    try {
        const options = {
            expectedInputs: [{ type: "text", languages: ["en", "ja"] }, { type: "image" }],
            initialPrompts: [{ role: 'system', content: `Respond with '.' only.` }],
            expectedOutputs: [{ type: "text", languages: ["ja"] }]
        };

        if (supportsSamplingMode()) {
            options.samplingMode = 'most-predictable';
        } else {
            options.temperature = 0.0;
            options.topK = 1;
        }

        const dummySession = await LanguageModel.create(options);
        await dummySession.prompt([{ role: 'user', content: [{ type: 'text', value: '.' }] }]);
        warmUpSession = dummySession;
        console.log('AI Warm-up successful');
    } catch (err) {
        console.warn('AI Warm-up failed:', err);
    }
}

export function resetAISession() {
    setupPromise = null;
    if (baseSession) {
        baseSession.destroy();
        baseSession = null;
    }
    if (warmUpSession) {
        warmUpSession.destroy();
        warmUpSession = null;
    }
    console.log('AI Session reset (will reload on next use)');
}

export function destroyAISession() {
    setupPromise = null;
    if (baseSession) {
        baseSession.destroy();
        baseSession = null;
    }
    if (warmUpSession) {
        warmUpSession.destroy();
        warmUpSession = null;
    }
}

export async function setupAI() {
    if (baseSession) return;
    if (setupPromise) {
        await setupPromise;
        return;
    }

    setupPromise = (async () => {
        const categoryData = getYNABCategories();
        const categories = categoryData?.categories || [];
        const categoryInstruction = categories.length > 0
            ? `Use one of the following categories if applicable: ${categories.map(c => c.name).join(', ')}. IF NONE FIT, leave it empty.`
            : `Suggest generic categories like "Dining Out", "Groceries", "Transportation", "Entertainment", "Shopping".`;

        let systemPrompt = localStorage.getItem(AI_CONFIG_KEYS.systemPrompt) || DEFAULT_SYSTEM_PROMPT;
        if (systemPrompt.includes('{{CATEGORIES}}')) {
            systemPrompt = systemPrompt.replace('{{CATEGORIES}}', categoryInstruction);
        }

        try {
            const options = {
                expectedInputs: [{ type: "text", languages: ["en", "ja"] }, { type: "image" }],
                initialPrompts: [{ role: 'system', content: systemPrompt }],
                expectedOutputs: [{ type: "text", languages: ["ja"] }]
            };

            if (supportsSamplingMode()) {
                options.samplingMode = localStorage.getItem(AI_CONFIG_KEYS.samplingMode) || 'most-predictable';
            } else {
                const tempStr = localStorage.getItem(AI_CONFIG_KEYS.temperature);
                options.temperature = tempStr !== null ? parseFloat(tempStr) : 0.0;

                const topKStr = localStorage.getItem(AI_CONFIG_KEYS.topK);
                if (topKStr) {
                    options.topK = parseInt(topKStr);
                } else if (typeof LanguageModel.params === 'function') {
                    const params = await LanguageModel.params();
                    options.topK = params.defaultTopK;
                }
            }

            baseSession = await LanguageModel.create(options);
            console.log('AI Setup successful');

            if (warmUpSession) {
                warmUpSession.destroy();
                warmUpSession = null;
            }
        } catch (err) {
            console.warn('AI Setup failed:', err);
            throw err;
        }
    })();

    try {
        await setupPromise;
    } finally {
        setupPromise = null;
    }
}

async function getAISession() {
    if (!baseSession) {
        await setupAI();
    }
    if (!baseSession) throw new Error("Could not initialize AI session");
    return await baseSession.clone();
}

// --- AI Extraction Task Runner ---

export async function runAIExtraction(imageInput, card, fileName) {
    return aiQueue.add(async () => {
        if (!document.body.contains(card)) return;

        card.classList.remove('queued');
        card.classList.add('processing');
        updateProgressCounter();

        let session = null;
        try {
            session = await getAISession();
            const images = Array.isArray(imageInput) ? imageInput : [imageInput];

            let schema;
            try {
                const schemaText = localStorage.getItem(AI_CONFIG_KEYS.schema) || DEFAULT_SCHEMA;
                schema = JSON.parse(schemaText);
            } catch {
                schema = JSON.parse(DEFAULT_SCHEMA);
            }

            performance.mark(`start-ai-extraction-${fileName}`);

            // Build User Hints from card input fields
            const hints = [
                { label: 'Merchant', val: card.querySelector('.merchant-input').value.trim() },
                { label: 'Transaction date', val: card.querySelector('.date-input').value.trim() },
                { label: 'Transaction amount', val: card.querySelector('.amount-input').value.trim() },
                { label: 'Category', val: card.querySelector('.category-input').value.trim() }
            ]
            .filter(h => h.val)
            .map(h => `${h.label} is likely: "${h.val}"`);

            let userPrompt = localStorage.getItem(AI_CONFIG_KEYS.userPrompt) || DEFAULT_USER_PROMPT;
            if (hints.length > 0) {
                userPrompt += "\n\nUser hints:\n" + hints.map(h => `- ${h}`).join('\n') + 
                              "\nPlease prioritize these hints if they match the receipt contents.";
            }

            const promptContent = [
                { role: 'user', content: [{ type: 'text', value: userPrompt }, ...images.map(blob => ({ type: 'image', value: blob }))] }
            ];

            const resultText = await session.prompt(promptContent, { responseConstraint: schema });

            performance.mark(`end-ai-extraction-${fileName}`);
            const data = JSON.parse(resultText);
            updateReceiptCard(card, data);
        } catch (err) {
            console.error('AI Processing error:', err);
            showToast(`AI failed for ${fileName}`, 'error');
            card.classList.remove('processing');
            updateProgressCounter();
        } finally {
            if (session) {
                try {
                    session.destroy();
                } catch {}
            }
        }
    });
}
