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

    // Preprocess image (crop whitespace)
    let optimizedBlob, optimizedUrl, autoBounds;
    try {
        const optimized = await optimizeImageForAI(file);
        optimizedBlob = optimized.blob;
        optimizedUrl = optimized.url;
        autoBounds = optimized.bounds;
    } catch (err) {
        console.warn('Image optimization failed, using original:', err);
        optimizedBlob = file;
        optimizedUrl = URL.createObjectURL(file);
        autoBounds = null; // Signal full image
    }

    // Create UI Card
    const card = createReceiptCard(fileName, optimizedBlob, optimizedUrl, file, autoBounds);
    if (DOM.receiptList.querySelector('.empty-state')) {
        DOM.receiptList.innerHTML = '';
    }
    DOM.receiptList.appendChild(card);

    await runAIExtraction(optimizedBlob, card, fileName);
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

function createReceiptCard(fileName, optimizedBlob, displayUrl, originalFile, autoBounds) {
    cardCounter++;
    const card = document.createElement('div');
    card.className = 'receipt-card';
    card.id = `receipt-${cardCounter}`;
    card.dataset.bounds = JSON.stringify(autoBounds);
    card.dataset.redactions = JSON.stringify([]);

    // Store original URL as well
    const originalUrl = URL.createObjectURL(originalFile);
    card.dataset.originalUrl = originalUrl;

    card.innerHTML = `
        <div class="receipt-preview-container" title="Click to enlarge">
            <img src="${displayUrl}" class="receipt-preview" alt="Receipt preview">
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
        const currentBounds = card.dataset.bounds ? JSON.parse(card.dataset.bounds) : null;
        const currentRedactions = card.dataset.redactions ? JSON.parse(card.dataset.redactions) : [];

        activeRedactionCard = {
            card,
            fileName,
            file: originalFile,
            optimizedBlob,
            bounds: currentBounds ? { ...currentBounds } : null,
            redactions: [...currentRedactions],
            initialBounds: currentBounds ? { ...currentBounds } : null,
            initialRedactions: [...currentRedactions]
        };
        const modal = document.getElementById('full-view-modal');
        const modalImg = document.getElementById('full-receipt-img');
        modal.style.display = 'block';
        modalImg.src = card.dataset.originalUrl;
        modalImg.classList.remove('zoomed'); // Reset zoom on open
        document.body.classList.add('modal-open');

        // Always show Retry button when modal is open
        document.getElementById('btn-retry-ai').style.display = 'block';

        // Setup Cropping Visualization
        setupCroppingUI(modalImg, activeRedactionCard.bounds);

        // Setup Redactions
        redactions = [...activeRedactionCard.redactions];
        renderRedactions();
        updateModalToolbar();

        if (modal.classList.contains('redact-mode')) {
            setupRedactionCanvas();
        } else {
            clearRedactionCanvas();
        }
    });

    card.querySelector('.btn-push').addEventListener('click', () => pushToYNAB(card, fileName));
    card.querySelector('.btn-dismiss').addEventListener('click', () => {
        card.remove();
        markAsProcessed(fileName);
    });

    return card;
}

function updateReceiptCard(card, data) {
    card.classList.remove('processing');
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

// --- Image Processing Utilities ---
async function optimizeImageForAI(file) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d', { willReadFrequently: true });

            // Limit analysis size to avoid performance issues
            const scale = Math.min(1, 1500 / Math.max(img.width, img.height));
            canvas.width = img.width * scale;
            canvas.height = img.height * scale;
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const bounds = findContentBounds(imageData);

            // Map bounds back to original size
            const finalBounds = {
                top: Math.max(0, (bounds.top / scale) - 20),
                bottom: Math.min(img.height, (bounds.bottom / scale) + 20),
                left: Math.max(0, (bounds.left / scale) - 20),
                right: Math.min(img.width, (bounds.right / scale) + 20)
            };

            const cropWidth = finalBounds.right - finalBounds.left;
            const cropHeight = finalBounds.bottom - finalBounds.top;

            const finalCanvas = document.createElement('canvas');
            finalCanvas.width = cropWidth;
            finalCanvas.height = cropHeight;
            const finalCtx = finalCanvas.getContext('2d');
            finalCtx.drawImage(img, finalBounds.left, finalBounds.top, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

            finalCanvas.toBlob(blob => {
                resolve({
                    blob,
                    url: URL.createObjectURL(blob),
                    bounds: finalBounds
                });
            }, 'image/jpeg', 0.9);
        };
        img.onerror = reject;
        img.src = URL.createObjectURL(file);
    });
}

function findContentBounds(imageData) {
    const { width, height, data } = imageData;
    let top = 0, bottom = height, left = 0, right = width;

    // Helper to check if a pixel is "not background"
    // We assume background is mostly white/light
    const isContent = (x, y) => {
        const idx = (y * width + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        // Threshold: If any channel is < 230 (not pure white) or variation is high
        return r < 235 || g < 235 || b < 235;
    };

    // Scan from top
    for (let y = 0; y < height; y++) {
        let hasContent = false;
        for (let x = 0; x < width; x++) {
            if (isContent(x, y)) {
                hasContent = true;
                break;
            }
        }
        if (hasContent) {
            top = y;
            break;
        }
    }

    // Scan from bottom
    for (let y = height - 1; y >= top; y--) {
        let hasContent = false;
        for (let x = 0; x < width; x++) {
            if (isContent(x, y)) {
                hasContent = true;
                break;
            }
        }
        if (hasContent) {
            bottom = y;
            break;
        }
    }

    // Scan from left
    for (let x = 0; x < width; x++) {
        let hasContent = false;
        for (let y = top; y <= bottom; y++) {
            if (isContent(x, y)) {
                hasContent = true;
                break;
            }
        }
        if (hasContent) {
            left = x;
            break;
        }
    }

    // Scan from right
    for (let x = width - 1; x >= left; x--) {
        let hasContent = false;
        for (let y = top; y <= bottom; y++) {
            if (isContent(x, y)) {
                hasContent = true;
                break;
            }
        }
        if (hasContent) {
            right = x;
            break;
        }
    }

    return { top, bottom, left, right };
}

function updateModalToolbar() {
    const modal = document.getElementById('full-view-modal');
    const isRedactMode = modal.classList.contains('redact-mode');
    document.getElementById('btn-delete-redaction').style.display = (isRedactMode && selectedRedactionIndex !== -1) ? 'block' : 'none';
    document.getElementById('btn-clear-redaction').style.display = (isRedactMode && redactions.length > 0) ? 'block' : 'none';
}

function renderRedactions() {
    const container = document.getElementById('redactions-container');
    container.innerHTML = '';
    const img = document.getElementById('full-receipt-img');
    const rect = img.getBoundingClientRect();
    const scaleX = rect.width / img.naturalWidth;
    const scaleY = rect.height / img.naturalHeight;

    redactions.forEach((r, index) => {
        const div = document.createElement('div');
        div.className = `redaction-block ${index === selectedRedactionIndex ? 'selected' : ''}`;
        div.style.left = `${r.x * scaleX}px`;
        div.style.top = `${r.y * scaleY}px`;
        div.style.width = `${r.w * scaleX}px`;
        div.style.height = `${r.h * scaleY}px`;

        if (index === selectedRedactionIndex) {
            // Add handles for selected block
            const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
            handles.forEach(h => {
                const handle = document.createElement('div');
                handle.className = `crop-handle handle-${h}`;
                handle.dataset.handle = h;
                div.appendChild(handle);
            });
        }

        div.addEventListener('mousedown', (e) => {
            if (!document.getElementById('full-view-modal').classList.contains('redact-mode')) return;
            e.stopPropagation();
            selectedRedactionIndex = index;
            renderRedactions();
            updateModalToolbar();

            // Start drag logic
            startBoxInteraction(e, 'redaction', index);
        });

        container.appendChild(div);
    });
}

function startBoxInteraction(e, type, index = -1) {
    isBoxDragging = true;
    interactionType = type;
    interactionIndex = index;
    activeHandle = e.target.dataset.handle;
    dragStartX = e.clientX;
    dragStartY = e.clientY;

    if (type === 'crop') {
        initialBoxRect = { ...activeRedactionCard.bounds };
    } else {
        initialBoxRect = { ...redactions[index] };
    }
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
function closeModal(isApplying = false) {
    if (isApplying && activeRedactionCard) {
        // Commit changes to the card dataset
        activeRedactionCard.card.dataset.bounds = JSON.stringify(activeRedactionCard.bounds);
        activeRedactionCard.card.dataset.redactions = JSON.stringify(redactions);

        // Start background extraction
        runBackgroundExtraction(activeRedactionCard.card, activeRedactionCard.file, activeRedactionCard.fileName);
    }

    const modal = document.getElementById('full-view-modal');
    const modalImg = document.getElementById('full-receipt-img');
    const cropBox = document.getElementById('crop-box');
    modal.style.display = 'none';
    modalImg.classList.remove('zoomed');
    cropBox.style.display = 'none';
    document.body.classList.remove('modal-open');
    activeRedactionCard = null;
    redactions = [];
}


// Redaction Logic
const canvas = document.getElementById('redaction-canvas');
const ctx = canvas.getContext('2d');
let isDrawing = false;
let startX, startY;
let redactions = []; // Store rectangles: {x, y, w, h}
let selectedRedactionIndex = -1;
let isBoxDragging = false;
let activeHandle = null;
let dragStartX, dragStartY;
let initialBoxRect = null;
let interactionType = 'crop'; // 'crop' or 'redaction'
let interactionIndex = -1;

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

    const img = document.getElementById('full-receipt-img');
    const scaleX = canvas.width / img.naturalWidth;
    const scaleY = canvas.height / img.naturalHeight;

    redactions.forEach(rect => {
        ctx.fillRect(rect.x * scaleX, rect.y * scaleY, rect.w * scaleX, rect.h * scaleY);
    });
}

document.getElementById('btn-redact-mode').addEventListener('click', (e) => {
    e.stopPropagation();
    const modal = document.getElementById('full-view-modal');
    const isActive = modal.classList.toggle('redact-mode');

    // Deselect any selected redaction when toggling modes
    if (!isActive) {
        selectedRedactionIndex = -1;
    }

    updateModalToolbar();
    renderRedactions();

    if (isActive) setupRedactionCanvas();
});

document.getElementById('btn-delete-redaction').addEventListener('click', (e) => {
    e.stopPropagation();
    if (selectedRedactionIndex !== -1) {
        redactions.splice(selectedRedactionIndex, 1);
        selectedRedactionIndex = -1;
        renderRedactions();
        updateModalToolbar();
    }
});

document.getElementById('btn-clear-redaction').addEventListener('click', (e) => {
    e.stopPropagation();
    redactions = [];
    selectedRedactionIndex = -1;
    renderRedactions();
    updateModalToolbar();
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

    // Scale back to original image coordinates for storage
    const img = document.getElementById('full-receipt-img');
    const scaleX = img.naturalWidth / canvas.width;
    const scaleY = img.naturalHeight / canvas.height;

    const w = (endX - startX) * scaleX;
    const h = (endY - startY) * scaleY;
    const x = startX * scaleX;
    const y = startY * scaleY;

    if (Math.abs(w) > 5 && Math.abs(h) > 5) {
        redactions.push({ x, y, w, h });
        renderRedactions();
        updateModalToolbar();
    }

    redrawRedactions();
});

document.getElementById('btn-retry-ai').addEventListener('click', (e) => {
    e.stopPropagation();
    closeModal(true); // Apply and retry in background
});

async function runBackgroundExtraction(card, originalFile, fileName) {
    card.classList.add('processing');
    try {
        const bounds = JSON.parse(card.dataset.bounds);
        const savedRedactions = JSON.parse(card.dataset.redactions);

        const processedBlob = await captureProcessedImageForCard(originalFile, bounds, savedRedactions);

        // Update the thumbnail
        const newUrl = URL.createObjectURL(processedBlob);
        card.querySelector('.receipt-preview').src = newUrl;

        await runAIExtraction(processedBlob, card, fileName);
        showToast('Background extraction completed!', 'success');
    } catch (err) {
        console.error('Background extraction failed:', err);
        showToast('Auto-retry failed: ' + err.message, 'error');
        card.classList.remove('processing');
    }
}

async function captureProcessedImageForCard(originalFile, bounds, savedRedactions) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(img.src);
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');

            const b = bounds || { top: 0, left: 0, bottom: img.height, right: img.width };
            const cropWidth = b.right - b.left;
            const cropHeight = b.bottom - b.top;

            canvas.width = cropWidth;
            canvas.height = cropHeight;

            // Draw original image part
            ctx.drawImage(img, b.left, b.top, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

            // Apply redactions
            if (savedRedactions && savedRedactions.length > 0) {
                ctx.fillStyle = 'black';
                savedRedactions.forEach(rect => {
                    const rx = rect.x - b.left;
                    const ry = rect.y - b.top;
                    ctx.fillRect(rx, ry, rect.w, rect.h);
                });
            }

            canvas.toBlob(blob => resolve(blob), 'image/jpeg', 0.9);
        };
        img.onerror = (err) => {
            URL.revokeObjectURL(img.src);
            reject(err);
        };
        img.src = URL.createObjectURL(originalFile);
    });
}

// Zoom gestures
const modalImg = document.getElementById('full-receipt-img');
modalImg?.addEventListener('click', (e) => {
    if (document.getElementById('full-view-modal').classList.contains('redact-mode')) return;
    e.stopPropagation(); // Don't close modal when clicking image
    const isZoomed = modalImg.classList.toggle('zoomed');
    setTimeout(() => {
        setupRedactionCanvas();
        // Trigger a re-layout of the cropping UI
        if (activeRedactionCard && activeRedactionCard.bounds) {
            setupCroppingUI(modalImg, activeRedactionCard.bounds);
        }
    }, 350);
});

modalImg?.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (modalImg.classList.contains('zoomed')) {
        modalImg.classList.remove('zoomed');
    }
});

document.querySelector('.close-modal')?.addEventListener('click', () => closeModal(false));

window.addEventListener('click', (event) => {
    const modal = document.getElementById('full-view-modal');
    if (event.target === modal) {
        closeModal(false);
    }
});

window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        closeModal(false);
    }
});

// --- Interactive Cropping Logic ---
function setupCroppingUI(img, bounds) {
    const cropBox = document.getElementById('crop-box');
    cropBox.style.display = 'block';

    if (!bounds) {
        bounds = { top: 0, left: 0, bottom: img.naturalHeight, right: img.naturalWidth };
        activeRedactionCard.bounds = bounds;
    }

    const updateUI = () => {
        const rect = img.getBoundingClientRect();
        const scaleX = rect.width / img.naturalWidth;
        const scaleY = rect.height / img.naturalHeight;

        cropBox.style.top = `${bounds.top * scaleY}px`;
        cropBox.style.left = `${bounds.left * scaleX}px`;
        cropBox.style.width = `${(bounds.right - bounds.left) * scaleX}px`;
        cropBox.style.height = `${(bounds.bottom - bounds.top) * scaleY}px`;
    };

    if (img.complete) updateUI();
    else img.onload = updateUI;
}

// Global Crop Listeners (Added once)
document.getElementById('crop-box').addEventListener('mousedown', (e) => {
    if (document.getElementById('full-view-modal').classList.contains('redact-mode')) return;
    e.stopPropagation();
    startBoxInteraction(e, 'crop');
});

window.addEventListener('mousemove', (e) => {
    if (!isBoxDragging) return;

    const img = document.getElementById('full-receipt-img');
    const rect = img.getBoundingClientRect();
    const scaleX = img.naturalWidth / rect.width;
    const scaleY = img.naturalHeight / rect.height;

    const dx = (e.clientX - dragStartX) * scaleX;
    const dy = (e.clientY - dragStartY) * scaleY;

    // Get the target box (either crop bounds or redaction rect)
    let b;
    if (interactionType === 'crop') {
        b = activeRedactionCard.bounds;
    } else {
        b = redactions[interactionIndex];
    }

    if (!activeHandle) { // Moving
        const w = initialBoxRect.right - initialBoxRect.left || initialBoxRect.w;
        const h = initialBoxRect.bottom - initialBoxRect.top || initialBoxRect.h;

        if (interactionType === 'crop') {
            b.left = Math.max(0, Math.min(img.naturalWidth - w, initialBoxRect.left + dx));
            b.top = Math.max(0, Math.min(img.naturalHeight - h, initialBoxRect.top + dy));
            b.right = b.left + w;
            b.bottom = b.top + h;
        } else {
            b.x = Math.max(0, Math.min(img.naturalWidth - w, initialBoxRect.x + dx));
            b.y = Math.max(0, Math.min(img.naturalHeight - h, initialBoxRect.y + dy));
        }
    } else { // Resizing
        if (interactionType === 'crop') {
            if (activeHandle.includes('n')) b.top = Math.max(0, Math.min(initialBoxRect.bottom - 50, initialBoxRect.top + dy));
            if (activeHandle.includes('s')) b.bottom = Math.min(img.naturalHeight, Math.max(initialBoxRect.top + 50, initialBoxRect.bottom + dy));
            if (activeHandle.includes('w')) b.left = Math.max(0, Math.min(initialBoxRect.right - 50, initialBoxRect.left + dx));
            if (activeHandle.includes('e')) b.right = Math.min(img.naturalWidth, Math.max(initialBoxRect.left + 50, initialBoxRect.right + dx));
        } else {
            if (activeHandle.includes('n')) {
                const newTop = Math.max(0, Math.min(initialBoxRect.y + initialBoxRect.h - 50, initialBoxRect.y + dy));
                b.h = initialBoxRect.h + (initialBoxRect.y - newTop);
                b.y = newTop;
            }
            if (activeHandle.includes('s')) {
                b.h = Math.max(50, Math.min(img.naturalHeight - initialBoxRect.y, initialBoxRect.h + dy));
            }
            if (activeHandle.includes('w')) {
                const newLeft = Math.max(0, Math.min(initialBoxRect.x + initialBoxRect.w - 50, initialBoxRect.x + dx));
                b.w = initialBoxRect.w + (initialBoxRect.x - newLeft);
                b.x = newLeft;
            }
            if (activeHandle.includes('e')) {
                b.w = Math.max(50, Math.min(img.naturalWidth - initialBoxRect.x, initialBoxRect.w + dx));
            }
        }
    }

    // Update UI
    if (interactionType === 'crop') {
        setupCroppingUI(img, b);
    } else {
        renderRedactions();
    }
});

window.addEventListener('mouseup', (e) => {
    if (!isBoxDragging) return;
    isBoxDragging = false;
    activeHandle = null;

    setupRedactionCanvas(); // Sync redaction canvas if needed
});

// Start the app
init();
