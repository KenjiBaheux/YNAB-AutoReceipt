import { DOM } from './dom.js';
import { CONFIG, getProcessedFiles, markAsProcessed, isHeuristicFilenameEnabled, setHeuristicFilenameEnabled, getHeuristicFilenamePattern, setHeuristicFilenamePattern, isHeuristicPayeeMatchingEnabled, setHeuristicPayeeMatchingEnabled, isHeuristicTypicalCategoryEnabled, setHeuristicTypicalCategoryEnabled } from './config.js';
import { fetchYNABBudgets, fetchYNABAccounts, fetchYNABCategories, fetchYNABPayees, fetchYNABTransactionsAndBuildMap, pushAllToYNAB } from './ynab.js';
import { checkAIAvailability, resetAISession, destroyAISession, AI_CONFIG_KEYS, DEFAULT_SYSTEM_PROMPT, DEFAULT_USER_PROMPT, supportsSamplingMode, DEFAULT_SCHEMA, warmUpAI } from './ai.js';
import { optimizeImageForAI, createVerticalChunks } from './image.js';
import { createReceiptCard } from './card.js';
import { runAIExtraction } from './ai.js';
import { updateProgressCounter, showToast } from './ui.js';
import { setupCroppingUI, renderRedactions, updateModalToolbar, setupRedactionCanvas, clearRedactionCanvas, getActiveRedactionCard, deleteSelectedRedaction, clearAllRedactions } from './modal.js';

let directoryHandle = null;

function showSaveIndicator() {
    DOM.settingsSaveIndicator.style.opacity = '1';
    setTimeout(() => {
        DOM.settingsSaveIndicator.style.opacity = '0';
    }, 2000);
}

function initAISettingsUI() {
    DOM.aiSystemPrompt.value = localStorage.getItem(AI_CONFIG_KEYS.systemPrompt) || DEFAULT_SYSTEM_PROMPT;
    DOM.aiConcurrency.value = localStorage.getItem(AI_CONFIG_KEYS.concurrency) || '1';
    DOM.aiUserPrompt.value = localStorage.getItem(AI_CONFIG_KEYS.userPrompt) || DEFAULT_USER_PROMPT;

    // Load custom schema
    DOM.aiResponseSchema.value = localStorage.getItem(AI_CONFIG_KEYS.schema) || DEFAULT_SCHEMA;

    // Listeners to save values and reset AI session
    const saveSetting = (key, value) => {
        localStorage.setItem(key, value);
        resetAISession();
        showSaveIndicator();
    };

    DOM.aiSystemPrompt.addEventListener('change', (e) => saveSetting(AI_CONFIG_KEYS.systemPrompt, e.target.value));
    DOM.aiConcurrency.addEventListener('change', (e) => saveSetting(AI_CONFIG_KEYS.concurrency, e.target.value));
    DOM.aiUserPrompt.addEventListener('change', (e) => saveSetting(AI_CONFIG_KEYS.userPrompt, e.target.value));

    DOM.aiResponseSchema.addEventListener('change', (e) => {
        const val = e.target.value.trim();
        try {
            JSON.parse(val); // Verify it's valid JSON
            saveSetting(AI_CONFIG_KEYS.schema, val);
        } catch (err) {
            showToast('Invalid JSON schema! Please correct it.', 'error');
            console.error(err);
        }
    });

    if (supportsSamplingMode()) {
        DOM.aiSamplingModeGroup.style.display = 'flex';
        if (DOM.aiLegacyParamsGroup) DOM.aiLegacyParamsGroup.style.display = 'none';

        const savedMode = localStorage.getItem(AI_CONFIG_KEYS.samplingMode) || 'most-predictable';
        DOM.aiSamplingMode.value = savedMode;
        DOM.aiSamplingMode.addEventListener('change', (e) => saveSetting(AI_CONFIG_KEYS.samplingMode, e.target.value));
    } else {
        if (DOM.aiLegacyParamsGroup) DOM.aiLegacyParamsGroup.style.display = 'flex';
        if (DOM.aiSamplingModeGroup) DOM.aiSamplingModeGroup.style.display = 'none';

        const temp = localStorage.getItem(AI_CONFIG_KEYS.temperature) || '0.0';
        DOM.aiTemperature.value = temp;
        DOM.valTemperature.textContent = temp;
        DOM.aiTopK.value = localStorage.getItem(AI_CONFIG_KEYS.topK) || '';

        DOM.aiTemperature.addEventListener('input', (e) => {
            DOM.valTemperature.textContent = e.target.value;
        });
        DOM.aiTemperature.addEventListener('change', (e) => saveSetting(AI_CONFIG_KEYS.temperature, e.target.value));
        DOM.aiTopK.addEventListener('change', (e) => saveSetting(AI_CONFIG_KEYS.topK, e.target.value));
    }

    DOM.btnResetAISettings.addEventListener('click', () => {
        localStorage.removeItem(AI_CONFIG_KEYS.systemPrompt);
        localStorage.removeItem(AI_CONFIG_KEYS.samplingMode);
        localStorage.removeItem(AI_CONFIG_KEYS.temperature);
        localStorage.removeItem(AI_CONFIG_KEYS.topK);
        localStorage.removeItem(AI_CONFIG_KEYS.concurrency);
        localStorage.removeItem(AI_CONFIG_KEYS.userPrompt);
        localStorage.removeItem(AI_CONFIG_KEYS.schema);

        DOM.aiSystemPrompt.value = DEFAULT_SYSTEM_PROMPT;
        DOM.aiConcurrency.value = '1';
        DOM.aiUserPrompt.value = DEFAULT_USER_PROMPT;
        DOM.aiResponseSchema.value = DEFAULT_SCHEMA;

        if (supportsSamplingMode()) {
            DOM.aiSamplingMode.value = 'most-predictable';
        } else {
            DOM.aiTemperature.value = '0.0';
            DOM.valTemperature.textContent = '0.0';
            DOM.aiTopK.value = '';
        }

        resetAISession();
        showSaveIndicator();
        showToast('Settings reset to defaults', 'success');
    });
}

function initHeuristicsUI() {
    // Checkbox states
    DOM.heuristicFilenameEnabled.checked = isHeuristicFilenameEnabled();
    DOM.heuristicFilenamePattern.value = getHeuristicFilenamePattern();
    DOM.heuristicPayeeMatchingEnabled.checked = isHeuristicPayeeMatchingEnabled();
    DOM.heuristicTypicalCategoryEnabled.checked = isHeuristicTypicalCategoryEnabled();

    // Toggle details panel visibility
    DOM.heuristicFilenameDetails.style.display = DOM.heuristicFilenameEnabled.checked ? 'block' : 'none';

    // Event listeners
    DOM.heuristicFilenameEnabled.addEventListener('change', (e) => {
        const checked = e.target.checked;
        setHeuristicFilenameEnabled(checked);
        DOM.heuristicFilenameDetails.style.display = checked ? 'block' : 'none';
        showToast('Filename parsing ' + (checked ? 'enabled' : 'disabled'), 'success');
    });

    DOM.heuristicFilenamePattern.addEventListener('change', (e) => {
        const pattern = e.target.value.trim();
        setHeuristicFilenamePattern(pattern);
        updateRegexPreview();
        showToast('Regex pattern saved', 'success');
    });

    DOM.heuristicPayeeMatchingEnabled.addEventListener('change', (e) => {
        setHeuristicPayeeMatchingEnabled(e.target.checked);
        showToast('Nearest payee matching ' + (e.target.checked ? 'enabled' : 'disabled'), 'success');
    });

    DOM.heuristicTypicalCategoryEnabled.addEventListener('change', (e) => {
        setHeuristicTypicalCategoryEnabled(e.target.checked);
        showToast('Typical category mapping ' + (e.target.checked ? 'enabled' : 'disabled'), 'success');
    });

    // Regex Live Test Input
    DOM.regexTestInput.addEventListener('input', updateRegexPreview);
    DOM.heuristicFilenamePattern.addEventListener('input', updateRegexPreview);
}

function updateRegexPreview() {
    const filename = DOM.regexTestInput.value.trim();
    const pattern = DOM.heuristicFilenamePattern.value.trim();
    if (!filename) {
        DOM.regexResultDate.textContent = '-';
        DOM.regexResultPayee.textContent = '-';
        DOM.regexResultAmount.textContent = '-';
        return;
    }
    try {
        const name = filename.replace(/\.[^/.]+$/, ""); // remove extension
        const rx = new RegExp(pattern);
        const dateMatch = name.match(rx);
        if (dateMatch) {
            const dateStr = dateMatch[1].replace(/_/g, '-');
            let rest = dateMatch[2] || '';
            
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

            DOM.regexResultDate.textContent = dateStr || '-';
            DOM.regexResultPayee.textContent = payee || '-';
            DOM.regexResultAmount.textContent = amountStr || '-';
        } else {
            DOM.regexResultDate.textContent = 'No regex match';
            DOM.regexResultPayee.textContent = 'No regex match';
            DOM.regexResultAmount.textContent = 'No regex match';
        }
    } catch (err) {
        DOM.regexResultDate.textContent = 'Invalid Regex';
        DOM.regexResultPayee.textContent = 'Invalid Regex';
        DOM.regexResultAmount.textContent = 'Invalid Regex';
    }
}

function initSettingsModalUI() {
    // Open Settings Modal
    DOM.btnOpenSettings.addEventListener('click', () => {
        DOM.settingsModal.style.display = 'block';
        document.body.classList.add('modal-open');
        
        // Sync values with localStorage
        DOM.apiPAT.value = localStorage.getItem(CONFIG.ynabKeyPath) || '';
        DOM.settingsAccountId.value = DOM.accountId.value;
    });

    // Close Settings Modal
    DOM.btnCloseSettings.addEventListener('click', () => {
        DOM.settingsModal.style.display = 'none';
        document.body.classList.remove('modal-open');
    });

    // Click outside settings modal content to close
    window.addEventListener('click', (e) => {
        if (e.target === DOM.settingsModal) {
            DOM.settingsModal.style.display = 'none';
            document.body.classList.remove('modal-open');
        }
    });

    // Tab Switching inside Settings
    const tabButtons = DOM.settingsModal.querySelectorAll('.tab-btn');
    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            tabButtons.forEach(b => b.classList.remove('active'));
            DOM.settingsModal.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            
            btn.classList.add('active');
            const tabId = btn.dataset.tab;
            document.getElementById(tabId).classList.add('active');
        });
    });

    // Rerun Wizard
    DOM.btnResetSetup.addEventListener('click', () => {
        localStorage.removeItem(CONFIG.ynabKeyPath);
        localStorage.removeItem(CONFIG.ynabBudgetIdPath);
        localStorage.removeItem(CONFIG.ynabAccountIdPath);
        
        DOM.apiPAT.value = '';
        DOM.budgetId.value = '';
        DOM.accountId.value = '';
        DOM.settingsAccountId.value = '';

        DOM.settingsModal.style.display = 'none';
        document.body.classList.remove('modal-open');
        showSetupWizard();
    });
}

function showSetupWizard() {
    DOM.setupWizard.style.display = 'flex';
    document.body.classList.add('setup-mode');

    // Show Step 1, Hide others
    document.getElementById('wizard-step-1').style.display = 'block';
    document.getElementById('wizard-step-2').style.display = 'none';
    document.getElementById('wizard-step-3').style.display = 'none';

    // Clear setup fields
    DOM.setupPat.value = '';
    DOM.setupBudget.value = '';
    DOM.setupAccount.value = '';
}

function initSetupWizardUI() {
    // Wizard Step 1 -> Step 2
    DOM.btnSetupNext1.addEventListener('click', async () => {
        const pat = DOM.setupPat.value.trim();
        if (!pat) {
            showToast('Please enter your Personal Access Token', 'error');
            return;
        }

        DOM.btnSetupNext1.disabled = true;
        DOM.btnSetupNext1.textContent = 'Connecting...';

        // Set value temporarily to let fetchYNABBudgets read it
        DOM.apiPAT.value = pat;

        const budgets = await fetchYNABBudgets();
        DOM.btnSetupNext1.disabled = false;
        DOM.btnSetupNext1.textContent = 'Connect YNAB ➡️';

        if (budgets && budgets.length > 0) {
            document.getElementById('wizard-step-1').style.display = 'none';
            document.getElementById('wizard-step-2').style.display = 'block';
            showToast('Successfully connected to YNAB!', 'success');
        } else {
            showToast('Connection failed. Please check your token.', 'error');
        }
    });

    // Wizard Step 2 -> Step 3
    DOM.btnSetupNext2.addEventListener('click', async () => {
        const budgetId = DOM.setupBudget.value;
        if (!budgetId) {
            showToast('Please select a budget', 'error');
            return;
        }

        DOM.btnSetupNext2.disabled = true;
        DOM.btnSetupNext2.textContent = 'Loading accounts...';

        localStorage.setItem(CONFIG.ynabBudgetIdPath, budgetId);
        DOM.budgetId.value = budgetId;

        const accounts = await fetchYNABAccounts(budgetId);
        DOM.btnSetupNext2.disabled = false;
        DOM.btnSetupNext2.textContent = 'Next ➡️';

        if (accounts) {
            document.getElementById('wizard-step-2').style.display = 'none';
            document.getElementById('wizard-step-3').style.display = 'block';
        } else {
            showToast('Failed to load accounts for this budget.', 'error');
        }
    });

    // Wizard Step 2 Back
    DOM.btnSetupBack2.addEventListener('click', () => {
        document.getElementById('wizard-step-2').style.display = 'none';
        document.getElementById('wizard-step-1').style.display = 'block';
    });

    // Wizard Step 3 Back
    DOM.btnSetupBack3.addEventListener('click', () => {
        document.getElementById('wizard-step-3').style.display = 'none';
        document.getElementById('wizard-step-2').style.display = 'block';
    });

    // Wizard Finish Setup
    DOM.btnSetupFinish.addEventListener('click', async () => {
        const accountId = DOM.setupAccount.value;
        if (!accountId) {
            showToast('Please select a default account', 'error');
            return;
        }

        DOM.btnSetupFinish.disabled = true;
        DOM.btnSetupFinish.textContent = 'Completing setup...';

        // Persist everything
        localStorage.setItem(CONFIG.ynabKeyPath, DOM.apiPAT.value);
        localStorage.setItem(CONFIG.ynabBudgetIdPath, DOM.budgetId.value);
        localStorage.setItem(CONFIG.ynabAccountIdPath, accountId);
        
        DOM.accountId.value = accountId;
        DOM.settingsAccountId.value = accountId;

        // Fetch remaining YNAB details in background
        showToast('Fetching YNAB categories and payees...', 'info');
        await fetchYNABCategories(true);
        await fetchYNABPayees(true);
        await fetchYNABTransactionsAndBuildMap(true);
        resetAISession();

        // Warm up AI model
        await checkAIAvailability();

        DOM.btnSetupFinish.disabled = false;
        DOM.btnSetupFinish.textContent = 'Finish Setup ✨';

        // Hide Wizard, Reveal Application
        DOM.setupWizard.style.display = 'none';
        document.body.classList.remove('setup-mode');
        showToast('Setup complete! You can now import receipts.', 'success');
    });
}

// --- Initialization ---
async function init() {
    initAISettingsUI();
    initHeuristicsUI();
    initSettingsModalUI();
    initSetupWizardUI();

    // Cascading sync between Account Select on Main View and Settings
    DOM.accountId.addEventListener('change', (e) => {
        const val = e.target.value;
        localStorage.setItem(CONFIG.ynabAccountIdPath, val);
        DOM.settingsAccountId.value = val;
    });

    DOM.settingsAccountId.addEventListener('change', (e) => {
        const val = e.target.value;
        localStorage.setItem(CONFIG.ynabAccountIdPath, val);
        DOM.accountId.value = val;
    });

    // PAT changes inside Settings tab
    DOM.apiPAT.addEventListener('change', async (e) => {
        localStorage.setItem(CONFIG.ynabKeyPath, e.target.value);
        if (e.target.value) {
            await fetchYNABBudgets();
        }
    });

    // Budget changes inside Settings tab
    DOM.budgetId.addEventListener('change', async (e) => {
        const id = e.target.value;
        localStorage.setItem(CONFIG.ynabBudgetIdPath, id);
        if (id) {
            await fetchYNABAccounts(id);
            await fetchYNABCategories(true); // Force refresh for new budget
            await fetchYNABPayees(true);
            await fetchYNABTransactionsAndBuildMap(true);
            resetAISession();
        }
    });

    // Load YNAB Connection Details on Startup
    const pat = localStorage.getItem(CONFIG.ynabKeyPath);
    if (!pat) {
        showSetupWizard();
    } else {
        DOM.apiPAT.value = pat;
        
        const budgets = await fetchYNABBudgets();
        const savedBudgetId = localStorage.getItem(CONFIG.ynabBudgetIdPath);
        if (savedBudgetId && budgets.some(b => b.id === savedBudgetId)) {
            DOM.budgetId.value = savedBudgetId;
            await fetchYNABAccounts(savedBudgetId);
            await fetchYNABCategories();
            await fetchYNABPayees();
            await fetchYNABTransactionsAndBuildMap();
        }
        
        await checkAIAvailability();
    }

    DOM.btnSync.addEventListener('click', handleFolderSync);
    DOM.btnPushAll.addEventListener('click', pushAllToYNAB);
    DOM.btnClearQueue.addEventListener('click', handleClearQueue);

    // Drag and Drop for initial state
    DOM.initialState.addEventListener('dragover', (e) => {
        e.preventDefault();
        DOM.initialState.classList.add('drag-active');
    });

    DOM.initialState.addEventListener('dragleave', (e) => {
        e.preventDefault();
        DOM.initialState.classList.remove('drag-active');
    });

    DOM.initialState.addEventListener('drop', async (e) => {
        e.preventDefault();
        DOM.initialState.classList.remove('drag-active');
        
        const items = e.dataTransfer.items;
        if (!items || items.length === 0) return;

        let totalPending = 0;
        const processedFiles = getProcessedFiles();

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.kind !== 'file') continue;

            if (item.getAsFileSystemHandle) {
                try {
                    const handle = await item.getAsFileSystemHandle();
                    if (handle.kind === 'directory') {
                        directoryHandle = handle;
                        await scanFolder();
                        return; // scanFolder handles the UI update
                    } else if (handle.kind === 'file') {
                        if (isImage(handle.name) && !processedFiles.has(handle.name)) {
                            totalPending++;
                            processReceipt(handle);
                        }
                    }
                } catch (err) {
                    console.error("Error getting file system handle:", err);
                }
            } else {
                // Fallback for older browsers (files only)
                const file = item.getAsFile();
                if (file && isImage(file.name) && !processedFiles.has(file.name)) {
                    // Create a pseudo-handle for processReceipt
                    const mockHandle = {
                        name: file.name,
                        getFile: async () => file
                    };
                    totalPending++;
                    processReceipt(mockHandle);
                }
            }
        }

        if (totalPending > 0) {
            DOM.processedCount.textContent = (parseInt(DOM.processedCount.textContent) || 0) + totalPending;
            DOM.initialState.style.display = 'none';
            DOM.receiptList.style.display = 'grid';
            DOM.btnClearQueue.style.display = 'inline-flex';
        } else if (items.length > 0) {
            showToast('No new receipt images found in dropped items.', 'info');
        }
    });

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

    const { card, file: originalFile, fileName } = activeData;

    // UI Feedback
    const btn = DOM.btnRetryAI;
    const indicator = document.getElementById('retrying-indicator');
    btn.style.display = 'none';
    indicator.style.display = 'flex';

    try {
        const bounds = card.dataset.bounds ? JSON.parse(card.dataset.bounds) : null;
        const redactions = card.dataset.redactions ? JSON.parse(card.dataset.redactions) : [];

        // 2. Process Image (Crop + Redact)
        const { blob: processedBlob, chunks } = await applyAdjustments(originalFile, bounds, redactions);
        const processedUrl = URL.createObjectURL(processedBlob);

        // 3. Update Card UI
        card.querySelector('.receipt-preview').src = processedUrl;
        card.dataset.displayUrl = processedUrl;

        // 4. Reset AI State on Card
        card.classList.remove('processing');
        card.classList.add('queued');
        updateProgressCounter();

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
            ctx.fillStyle = '#000';
            redactions.forEach(r => {
                const rx = r.x - sx;
                const ry = r.y - sy;
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

    if (totalPending > 0) {
        DOM.initialState.style.display = 'none';
        DOM.receiptList.style.display = 'grid';
        DOM.btnClearQueue.style.display = 'inline-flex';
    } else {
        showToast('No new receipts found.', 'info');
    }
}

function handleClearQueue() {
    DOM.receiptList.innerHTML = '';
    DOM.receiptList.style.display = 'none';
    DOM.initialState.style.display = 'flex';
    DOM.btnClearQueue.style.display = 'none';
    DOM.btnPushAll.style.display = 'none';
    DOM.processedCount.textContent = '0';
    directoryHandle = null;
    updateProgressCounter();
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
    DOM.receiptList.appendChild(card);

    await runAIExtraction(chunks || optimizedBlob, card, fileName);
}

// Start the app
init();
