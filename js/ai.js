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

        const availability = await LanguageModel.availability({ languages: ['ja', 'en'] });

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

    const ynabCategories = getYNABCategories();

    try {
        baseSession = await LanguageModel.create({
            expectedInputs: [
                { type: "text", languages: ["en", "ja"] },
                { type: "image" }
            ],
            initialPrompts: [
                {
                    role: 'system', content: `You are a Japanese receipt parser. Extract Merchant name, Date (YYYY-MM-DD), Total Amount as a whole integer, and Category.
                    
                    Provide up to 3 candidates for each field, ordered by likelihood (most likely first).
                    If a field is very certain, you can provide fewer candidates.

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

        // Dummy prompt to trigger model loading/warming
        await baseSession.prompt([{ role: 'user', content: [{ type: 'text', value: 'Warm up' }] }]);
        console.log('AI Warm-up successful');
    } catch (err) {
        console.warn('AI Warm-up failed:', err);
    }
}

async function getAISession() {
    if (!baseSession) {
        await warmUpAI();
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

        const resultText = await session.prompt([
            {
                role: 'user',
                content: [
                    { type: 'text', value: "Extract JSON from this receipt:" },
                    { type: 'image', value: imageBlob }
                ]
            }
        ], { responseConstraint: schema });

        const data = JSON.parse(resultText);
        updateReceiptCard(card, data);
    } catch (err) {
        console.error('AI Processing error:', err);
        showToast(`AI failed for ${fileName}`, 'error');
    }
}
