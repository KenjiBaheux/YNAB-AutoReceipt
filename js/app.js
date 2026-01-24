import { DOM } from './dom.js';
import { CONFIG, getProcessedFiles, markAsProcessed } from './config.js';
import { fetchYNABBudgets, fetchYNABAccounts, fetchYNABCategories, pushAllToYNAB } from './ynab.js';
import { checkAIAvailability, resetAISession } from './ai.js';
import { optimizeImageForAI, createVerticalChunks } from './image.js';
import { createReceiptCard } from './card.js';
import { runAIExtraction } from './ai.js';
import { updateProgressCounter, showToast } from './ui.js';
import { setupCroppingUI, renderRedactions, updateModalToolbar, setupRedactionCanvas, clearRedactionCanvas, getActiveRedactionCard, deleteSelectedRedaction, clearAllRedactions } from './modal.js';

let directoryHandle = null;

// --- Initialization ---
async function init() {
    // Load saved settings
    DOM.apiPAT.value = localStorage.getItem(CONFIG.ynabKeyPath) || '';
    // Budget and Account IDs will be selected in the fetch cascading logic

    // Save settings on change
    DOM.apiPAT.addEventListener('change', async (e) => {
        localStorage.setItem(CONFIG.ynabKeyPath, e.target.value);
        if (e.target.value) {
            await fetchYNABBudgets();
        }
    });

    DOM.budgetId.addEventListener('change', async (e) => {
        const id = e.target.value;
        localStorage.setItem(CONFIG.ynabBudgetIdPath, id);
        if (id) {
            await fetchYNABAccounts(id);
            await fetchYNABCategories(true); // Force refresh for new budget
            resetAISession();
        }
    });

    DOM.accountId.addEventListener('change', (e) => {
        localStorage.setItem(CONFIG.ynabAccountIdPath, e.target.value);
    });

    await checkAIAvailability();

    // Initial load cascade
    if (DOM.apiPAT.value) {
        const budgets = await fetchYNABBudgets();
        const savedBudgetId = localStorage.getItem(CONFIG.ynabBudgetIdPath);
        if (savedBudgetId && budgets.some(b => b.id === savedBudgetId)) {
            await fetchYNABAccounts(savedBudgetId);
            await fetchYNABCategories();
        }
    }

    DOM.btnSync.addEventListener('click', handleFolderSync);
    DOM.btnPushAll.addEventListener('click', pushAllToYNAB);

    const btnRefresh = document.getElementById('btn-refresh-categories');
    if (btnRefresh) {
        btnRefresh.addEventListener('click', async () => {
            if (DOM.apiPAT.value && DOM.budgetId.value) {
                await fetchYNABCategories(true);
                resetAISession();
            } else {
                showToast('Configure API settings first', 'info');
            }
        });
    }

    setupModalListeners();
}

function setupModalListeners() {
    // Close modal
    DOM.btnDismissModal.addEventListener('click', () => {
        document.getElementById('full-view-modal').style.display = 'none';
        document.body.classList.remove('modal-open');
    });

    // Close on outside click
    window.addEventListener('click', (e) => {
        const modal = document.getElementById('full-view-modal');
        if (e.target === modal) {
            modal.style.display = 'none';
            document.body.classList.remove('modal-open');
        }
    });

    // Mode switching
    DOM.btnModeCrop.addEventListener('click', () => {
        const modal = document.getElementById('full-view-modal');
        modal.classList.remove('redact-mode');
        updateModalToolbar();
        clearRedactionCanvas();
    });

    DOM.btnModeRedact.addEventListener('click', () => {
        const modal = document.getElementById('full-view-modal');
        modal.classList.add('redact-mode');
        updateModalToolbar();
        setupRedactionCanvas();
    });

    // Redaction Actions
    document.getElementById('btn-delete-redaction').addEventListener('click', deleteSelectedRedaction);
    document.getElementById('btn-clear-redaction').addEventListener('click', clearAllRedactions);

    DOM.btnRetryAI.addEventListener('click', handleRetryAI);
}

async function handleRetryAI() {
    const activeData = getActiveRedactionCard();
    if (!activeData || !activeData.card) return;

    const { card, file: originalFile, fileName, initialBounds } = activeData;

    // UI Feedback
    const btn = DOM.btnRetryAI;
    const indicator = document.getElementById('retrying-indicator');
    btn.style.display = 'none';
    indicator.style.display = 'flex';

    try {
        // 1. Get current crop/redaction data
        // For crop, we need to query the DOM or state. Modal.js state is best.
        // We'll read the latest from the card dataset where modal saves it live, or modal state directly.
        // Let's assume modal.js updates card.dataset.bounds/redactions live as per my previous edit.

        const bounds = card.dataset.bounds ? JSON.parse(card.dataset.bounds) : null;
        const redactions = card.dataset.redactions ? JSON.parse(card.dataset.redactions) : [];

        // 2. Process Image (Crop + Redact)
        const { blob: processedBlob, chunks } = await applyAdjustments(originalFile, bounds, redactions);
        const processedUrl = URL.createObjectURL(processedBlob);

        // 3. Update Card UI
        card.querySelector('.receipt-preview').src = processedUrl;
        card.dataset.displayUrl = processedUrl; // Store for valid re-opens
        // Update originalUrl to point to this new version? 
        // User probably expects "Retry" to mean "Use this new version as source of truth".
        // But we might want to keep *original* original for further edits. 
        // For now, we update the preview and send this blob to AI.

        // 4. Reset AI State on Card
        const inputs = card.querySelectorAll('input');
        inputs.forEach(input => input.classList.add('scanning'));

        // 5. Close modal IMMEDIATELY so user can continue working
        document.getElementById('full-view-modal').style.display = 'none';
        document.body.classList.remove('modal-open');
        showToast('Retrying analysis in background...', 'info');

        // 6. Re-run Extraction (Async)
        runAIExtraction(chunks, card, fileName).catch(err => {
            console.error('Background retry failed:', err);
            showToast('Background analysis failed', 'error');
        });

    } catch (err) {
        console.error('Retry failed:', err);
        showToast('Failed to process image adjustments', 'error');
    } finally {
        btn.style.display = 'block';
        indicator.style.display = 'none';
    }
}

async function applyAdjustments(file, bounds, redactions) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = async () => {
            const canvas = document.createElement('canvas');

            // 1. Determine Crop
            // If bounds exist, size canvas to bounds. Else size to full img.
            // Bounds are in natural coordinates.
            let sx = 0, sy = 0, sw = img.width, sh = img.height;
            if (bounds) {
                sx = bounds.left;
                sy = bounds.top;
                sw = bounds.right - bounds.left;
                sh = bounds.bottom - bounds.top;
            }

            canvas.width = sw;
            canvas.height = sh;
            const ctx = canvas.getContext('2d');

            // Draw Cropped region
            ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

            // 2. Apply Redactions
            // Redactions are relative to the *original* image (0,0 of full img).
            // We need to shift them by -sx, -sy to map to cropped canvas.
            ctx.fillStyle = '#000';
            redactions.forEach(r => {
                const rx = r.x - sx;
                const ry = r.y - sy;
                // Only draw if inside crop
                ctx.fillRect(rx, ry, r.w, r.h);
            });

            const ratio = sh / sw;
            const chunks = [];
            const displayBlob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.95));

            if (ratio > 1.8) {
                const chunkBlobs = await createVerticalChunks(canvas, ratio);
                chunks.push(...chunkBlobs);
            } else {
                chunks.push(displayBlob);
            }

            resolve({ blob: displayBlob, chunks });
        };
        img.src = URL.createObjectURL(file);
    });
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

    const processedFiles = getProcessedFiles();
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
    let optimizedBlob, optimizedUrl, autoBounds, chunks;
    try {
        const optimized = await optimizeImageForAI(file);
        optimizedBlob = optimized.blob;
        optimizedUrl = optimized.url;
        autoBounds = optimized.bounds;
        chunks = optimized.chunks;
    } catch (err) {
        console.warn('Image optimization failed, using original:', err);
        optimizedBlob = file;
        optimizedUrl = URL.createObjectURL(file);
        autoBounds = null; // Signal full image
        chunks = [file];
    }

    // Create UI Card
    const card = createReceiptCard(fileName, optimizedBlob, optimizedUrl, file, autoBounds);
    if (DOM.receiptList.querySelector('.empty-state')) {
        DOM.receiptList.innerHTML = '';
    }
    DOM.receiptList.appendChild(card);

    await runAIExtraction(chunks || optimizedBlob, card, fileName);
}

// Start the app
init();
