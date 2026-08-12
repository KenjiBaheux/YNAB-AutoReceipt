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
      "items": {
        "type": "string"
      },
      "description": "Up to 5 merchant candidates, most likely first"
    },
    "dates": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Up to 5 date candidates (YYYY-MM-DD), most likely first"
    },
    "amounts": {
      "type": "array",
      "items": {
        "type": "integer"
      },
      "description": "Up to 5 amount candidates (whole numbers), most likely first"
    },
    "categories": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Up to 5 suggested YNAB categories, most likely first"
    }
  },
  "required": [
    "merchants",
    "dates",
    "amounts",
    "categories"
  ]
}`;

/**
 * Returns true if the browser supports the new Chrome 151+ samplingMode API.
 * The old API exposed LanguageModel.params(); the new one removed it.
 */
export function supportsSamplingMode() {
    return typeof LanguageModel !== 'undefined' && typeof LanguageModel.params !== 'function';
}

export const DEFAULT_SYSTEM_PROMPT = `You are a Japanese receipt parser. Extract Merchant name, Date (YYYY-MM-DD), Total Amount as a whole integer, and Category.

Provide up to 3 candidates for each field, ordered by likelihood (most likely first).
If a field is very certain, you can provide fewer candidates.
Omit any explanations.

Hints for extractions:
- **Total Amount**: Usually preceded by the symbol "¥", and typically presented in a larger or bold font and after the "合計" label (do not confuse with "小計"). Japanese Yen does not use cents/decimals.
- **Date**: Look for "YYYY/MM/DD", "YYYY-MM-DD", or "YYYY年MM月DD日". It's often at the top and may be followed by a time (HH:mm).
- **Merchant**: Usually at the very top. It's often followed by an address or phone number. Do not confuse generic terms like "領収書" (Receipt) with the vendor name.
- **Category**: Suggest possible YNAB categories.

{{CATEGORIES}}`;

export const DEFAULT_USER_PROMPT = "Extract JSON from this receipt:";

let baseSession = null;
let warmUpSession = null;
let setupPromise = null;

export const aiQueue = {
    queue: [],
    activeCount: 0,
    
    getMaxConcurrency() {
        const val = localStorage.getItem(AI_CONFIG_KEYS.concurrency);
        return val ? Math.max(1, parseInt(val)) : 1;
    },

    async add(taskFn) {
        return new Promise((resolve, reject) => {
            this.queue.push({ taskFn, resolve, reject });
            this.processNext();
        });
    },

    async processNext() {
        const maxConcurrency = this.getMaxConcurrency();
        while (this.activeCount < maxConcurrency && this.queue.length > 0) {
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
            expectedOutputs: [
                { type: "text", languages: ["ja"] }
            ]
        });

        if (availability === 'available') {
            dot.className = 'dot ok';
            text.textContent = 'AI Model Ready';
            showToast('Built-in AI is ready!', 'success');
            warmUpAI(); // Trigger warm-up in background
        } else if (availability === 'downloadable') {
            dot.className = 'dot loading';
            text.textContent = 'AI Model downloading...';
            showToast('AI Model needs to be downloaded. Please wait.', 'info');
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

    performance.mark('start-ai-warm-up');
    try {
        const options = {
            expectedInputs: [
                { type: "text", languages: ["en", "ja"] },
                { type: "image" }
            ],
            initialPrompts: [
                {
                    role: 'system', content: `Respond with '.' only.`
                }
            ],
            expectedOutputs: [
                { type: "text", languages: ["ja"] }
            ]
        };

        if (supportsSamplingMode()) {
            // Chrome 151+: use semantic samplingMode
            options.samplingMode = 'most-predictable';
        } else {
            // Legacy: use raw temperature / topK
            options.temperature = 0.0;
            options.topK = 1;
        }

        const dummySession = await LanguageModel.create(options);

        // Dummy prompt to trigger model loading/warming
        await dummySession.prompt([{ role: 'user', content: [{ type: 'text', value: '.' }] }]);

        warmUpSession = dummySession;

        performance.mark('end-ai-warm-up');
        performance.measure('AI Warm-up duration', 'start-ai-warm-up', 'end-ai-warm-up');

        // Access the result programmatically
        const measure = performance.getEntriesByName('AI Warm-up duration')[0];
        console.log('AI Warm-up successful; duration:', measure.duration);
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
    console.log('AI Session reset (will re-initialize with fresh settings on next use)');
}

export function destroyAISession() {
    setupPromise = null;
    if (baseSession) {
        baseSession.destroy();
        baseSession = null;
        console.log('Global AI Session destroyed');
    }
    if (warmUpSession) {
        warmUpSession.destroy();
        warmUpSession = null;
        console.log('Warm-up AI Session destroyed');
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
        const categories = (categoryData && categoryData.categories) ? categoryData.categories : [];
        const categoryInstruction = categories.length > 0
            ? `Use one of the following categories if applicable: ${categories.map(c => c.name).join(', ')}. IF NONE FIT, leave it empty.`
            : `Suggest generic categories like "Dining Out", "Groceries", "Transportation", "Entertainment", "Shopping".`;

        let systemPrompt = localStorage.getItem(AI_CONFIG_KEYS.systemPrompt) || DEFAULT_SYSTEM_PROMPT;
        if (systemPrompt.includes('{{CATEGORIES}}')) {
            systemPrompt = systemPrompt.replace('{{CATEGORIES}}', categoryInstruction);
        }

        performance.mark('start-ai-setup');

        try {
            const options = {
                expectedInputs: [
                    { type: "text", languages: ["en", "ja"] },
                    { type: "image" }
                ],
                initialPrompts: [
                    {
                        role: 'system', content: systemPrompt
                    }
                ],
                expectedOutputs: [
                    { type: "text", languages: ["ja"] }
                ]
            };

            if (supportsSamplingMode()) {
                // Chrome 151+: use semantic samplingMode enum
                const savedMode = localStorage.getItem(AI_CONFIG_KEYS.samplingMode);
                options.samplingMode = savedMode || 'most-predictable';
            } else {
                // Legacy Chrome (<151): use raw temperature / topK
                const tempStr = localStorage.getItem(AI_CONFIG_KEYS.temperature);
                options.temperature = tempStr !== null ? parseFloat(tempStr) : 0.0;

                const topKStr = localStorage.getItem(AI_CONFIG_KEYS.topK);
                if (topKStr !== null && topKStr !== '') {
                    options.topK = parseInt(topKStr);
                } else if (typeof LanguageModel.params === 'function') {
                    const params = await LanguageModel.params();
                    options.topK = params.defaultTopK;
                }
            }

            baseSession = await LanguageModel.create(options);

            performance.mark('end-ai-setup');
            const measure = performance.measure('AI Setup duration', 'start-ai-setup', 'end-ai-setup');
            console.log('AI Setup successful; duration:', measure.duration);

            // Cleanup warm-up session now that we have a base session
            if (warmUpSession) {
                warmUpSession.destroy();
                warmUpSession = null;
                console.log('Warm-up session cleaned up after successful setup');
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

    // Clone the base session so each extraction starts from the clean system prompt
    return await baseSession.clone();
}

export async function runAIExtraction(imageInput, card, fileName) {
    return aiQueue.add(async () => {
        // Skip if card has been dismissed or pushed already
        if (!document.body.contains(card)) {
            return;
        }

        // Set card status to active processing
        card.classList.remove('queued');
        card.classList.add('processing');
        updateProgressCounter();

        let session = null;
        try {
            session = await getAISession();
            const images = Array.isArray(imageInput) ? imageInput : [imageInput];

            if (images.length > 1) {
                console.log(`Processing tall receipt in ${images.length} chunks for ${fileName}`);
            }

            let schema;
            try {
                const schemaText = localStorage.getItem(AI_CONFIG_KEYS.schema) || DEFAULT_SCHEMA;
                schema = JSON.parse(schemaText);
            } catch (err) {
                console.warn('Failed to parse AI schema from settings, using default:', err);
                schema = JSON.parse(DEFAULT_SCHEMA);
            }

            performance.mark(`start-ai-extraction-${fileName}`);

            // Retrieve user hints from active inputs (in case user filled them manually while in queue)
            const merchantHint = card.querySelector('.merchant-input').value.trim();
            const dateHint = card.querySelector('.date-input').value.trim();
            const amountHint = card.querySelector('.amount-input').value.trim();
            const categoryHint = card.querySelector('.category-input').value.trim();

            let hints = [];
            if (merchantHint) hints.push(`Merchant is likely: "${merchantHint}"`);
            if (dateHint) hints.push(`Transaction date is likely: "${dateHint}"`);
            if (amountHint) hints.push(`Transaction amount is likely: ${amountHint}`);
            if (categoryHint) hints.push(`Category is likely: "${categoryHint}"`);

            const userPromptTemplate = localStorage.getItem(AI_CONFIG_KEYS.userPrompt) || DEFAULT_USER_PROMPT;
            let userPrompt = userPromptTemplate;
            if (hints.length > 0) {
                userPrompt += "\n\nUser hints:\n" + hints.map(h => `- ${h}`).join('\n') + "\nPlease prioritize these hints if they match the receipt contents.";
            }

            const promptContent = [
                { role: 'user', content: [{ type: 'text', value: userPrompt }] }
            ];

            // Add images to the prompt
            images.forEach(blob => {
                promptContent[0].content.push({ type: 'image', value: blob });
            });

            const resultText = await session.prompt(promptContent, { responseConstraint: schema });

            performance.mark(`end-ai-extraction-${fileName}`);
            const measure = performance.measure('AI Extraction duration', `start-ai-extraction-${fileName}`, `end-ai-extraction-${fileName}`);
            console.log('AI Extraction successful; duration:', measure.duration);

            const data = JSON.parse(resultText);
            updateReceiptCard(card, data);
        } catch (err) {
            console.error('AI Processing error:', err);
            showToast(`AI failed for ${fileName}`, 'error');
            // Revert state so card remains editable/pushable on failure
            card.classList.remove('processing');
            updateProgressCounter();
        } finally {
            if (session) {
                try {
                    session.destroy();
                } catch (destroyErr) {
                    console.warn('Failed to destroy session:', destroyErr);
                }
            }
        }
    });
}
