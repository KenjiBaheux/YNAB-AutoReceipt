import { DOM } from './dom.js';
import { pushToYNAB } from './ynab.js';
import { findClosestPayee } from './ynab.js';
import { renderChips, updateProgressCounter } from './ui.js';
import { markAsProcessed, getYNABPayees, getYNABPayeeCategories, isHeuristicFilenameEnabled, getHeuristicFilenamePattern, isHeuristicPayeeMatchingEnabled, isHeuristicTypicalCategoryEnabled } from './config.js';
import { setActiveRedactionCard, setupCroppingUI, renderRedactions, updateModalToolbar, setupRedactionCanvas, clearRedactionCanvas } from './modal.js';

let cardCounter = 0;

export function createReceiptCard(fileName, optimizedBlob, displayUrl, originalFile, autoBounds) {
    cardCounter++;
    const card = document.createElement('div');
    card.className = 'receipt-card queued';
    card.id = `receipt-${cardCounter}`;
    card.dataset.merchant = fileName; // Initial fallback
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

    // Modal logic
    card.querySelector('.receipt-preview-container').addEventListener('click', () => {
        const currentBounds = card.dataset.bounds ? JSON.parse(card.dataset.bounds) : null;
        const currentRedactions = card.dataset.redactions ? JSON.parse(card.dataset.redactions) : [];

        // Set state in modal.js
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

        const modal = DOM.modal;
        const modalImg = DOM.modalImg;

        // Reset previous state
        modalImg.onload = null;
        modalImg.src = '';

        modal.style.display = 'block';
        document.body.classList.add('modal-open');

        // Wait for load to ensure layout dimensions are correct for overlays
        modalImg.onload = () => {
            // Always show Retry button when modal is open
            DOM.btnRetryAI.style.display = 'block';

            // Setup Cropping Visualization
            setupCroppingUI(modalImg, currentBounds);

            // Setup Redactions
            renderRedactions(currentRedactions);
            updateModalToolbar();

            if (modal.classList.contains('redact-mode')) {
                setupRedactionCanvas();
            } else {
                clearRedactionCanvas();
            }
        };

        modalImg.src = card.dataset.originalUrl;
        modalImg.classList.remove('zoomed'); // Reset zoom on open
    });

    card.querySelector('.btn-push').addEventListener('click', () => pushToYNAB(card, fileName));
    card.querySelector('.btn-dismiss').addEventListener('click', () => {
        card.remove();
        markAsProcessed(fileName);
        updateProgressCounter();

        // Update files in queue count
        const currentCount = parseInt(DOM.processedCount.textContent) || 0;
        DOM.processedCount.textContent = Math.max(0, currentCount - 1);
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

export function updateReceiptCard(card, data) {
    card.classList.remove('processing');
    updateProgressCounter(); // Update the analysis progress counter

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

    const fileName = card.dataset.merchant || '';
    const fileInfo = isHeuristicFilenameEnabled() ? extractInfoFromFilename(fileName) : null;

    // Set primary values (most likely)
    card.querySelector('.merchant-input').value = merchants[0] || '';
    card.querySelector('.date-input').value = normalizeDate(dates[0]) || '';
    card.querySelector('.amount-input').value = amounts[0] || 0;
    card.querySelector('.category-input').value = categories[0] || '';
    card.querySelector('.btn-push').disabled = false;

    // Compute chips for merchants
    const merchantChips = merchants.map(m => ({ value: m, isHeuristic: false }));
    if (fileInfo && fileInfo.payee) {
        if (!merchants.includes(fileInfo.payee)) {
            merchantChips.push({ value: fileInfo.payee, isFilename: true });
        }
    }

    const cachedPayees = getYNABPayees();
    if (isHeuristicPayeeMatchingEnabled() && merchants[0] && cachedPayees && cachedPayees.payees) {
        const closest = findClosestPayee(merchants[0], cachedPayees.payees);
        if (closest && !merchants.includes(closest) && !(fileInfo && fileInfo.payee === closest)) {
            // Add as a heuristic chip
            merchantChips.push({ value: closest, isHeuristic: true });
        }
    }

    // Compute chips for categories
    const categoryChips = categories.map(c => ({ value: c, isHeuristic: false }));
    const cachedPayeeCats = getYNABPayeeCategories();
    const targetPayee = (merchantChips.find(m => m.isHeuristic) || merchantChips[0])?.value;

    if (isHeuristicTypicalCategoryEnabled() && targetPayee && cachedPayeeCats && cachedPayeeCats.map) {
        const typicalCategory = cachedPayeeCats.map[targetPayee];
        if (typicalCategory && !categories.includes(typicalCategory)) {
            categoryChips.push({ value: typicalCategory, isHeuristic: true });
        }
    }

    // Compute chips for dates
    const dateChips = dates.map(d => ({ value: d, isHeuristic: false }));
    if (fileInfo && fileInfo.date) {
        const normalizedFileDate = normalizeDate(fileInfo.date);
        const isDuplicateDate = dates.some(d => normalizeDate(d) === normalizedFileDate);
        if (!isDuplicateDate) {
            dateChips.push({ value: fileInfo.date, isFilename: true });
        }
    }

    // Compute chips for amounts
    const amountChips = amounts.map(a => ({ value: a, isHeuristic: false }));
    if (fileInfo && fileInfo.amount) {
        if (!amounts.some(a => String(a) === fileInfo.amount)) {
            amountChips.push({ value: fileInfo.amount, isFilename: true });
        }
    }

    // Render alternative chips
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

function normalizeDate(dateStr) {
    if (!dateStr) return '';

    // 1. Replace all separators (dots, slashes, kanji) and spaces with a single dash
    let clean = dateStr.replace(/[年月日\/\.\s]+/g, '-');
    // 2. Remove leading/trailing dashes
    clean = clean.replace(/^-+|-+$/g, '');

    const parts = clean.split('-').map(p => p.trim()).filter(p => p !== '');

    // We expect Year, Month, Day. 
    // Sometimes AI returns them in different orders, but YYYY is easy to spot.
    if (parts.length >= 3) {
        let y = '', m = '', d = '';

        // Find 4-digit year or assume first
        const yearIndex = parts.findIndex(p => p.length === 4);
        if (yearIndex !== -1) {
            y = parts[yearIndex];
            // Take the other two as month/day in order
            const others = parts.filter((_, i) => i !== yearIndex);
            m = others[0];
            d = others[1];
        } else {
            [y, m, d] = parts;
            // Basic transformation for 2-digit years
            if (y.length === 2) y = '20' + y;
        }

        // Padding
        m = m.padStart(2, '0');
        d = d.padStart(2, '0');

        const iso = `${y}-${m}-${d}`;
        // Validate it's a real date
        if (!isNaN(Date.parse(iso))) {
            return iso;
        }
    }
    return ''; // Return empty if invalid to avoid browser warnings
}

function extractInfoFromFilename(fileName) {
    if (!fileName) return null;
    const name = fileName.replace(/\.[^/.]+$/, ""); // remove extension
    
    const pattern = getHeuristicFilenamePattern();
    let dateMatch;
    try {
        dateMatch = name.match(new RegExp(pattern));
    } catch (err) {
        console.error('Invalid filename heuristic regex pattern:', err);
        return null;
    }
    
    if (!dateMatch) return null;

    const dateStr = dateMatch[1].replace(/_/g, '-'); // YYYY-MM-DD
    let rest = dateMatch[2] || '';

    const amountMatch = rest.match(/_+([0-9()][0-9(),_]*|[^_]+)$/);
    let payee = rest;
    let amountStr = null;

    if (amountMatch) {
        amountStr = amountMatch[1];
        payee = rest.substring(0, rest.length - amountMatch[0].length);
    }

    payee = payee.replace(/^_+|_+$/g, ''); // trim underscores
    if (amountStr) {
        // remove formatting like commas, underscores, parentheses
        amountStr = amountStr.replace(/[_,()]/g, '');
    }

    return {
        date: dateStr,
        payee: payee,
        amount: amountStr
    };
}
