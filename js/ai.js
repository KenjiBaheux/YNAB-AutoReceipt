import { DOM } from './dom.js';
import { showToast, updateProgressCounter } from './ui.js';
import { updateReceiptCard } from './card.js'; // Circular dep, will create card.js next
import { getYNABCategories } from './config.js';

let baseSession = null;

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
    if (baseSession) return;

    performance.mark('start-ai-warm-up');
    try {
        const params = await LanguageModel.params();
        const dummySession = await LanguageModel.create({
            temperature: 0.0,
            topK: 1,
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
        });

        // Dummy prompt to trigger model loading/warming
        await dummySession.prompt([{ role: 'user', content: [{ type: 'text', value: '.' }] }]);

        performance.mark('end-ai-warm-up');
        performance.measure('AI Warm-up duration', 'start-ai-warm-up', 'end-ai-warm-up');

        // Access the result programmatically
        const measure = performance.getEntriesByName('AI Warm-up duration')[0];
        console.log('AI Warm-up successful; duration:', measure.duration);
    } catch (err) {
        console.warn('AI Warm-up failed:', err);
    }
}

export async function setupAI() {
    if (baseSession) return;

    const ynabCategories = getYNABCategories();
    performance.mark('start-ai-setup');

    try {
        const params = await LanguageModel.params();
        baseSession = await LanguageModel.create({
            temperature: 0.0,
            topK: params.defaultTopK,
            expectedInputs: [
                { type: "text", languages: ["en", "ja"] },
                { type: "image" }
            ],
            initialPrompts: [
                {
                    role: 'system', content: `You are a Japanese receipt parser. Extract Merchant name, Date (YYYY-MM-DD), Total Amount as a whole integer, and Category.
                    
                    Provide up to 3 candidates for each field, ordered by likelihood (most likely first).
                    If a field is very certain, you can provide fewer candidates.
                    Omit any explanations.

                    Hints for extractions:
                    - **Total Amount**: Usually preceded by the symbol "¥", and typically presented in a larger or bold font and after the "合計" label. Japanese Yen does not use cents/decimals.
                    - **Date**: Look for "YYYY/MM/DD", "YYYY-MM-DD", or "YYYY年MM月DD日". It's often at the top and may be followed by a time (HH:mm).
                    - **Merchant**: Usually at the very top. It's often followed by an address or phone number. Do not confuse generic terms like "領収書" (Receipt) with the vendor name.
                    - **Category**: Suggest possible YNAB categories.
                    
                    ${ynabCategories.length > 0
                            ? `Use one of the following categories if applicable: ${ynabCategories.map(c => c.name).join(', ')}. IF NONE FIT, leave it empty.`
                            : `Suggest generic categories like "Dining Out", "Groceries", "Transportation", "Entertainment", "Shopping".`}
                    ` }
            ],
            expectedOutputs: [
                { type: "text", languages: ["ja"] }
            ]
        });

        performance.mark('end-ai-setup');
        const measure = performance.measure('AI Setup duration', 'start-ai-setup', 'end-ai-setup');
        console.log('AI Setup successful; duration:', measure.duration);
    } catch (err) {
        console.warn('AI Setup failed:', err);
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

export async function runAIExtraction(imageBlob, card, fileName) {
    try {
        const session = await getAISession();

        const schema = {
            type: "object",
            properties: {
                merchants: { type: "array", items: { type: "string" }, description: "Up to 5 merchant candidates, most likely first" },
                dates: { type: "array", items: { type: "string" }, description: "Up to 5 date candidates (YYYY-MM-DD), most likely first" },
                amounts: { type: "array", items: { type: "integer" }, description: "Up to 5 amount candidates (whole numbers), most likely first" },
                categories: { type: "array", items: { type: "string" }, description: "Up to 5 suggested YNAB categories, most likely first" }
            },
            required: ["merchants", "dates", "amounts", "categories"]
        };

        performance.mark(`start-ai-extraction-${fileName}`);
        const resultText = await session.prompt([
            {
                role: 'user',
                content: [
                    { type: 'text', value: "Extract JSON from this receipt:" },
                    { type: 'image', value: imageBlob }
                ]
            }
        ], { responseConstraint: schema });

        performance.mark(`end-ai-extraction-${fileName}`);
        const measure = performance.measure('AI Extraction duration', `start-ai-extraction-${fileName}`, `end-ai-extraction-${fileName}`);
        console.log('AI Extraction successful; duration:', measure.duration);

        const data = JSON.parse(resultText);
        updateReceiptCard(card, data);
    } catch (err) {
        console.error('AI Processing error:', err);
        showToast(`AI failed for ${fileName}`, 'error');
    }
}
