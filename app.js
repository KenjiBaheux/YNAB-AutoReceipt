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
let activeRedactionCard = null; // Track which card is currently in the modal

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
                    role: 'system', content: `You are a Japanese receipt parser. Extract Merchant name, Date (YYYY-MM-DD), Total Amount as a whole integer, and Category.
                    
                    Provide up to 5 candidates for each field, ordered by likelihood (most likely first).
                    If a field is very certain, you can provide fewer candidates.

                    Hints for extractions:
                    - **Total Amount**: Usually preceded by the symbol "¥", and typically presented in a larger or bold font and after the "合計" label. Japanese Yen does not use cents/decimals.
                    - **Date**: Look for "YYYY/MM/DD", "YYYY-MM-DD", or "YYYY年MM月DD日". It's often at the top and may be followed by a time (HH:mm).
                    - **Merchant**: Usually at the very top. It's often followed by an address or phone number. Do not confuse generic terms like "領収書" (Receipt) with the vendor name.
                    - **Category**: Suggest possible YNAB categories (e.g., Dining Out, Groceries, Transportation, Entertainment, Shopping).
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

    await runAIExtraction(file, card, fileName);
}

async function runAIExtraction(imageBlob, card, fileName) {
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
                <div class="suggestion-chips merchants-chips"></div>
            </div>
            <div class="field-group">
                <label>Date</label>
                <input type="date" class="edit-input date-input">
                <div class="suggestion-chips dates-chips"></div>
            </div>
            <div class="field-group">
                <label>Amount (JPY)</label>
                <div class="amount-display">
                    <span class="currency-symbol">¥</span>
                    <input type="number" class="edit-input amount-input" placeholder="0">
                </div>
                <div class="suggestion-chips amounts-chips"></div>
            </div>
            <div class="field-group">
                <label>Category (Suggestion)</label>
                <input type="text" class="edit-input category-input" placeholder="Suggested category...">
                <div class="suggestion-chips categories-chips"></div>
            </div>
        </div>
        <div class="card-actions">
            <button class="btn btn-small btn-push" disabled>Push to YNAB</button>
            <button class="btn btn-small btn-dismiss">Dismiss</button>
        </div>
    `;

    // Modal logic
    card.querySelector('.receipt-preview-container').addEventListener('click', () => {
        activeRedactionCard = { card, fileName, file };
        const modal = document.getElementById('full-view-modal');
        const modalImg = document.getElementById('full-receipt-img');
        modal.style.display = 'block';
        modalImg.src = url;
        modalImg.classList.remove('zoomed'); // Reset zoom on open
        document.body.classList.add('modal-open');

        // Reset redaction tool
        document.getElementById('full-view-modal').classList.remove('redact-mode');
        document.getElementById('btn-clear-redaction').style.display = 'none';
        document.getElementById('btn-retry-ai').style.display = 'none';
        clearRedactionCanvas();
    });

    card.querySelector('.btn-push').addEventListener('click', () => pushToYNAB(card, fileName));
    card.querySelector('.btn-dismiss').addEventListener('click', () => {
        card.remove();
        markAsProcessed(fileName);
    });

    return card;
}

function updateReceiptCard(card, data) {
    // Deduplicate candidates while preserving order and normalizing
    const dedupe = (arr) => {
        const seen = new Set();
        return (arr || []).filter(item => {
            if (item === null || item === undefined) return false;
            const normalized = String(item).trim().toLowerCase();
            if (seen.has(normalized)) return false;
            seen.add(normalized);
            return true;
        });
    };

    const merchants = dedupe(data.merchants);
    const dates = dedupe(data.dates);
    const amounts = dedupe(data.amounts);
    const categories = dedupe(data.categories);

    // Set primary values (most likely)
    card.querySelector('.merchant-input').value = merchants[0] || '';
    card.querySelector('.date-input').value = normalizeDate(dates[0]) || '';
    card.querySelector('.amount-input').value = amounts[0] || 0;
    card.querySelector('.category-input').value = categories[0] || '';
    card.querySelector('.btn-push').disabled = false;

    // Render alternative chips
    renderChips(card.querySelector('.merchants-chips'), merchants, val => {
        card.querySelector('.merchant-input').value = val;
    });
    renderChips(card.querySelector('.dates-chips'), dates, val => {
        card.querySelector('.date-input').value = normalizeDate(val);
    });
    renderChips(card.querySelector('.amounts-chips'), amounts, val => {
        card.querySelector('.amount-input').value = val;
    });
    renderChips(card.querySelector('.categories-chips'), categories, val => {
        card.querySelector('.category-input').value = val;
    });
}

function renderChips(container, values, onSelect) {
    container.innerHTML = '';
    // If only one (or no) value, nothing to suggest
    if (values.length <= 1) return;

    values.forEach((val, idx) => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        if (idx === 0) chip.classList.add('active');

        // Formatting for display
        let displayVal = val;
        if (typeof val === 'number') displayVal = `¥${val}`;

        chip.textContent = displayVal;
        chip.title = `Switch to ${displayVal}`;

        chip.addEventListener('click', () => {
            onSelect(val);
            container.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
        });
        container.appendChild(chip);
    });
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
    activeRedactionCard = null;
}

// Redaction Logic
const canvas = document.getElementById('redaction-canvas');
const ctx = canvas.getContext('2d');
let isDrawing = false;
let startX, startY;
let redactions = []; // Store rectangles: {x, y, w, h}

function setupRedactionCanvas() {
    const img = document.getElementById('full-receipt-img');
    canvas.width = img.clientWidth;
    canvas.height = img.clientHeight;
    redrawRedactions();
}

function clearRedactionCanvas() {
    redactions = [];
    ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function redrawRedactions() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'black';
    redactions.forEach(rect => {
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    });
}

document.getElementById('btn-redact-mode').addEventListener('click', (e) => {
    e.stopPropagation();
    const modal = document.getElementById('full-view-modal');
    const isActive = modal.classList.toggle('redact-mode');
    document.getElementById('btn-clear-redaction').style.display = isActive ? 'block' : 'none';
    document.getElementById('btn-retry-ai').style.display = isActive ? 'block' : 'none';
    if (isActive) setupRedactionCanvas();
});

document.getElementById('btn-clear-redaction').addEventListener('click', (e) => {
    e.stopPropagation();
    clearRedactionCanvas();
});

canvas.addEventListener('mousedown', (e) => {
    isDrawing = true;
    const rect = canvas.getBoundingClientRect();
    startX = e.clientX - rect.left;
    startY = e.clientY - rect.top;
});

canvas.addEventListener('mousemove', (e) => {
    if (!isDrawing) return;
    const rect = canvas.getBoundingClientRect();
    const currentX = e.clientX - rect.left;
    const currentY = e.clientY - rect.top;

    redrawRedactions();

    // Draw current preview rectangle
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(startX, startY, currentX - startX, currentY - startY);
    ctx.strokeStyle = 'var(--accent-primary)';
    ctx.lineWidth = 1;
    ctx.strokeRect(startX, startY, currentX - startX, currentY - startY);
});

window.addEventListener('mouseup', (e) => {
    if (!isDrawing) return;
    isDrawing = false;

    const rect = canvas.getBoundingClientRect();
    const endX = e.clientX - rect.left;
    const endY = e.clientY - rect.top;

    const w = endX - startX;
    const h = endY - startY;

    if (Math.abs(w) > 5 && Math.abs(h) > 5) {
        redactions.push({ x: startX, y: startY, w, h });
    }

    redrawRedactions();
});

document.getElementById('btn-retry-ai').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!activeRedactionCard) return;

    const indicator = document.getElementById('retrying-indicator');
    indicator.style.display = 'flex';

    try {
        const redactedBlob = await captureRedactedImage();
        await runAIExtraction(redactedBlob, activeRedactionCard.card, activeRedactionCard.fileName);
        showToast('AI re-processed with redactions!', 'success');
        closeModal();
    } catch (err) {
        showToast('Retry failed: ' + err.message, 'error');
    } finally {
        indicator.style.display = 'none';
    }
});

async function captureRedactedImage() {
    const img = document.getElementById('full-receipt-img');
    const offscreen = document.createElement('canvas');
    const oCtx = offscreen.getContext('2d');

    offscreen.width = img.naturalWidth;
    offscreen.height = img.naturalHeight;

    // Draw original image
    oCtx.drawImage(img, 0, 0);

    // Draw redactions scaled to original size
    oCtx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, img.naturalWidth, img.naturalHeight);

    return new Promise(resolve => offscreen.toBlob(resolve, 'image/jpeg', 0.9));
}

// Zoom gestures
const modalImg = document.getElementById('full-receipt-img');
modalImg?.addEventListener('click', (e) => {
    if (document.getElementById('full-view-modal').classList.contains('redact-mode')) return;
    e.stopPropagation(); // Don't close modal when clicking image
    modalImg.classList.toggle('zoomed');
    setTimeout(setupRedactionCanvas, 350); // Recalculate canvas after zoom transistion
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
