import { DOM } from './dom.js';
import { pushToYNAB, findClosestPayee } from './ynab.js';
import { renderChips, updateProgressCounter } from './ui.js';
import { markAsProcessed, getYNABPayees, getYNABPayeeCategories, isHeuristicFilenameEnabled, getHeuristicFilenamePattern, isHeuristicPayeeMatchingEnabled, isHeuristicTypicalCategoryEnabled } from './config.js';
import { setActiveRedactionCard, setupCroppingUI, renderRedactions, updateModalToolbar, setupRedactionCanvas, clearRedactionCanvas } from './modal.js';

let cardCounter = 0;

// --- Card Generation ---

export function createReceiptCard(fileName, optimizedBlob, displayUrl, originalFile, autoBounds) {
    cardCounter++;
    const card = document.createElement('div');
    card.className = 'receipt-card queued';
    card.id = `receipt-${cardCounter}`;
    card.dataset.merchant = fileName;
    card.dataset.bounds = JSON.stringify(autoBounds);
    card.dataset.redactions = JSON.stringify([]);

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
                <input type="text" class="edit-input merchant-input" placeholder="Merchant name..." list="ynab-merchant-list">
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
                <label>Category</label>
                <input type="text" class="edit-input category-input" placeholder="Category..." list="ynab-category-list">
                <div class="suggestion-chips categories-chips"></div>
            </div>
        </div>
        <div class="card-actions">
            <button class="btn btn-small btn-push" disabled>Push to YNAB</button>
            <button class="btn btn-small btn-dismiss">Dismiss</button>
        </div>
    `;

    // Preview / Modal click handler
    card.querySelector('.receipt-preview-container').addEventListener('click', () => {
        const currentBounds = card.dataset.bounds ? JSON.parse(card.dataset.bounds) : null;
        const currentRedactions = card.dataset.redactions ? JSON.parse(card.dataset.redactions) : [];

        setActiveRedactionCard({
            card,
            fileName,
            file: originalFile,
            optimizedBlob,
            bounds: currentBounds ? { ...currentBounds } : null,
            redactions: [...currentRedactions],
            initialBounds: currentBounds ? { ...currentBounds } : null,
            initialRedactions: [...currentRedactions]
        });

        DOM.modalImg.onload = null;
        DOM.modalImg.src = '';
        DOM.modal.style.display = 'block';
        document.body.classList.add('modal-open');

        DOM.modalImg.onload = () => {
            DOM.btnRetryAI.style.display = 'block';
            setupCroppingUI(DOM.modalImg, currentBounds);
            renderRedactions(currentRedactions);
            updateModalToolbar();

            if (DOM.modal.classList.contains('redact-mode')) {
                setupRedactionCanvas();
            } else {
                clearRedactionCanvas();
            }
        };

        DOM.modalImg.src = card.dataset.originalUrl;
        DOM.modalImg.classList.remove('zoomed');
    });

    card.querySelector('.btn-push').addEventListener('click', () => pushToYNAB(card, fileName));
    card.querySelector('.btn-dismiss').addEventListener('click', () => {
        card.remove();
        markAsProcessed(fileName);
        updateProgressCounter();
        DOM.processedCount.textContent = Math.max(0, (parseInt(DOM.processedCount.textContent) || 0) - 1);
    });

    const merchantInput = card.querySelector('.merchant-input');
    const dateInput = card.querySelector('.date-input');
    const amountInput = card.querySelector('.amount-input');
    const pushBtn = card.querySelector('.btn-push');

    const updatePushEnabled = () => {
        if (card.classList.contains('processing')) {
            pushBtn.disabled = true;
            return;
        }
        const hasMerchant = merchantInput.value.trim() !== '';
        const hasDate = dateInput.value.trim() !== '';
        const hasAmount = amountInput.value.trim() !== '' && parseInt(amountInput.value) > 0;
        pushBtn.disabled = !(hasMerchant && hasDate && hasAmount);
    };

    [merchantInput, dateInput, amountInput].forEach(inp => {
        inp.addEventListener('input', updatePushEnabled);
        inp.addEventListener('change', updatePushEnabled);
    });

    return card;
}

// --- Card Updates & Candidates Chip Construction ---

function buildChips(mainCandidates, filenameVal, heuristicVal) {
    const chips = mainCandidates.map(val => ({ value: val, isHeuristic: false }));
    if (filenameVal && !mainCandidates.includes(filenameVal)) {
        chips.push({ value: filenameVal, isFilename: true });
    }
    if (heuristicVal && !mainCandidates.includes(heuristicVal) && filenameVal !== heuristicVal) {
        chips.push({ value: heuristicVal, isHeuristic: true });
    }
    return chips;
}

export function updateReceiptCard(card, data) {
    card.classList.remove('processing');
    updateProgressCounter();

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

    const fileName = card.dataset.merchant || '';
    const fileInfo = isHeuristicFilenameEnabled() ? extractInfoFromFilename(fileName) : null;

    // Apply primary values
    card.querySelector('.merchant-input').value = merchants[0] || '';
    card.querySelector('.date-input').value = normalizeDate(dates[0]) || '';
    card.querySelector('.amount-input').value = amounts[0] || 0;
    card.querySelector('.category-input').value = categories[0] || '';
    card.querySelector('.btn-push').disabled = false;

    // Merchants
    let closestPayee = null;
    const cachedPayees = getYNABPayees();
    if (isHeuristicPayeeMatchingEnabled() && merchants[0] && cachedPayees?.payees) {
        closestPayee = findClosestPayee(merchants[0], cachedPayees.payees);
    }
    const merchantChips = buildChips(merchants, fileInfo?.payee, closestPayee);

    // Categories
    let typicalCategory = null;
    const cachedPayeeCats = getYNABPayeeCategories();
    const targetPayee = merchantChips.find(m => m.isHeuristic || m.value)?.value;
    if (isHeuristicTypicalCategoryEnabled() && targetPayee && cachedPayeeCats?.map) {
        typicalCategory = cachedPayeeCats.map[targetPayee];
    }
    const categoryChips = buildChips(categories, null, typicalCategory);

    // Dates & Amounts (Normalized)
    const normalizedDates = dates.map(normalizeDate).filter(Boolean);
    const normalizedFileDate = fileInfo ? normalizeDate(fileInfo.date) : '';
    const dateChips = buildChips(normalizedDates, normalizedFileDate, null);

    const stringAmounts = amounts.map(String);
    const amountChips = buildChips(stringAmounts, fileInfo?.amount ? String(fileInfo.amount) : null, null);

    // Render chips
    renderChips(card.querySelector('.merchants-chips'), merchantChips, val => {
        card.querySelector('.merchant-input').value = val;
    });
    renderChips(card.querySelector('.dates-chips'), dateChips, val => {
        card.querySelector('.date-input').value = normalizeDate(val);
    });
    renderChips(card.querySelector('.amounts-chips'), amountChips, val => {
        card.querySelector('.amount-input').value = val;
    });
    renderChips(card.querySelector('.categories-chips'), categoryChips, val => {
        card.querySelector('.category-input').value = val;
    });
}

// --- Filename & Date Utilities ---

function normalizeDate(dateStr) {
    if (!dateStr) return '';

    let clean = dateStr.replace(/[年月日\/\.\s]+/g, '-').replace(/^-+|-+$/g, '');
    const parts = clean.split('-').map(p => p.trim()).filter(Boolean);

    if (parts.length >= 3) {
        let y = '', m = '', d = '';
        const yearIndex = parts.findIndex(p => p.length === 4);
        if (yearIndex !== -1) {
            y = parts[yearIndex];
            const others = parts.filter((_, i) => i !== yearIndex);
            m = others[0];
            d = others[1];
        } else {
            [y, m, d] = parts;
            if (y.length === 2) y = '20' + y;
        }

        m = m.padStart(2, '0');
        d = d.padStart(2, '0');
        const iso = `${y}-${m}-${d}`;
        if (!isNaN(Date.parse(iso))) {
            return iso;
        }
    }
    return '';
}

export function extractInfoFromFilename(fileName) {
    if (!fileName) return null;
    const name = fileName.replace(/\.[^/.]+$/, "");
    const pattern = getHeuristicFilenamePattern();

    let dateMatch;
    try {
        dateMatch = name.match(new RegExp(pattern));
    } catch (err) {
        console.error('Invalid filename heuristic regex pattern:', err);
        return null;
    }

    if (!dateMatch) return null;

    const dateStr = dateMatch[1].replace(/_/g, '-');
    const rest = dateMatch[2] || '';

    const amountMatch = rest.match(/_+([0-9()][0-9(),_]*|[^_]+)$/);
    let payee = rest;
    let amountStr = null;

    if (amountMatch) {
        amountStr = amountMatch[1];
        payee = rest.substring(0, rest.length - amountMatch[0].length);
    }

    payee = payee.replace(/^_+|_+$/g, '');
    if (amountStr) {
        amountStr = amountStr.replace(/[_,()]/g, '');
    }

    return {
        date: dateStr,
        payee: payee,
        amount: amountStr
    };
}
