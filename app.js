/**
 * YNAB Receipt Porter - Core Application Logic
 */

// --- Constants & State ---
const CONFIG = {
    processedFilesKey: 'ynab_receipt_porter_processed',
    ynabKeyPath: 'ynab_api_key',
    ynabBudgetIdPath: 'ynab_budget_id',
    ynabAccountIdPath: 'ynab_account_id'
};

let processedFiles = new Set(JSON.parse(localStorage.getItem(CONFIG.processedFilesKey) || '[]'));
let baseSession = null;
let directoryHandle = null;

// --- DOM Elements ---
const DOM = {
    apiKey: document.getElementById('ynab-api-key'),
    budgetId: document.getElementById('ynab-budget-id'),
    accountId: document.getElementById('ynab-account-id'),
    btnSync: document.getElementById('btn-sync-folder'),
    aiStatus: document.getElementById('ai-status'),
    receiptList: document.getElementById('receipt-list'),
    processedCount: document.getElementById('processed-count'),
    toastContainer: document.getElementById('toast-container')
};

// --- Initialization ---
async function init() {
    // Load saved settings
    DOM.apiKey.value = localStorage.getItem(CONFIG.ynabKeyPath) || '';
    DOM.budgetId.value = localStorage.getItem(CONFIG.ynabBudgetIdPath) || '';
    DOM.accountId.value = localStorage.getItem(CONFIG.ynabAccountIdPath) || '';

    // Save settings on change
    [DOM.apiKey, DOM.budgetId, DOM.accountId].forEach(el => {
        el.addEventListener('change', (e) => {
            localStorage.setItem(e.target.id.replace(/-/g, '_'), e.target.value);
        });
    });

    await checkAIAvailability();
    DOM.btnSync.addEventListener('click', handleFolderSync);
}

// --- AI Logic ---
async function checkAIAvailability() {
    const dot = DOM.aiStatus.querySelector('.dot');
    const text = DOM.aiStatus.querySelector('.status-text');

    dot.className = 'dot loading';
    text.textContent = 'Checking AI availability...';

    try {
        if (typeof LanguageModel === 'undefined') {
            throw new Error('LanguageModel API not found. Please use Chrome Dev/Canary.');
        }

        const availability = await LanguageModel.availability({ languages: ['ja', 'en'] });

        if (availability === 'available') {
            dot.className = 'dot ok';
            text.textContent = 'AI Model Ready';
            showToast('Chrome AI is ready!', 'success');
            warmUpAI(); // Trigger warm-up in background
        } else if (availability === 'downloadable') {
            dot.className = 'dot loading';
            text.textContent = 'AI Model downloading...';
            showToast('AI Model needs to download. Please wait.', 'info');
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

async function warmUpAI() {
    if (baseSession) return;

    try {
        baseSession = await LanguageModel.create({
            expectedInputs: [
                { type: "text", languages: ["en", "ja"] },
                { type: "image" }
            ],
            initialPrompts: [
                {
                    role: 'system', content: `You are a Japanese receipt parser. Extract Merchant name, Date (YYYY-MM-DD), and Total Amount as a whole integer. 

            Hints for extractions:
            - **Total Amount**: Usually in a larger or bold font, preceded by "合計" or the symbol "¥". Japanese Yen does not use cents/decimals.
            - **Date**: Look for "YYYY/MM/DD", "YYYY-MM-DD", or "YYYY年MM月DD日". It's often at the top and may be followed by a time (HH:mm).
            - **Merchant**: Usually at the very top. It's often followed by an address or phone number. Do not confuse generic terms like "領収書" (Receipt) with the vendor name.
            ` }
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

// --- File System Logic ---
async function handleFolderSync() {
    try {
        directoryHandle = await window.showDirectoryPicker();
        showToast('Folder connected!', 'success');
        await scanFolder();
    } catch (err) {
        if (err.name !== 'AbortError') {
            showToast('Folder access failed: ' + err.message, 'error');
        }
    }
}

async function scanFolder() {
    if (!directoryHandle) return;

    let totalPending = 0;
    for await (const entry of directoryHandle.values()) {
        if (entry.kind === 'file' && isImage(entry.name) && !processedFiles.has(entry.name)) {
            totalPending++;
            processReceipt(entry);
        }
    }
    DOM.processedCount.textContent = totalPending;

    if (totalPending === 0) {
        showToast('No new receipts found.', 'info');
    }
}

function isImage(filename) {
    return /\.(jpe?g|png|webp)$/i.test(filename);
}

async function processReceipt(fileHandle) {
    const file = await fileHandle.getFile();
    const fileName = fileHandle.name;

    // Create UI Card
    const card = createReceiptCard(fileName, file);
    if (DOM.receiptList.querySelector('.empty-state')) {
        DOM.receiptList.innerHTML = '';
    }
    DOM.receiptList.appendChild(card);

    try {
        const session = await getAISession();
        const imageBlob = file;

        const schema = {
            type: "object",
            properties: {
                merchant: { type: "string" },
                date: { type: "string" },
                amount: { type: "integer" }
            }
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

// --- UI Helpers ---
let cardCounter = 0;

function createReceiptCard(fileName, file) {
    cardCounter++;
    const card = document.createElement('div');
    card.className = 'receipt-card';
    card.id = `receipt-${cardCounter}`;

    const url = URL.createObjectURL(file);

    card.innerHTML = `
        <div class="receipt-preview-container" title="Click to enlarge">
            <img src="${url}" class="receipt-preview" alt="Receipt preview">
            <div class="zoom-badge">🔍 Zoom</div>
        </div>
        <div class="receipt-info">
            <div class="field-group">
                <label>Merchant</label>
                <input type="text" class="edit-input merchant-input" placeholder="Analyzing...">
            </div>
            <div class="field-group">
                <label>Date</label>
                <input type="date" class="edit-input date-input">
            </div>
            <div class="field-group">
                <label>Amount (JPY)</label>
                <div class="amount-display">
                    <span class="currency-symbol">¥</span>
                    <input type="number" class="edit-input amount-input" placeholder="0">
                </div>
            </div>
        </div>
        <div class="card-actions">
            <button class="btn btn-small btn-push" disabled>Push to YNAB</button>
            <button class="btn btn-small btn-dismiss">Dismiss</button>
        </div>
    `;

    // Modal logic
    card.querySelector('.receipt-preview-container').addEventListener('click', () => {
        const modal = document.getElementById('full-view-modal');
        const modalImg = document.getElementById('full-receipt-img');
        modal.style.display = 'block';
        modalImg.src = url;
        modalImg.classList.remove('zoomed'); // Reset zoom on open
        document.body.classList.add('modal-open');
    });

    card.querySelector('.btn-push').addEventListener('click', () => pushToYNAB(card, fileName));
    card.querySelector('.btn-dismiss').addEventListener('click', () => {
        card.remove();
        markAsProcessed(fileName);
    });

    return card;
}

function updateReceiptCard(card, data) {
    card.querySelector('.merchant-input').value = data.merchant || '';
    card.querySelector('.date-input').value = normalizeDate(data.date) || '';
    card.querySelector('.amount-input').value = data.amount || 0;
    card.querySelector('.btn-push').disabled = false;
}

/**
 * Normalizes various date formats to YYYY-MM-DD for HTML date inputs
 * Handles: 2026/01/01, 2026年01月01日, 2026.01.01, etc.
 */
function normalizeDate(dateStr) {
    if (!dateStr) return '';

    // Replace common separators with dash
    let clean = dateStr.replace(/[年月日\/\.]/g, '-');
    // Remove trailing dash (often from '日')
    clean = clean.replace(/-$/, '');

    const parts = clean.split('-').filter(p => p.trim() !== '');
    if (parts.length >= 3) {
        let [y, m, d] = parts;
        // Basic padding
        m = m.padStart(2, '0');
        d = d.padStart(2, '0');
        // Ensure 4-digit year
        if (y.length === 2) y = '20' + y;

        const iso = `${y}-${m}-${d}`;
        // Validate it's a real date
        if (!isNaN(Date.parse(iso))) {
            return iso;
        }
    }
    return ''; // Return empty if invalid to avoid browser warnings
}

// --- YNAB Logic ---
async function pushToYNAB(card, fileName) {
    const apiKey = DOM.apiKey.value;
    const budgetId = DOM.budgetId.value;
    const accountId = DOM.accountId.value;

    if (!apiKey || !budgetId || !accountId) {
        showToast('Please fill in all YNAB settings.', 'error');
        return;
    }

    const merchant = card.querySelector('.merchant-input').value;
    const date = card.querySelector('.date-input').value;
    const amountVal = card.querySelector('.amount-input').value;

    if (!merchant || !date || !amountVal) {
        showToast('Please verify all fields before pushing.', 'error');
        return;
    }

    const amount = parseInt(amountVal) * 1000; // JPY Amount * 1000 for YNAB milliunits

    const transaction = {
        transaction: {
            account_id: accountId,
            date: date,
            amount: -Math.abs(amount), // Outflow
            payee_name: merchant,
            cleared: 'cleared'
        }
    };

    try {
        const response = await fetch(`https://api.ynab.com/v1/budgets/${budgetId}/transactions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(transaction)
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error.detail || 'YNAB API error');
        }

        showToast(`Synced ${card.dataset.merchant} to YNAB!`, 'success');
        card.classList.add('synced');
        setTimeout(() => {
            card.remove();
            markAsProcessed(fileName);
        }, 500);
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function markAsProcessed(fileName) {
    processedFiles.add(fileName);
    localStorage.setItem(CONFIG.processedFilesKey, JSON.stringify([...processedFiles]));
}

// --- Utilities ---
function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    DOM.toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
}

// --- Global Modal Listeners ---
function closeModal() {
    const modal = document.getElementById('full-view-modal');
    const modalImg = document.getElementById('full-receipt-img');
    modal.style.display = 'none';
    modalImg.classList.remove('zoomed');
    document.body.classList.remove('modal-open');
}

// Zoom gestures
const modalImg = document.getElementById('full-receipt-img');
modalImg?.addEventListener('click', (e) => {
    e.stopPropagation(); // Don't close modal when clicking image
    modalImg.classList.toggle('zoomed');
});

modalImg?.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (modalImg.classList.contains('zoomed')) {
        modalImg.classList.remove('zoomed');
    }
});

document.querySelector('.close-modal')?.addEventListener('click', closeModal);

window.addEventListener('click', (event) => {
    const modal = document.getElementById('full-view-modal');
    if (event.target === modal) {
        closeModal();
    }
});

window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        closeModal();
    }
});

// Start the app
init();
