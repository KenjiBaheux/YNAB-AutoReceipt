import { DOM } from './dom.js';
import { CONFIG, getProcessedFiles, isHeuristicFilenameEnabled, setHeuristicFilenameEnabled, getHeuristicFilenamePattern, setHeuristicFilenamePattern, isHeuristicPayeeMatchingEnabled, setHeuristicPayeeMatchingEnabled, isHeuristicTypicalCategoryEnabled, setHeuristicTypicalCategoryEnabled } from './config.js';
import { fetchYNABBudgets, fetchYNABAccounts, fetchYNABCategories, fetchYNABPayees, fetchYNABTransactionsAndBuildMap, pushAllToYNAB } from './ynab.js';
import { checkAIAvailability, resetAISession, AI_CONFIG_KEYS, DEFAULT_SYSTEM_PROMPT, DEFAULT_USER_PROMPT, supportsSamplingMode, DEFAULT_SCHEMA } from './ai.js';
import { optimizeImageForAI, createVerticalChunks } from './image.js';
import { createReceiptCard, extractInfoFromFilename } from './card.js';
import { runAIExtraction } from './ai.js';
import { updateProgressCounter, showToast } from './ui.js';
import { setupCroppingUI, renderRedactions, updateModalToolbar, setupRedactionCanvas, clearRedactionCanvas, getActiveRedactionCard, deleteSelectedRedaction, clearAllRedactions } from './modal.js';

let directoryHandle = null;

// --- Save & Sync Helpers ---

function showSaveIndicator() {
    DOM.settingsSaveIndicator.style.opacity = '1';
    setTimeout(() => {
        DOM.settingsSaveIndicator.style.opacity = '0';
    }, 2000);
}

function syncInputs(el1, el2, storageKey) {
    const handler = (e) => {
        const val = e.target.value;
        localStorage.setItem(storageKey, val);
        el1.value = val;
        el2.value = val;
    };
    el1.addEventListener('change', handler);
    el2.addEventListener('change', handler);
}

// --- UI Initialization Sections ---

function initAISettingsUI() {
    DOM.aiSystemPrompt.value = localStorage.getItem(AI_CONFIG_KEYS.systemPrompt) || DEFAULT_SYSTEM_PROMPT;
    DOM.aiConcurrency.value = localStorage.getItem(AI_CONFIG_KEYS.concurrency) || '1';
    DOM.aiUserPrompt.value = localStorage.getItem(AI_CONFIG_KEYS.userPrompt) || DEFAULT_USER_PROMPT;
    DOM.aiResponseSchema.value = localStorage.getItem(AI_CONFIG_KEYS.schema) || DEFAULT_SCHEMA;

    const bindAISetting = (el, key, isInputEvent = false) => {
        el.addEventListener(isInputEvent ? 'input' : 'change', (e) => {
            const val = e.target.value.trim();
            if (key === AI_CONFIG_KEYS.schema) {
                try {
                    JSON.parse(val);
                } catch {
                    showToast('Invalid JSON schema! Please correct it.', 'error');
                    return;
                }
            }
            if (isInputEvent && el === DOM.aiTemperature) {
                DOM.valTemperature.textContent = val;
            }
            localStorage.setItem(key, val);
            resetAISession();
            showSaveIndicator();
        });
    };

    bindAISetting(DOM.aiSystemPrompt, AI_CONFIG_KEYS.systemPrompt);
    bindAISetting(DOM.aiConcurrency, AI_CONFIG_KEYS.concurrency);
    bindAISetting(DOM.aiUserPrompt, AI_CONFIG_KEYS.userPrompt);
    bindAISetting(DOM.aiResponseSchema, AI_CONFIG_KEYS.schema);

    if (supportsSamplingMode()) {
        DOM.aiSamplingModeGroup.style.display = 'flex';
        if (DOM.aiLegacyParamsGroup) DOM.aiLegacyParamsGroup.style.display = 'none';

        DOM.aiSamplingMode.value = localStorage.getItem(AI_CONFIG_KEYS.samplingMode) || 'most-predictable';
        bindAISetting(DOM.aiSamplingMode, AI_CONFIG_KEYS.samplingMode);
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
        bindAISetting(DOM.aiTemperature, AI_CONFIG_KEYS.temperature);
        bindAISetting(DOM.aiTopK, AI_CONFIG_KEYS.topK);
    }

    DOM.btnResetAISettings.addEventListener('click', () => {
        Object.values(AI_CONFIG_KEYS).forEach(k => localStorage.removeItem(k));

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
    DOM.heuristicFilenameEnabled.checked = isHeuristicFilenameEnabled();
    DOM.heuristicFilenamePattern.value = getHeuristicFilenamePattern();
    DOM.heuristicPayeeMatchingEnabled.checked = isHeuristicPayeeMatchingEnabled();
    DOM.heuristicTypicalCategoryEnabled.checked = isHeuristicTypicalCategoryEnabled();

    DOM.heuristicFilenameDetails.style.display = DOM.heuristicFilenameEnabled.checked ? 'block' : 'none';

    const bindCheckbox = (el, setter, toastMsg) => {
        el.addEventListener('change', (e) => {
            setter(e.target.checked);
            showToast(`${toastMsg} ${e.target.checked ? 'enabled' : 'disabled'}`, 'success');
        });
    };

    DOM.heuristicFilenameEnabled.addEventListener('change', (e) => {
        const checked = e.target.checked;
        setHeuristicFilenameEnabled(checked);
        DOM.heuristicFilenameDetails.style.display = checked ? 'block' : 'none';
        showToast(`Filename parsing ${checked ? 'enabled' : 'disabled'}`, 'success');
    });

    bindCheckbox(DOM.heuristicPayeeMatchingEnabled, setHeuristicPayeeMatchingEnabled, 'Nearest payee matching');
    bindCheckbox(DOM.heuristicTypicalCategoryEnabled, setHeuristicTypicalCategoryEnabled, 'Typical category mapping');

    DOM.heuristicFilenamePattern.addEventListener('change', (e) => {
        setHeuristicFilenamePattern(e.target.value.trim());
        updateRegexPreview();
        showToast('Regex pattern saved', 'success');
    });

    DOM.regexTestInput.addEventListener('input', updateRegexPreview);
    DOM.heuristicFilenamePattern.addEventListener('input', updateRegexPreview);
}

function updateRegexPreview() {
    const filename = DOM.regexTestInput.value.trim();
    if (!filename) {
        DOM.regexResultDate.textContent = '-';
        DOM.regexResultPayee.textContent = '-';
        DOM.regexResultAmount.textContent = '-';
        return;
    }
    try {
        new RegExp(DOM.heuristicFilenamePattern.value.trim());
    } catch {
        DOM.regexResultDate.textContent = 'Invalid Regex';
        DOM.regexResultPayee.textContent = 'Invalid Regex';
        DOM.regexResultAmount.textContent = 'Invalid Regex';
        return;
    }

    const res = extractInfoFromFilename(filename);
    if (res) {
        DOM.regexResultDate.textContent = res.date || '-';
        DOM.regexResultPayee.textContent = res.payee || '-';
        DOM.regexResultAmount.textContent = res.amount || '-';
    } else {
        DOM.regexResultDate.textContent = 'No regex match';
        DOM.regexResultPayee.textContent = 'No regex match';
        DOM.regexResultAmount.textContent = 'No regex match';
    }
}

function initSettingsModalUI() {
    DOM.btnOpenSettings.addEventListener('click', () => {
        DOM.settingsModal.style.display = 'block';
        document.body.classList.add('modal-open');
        DOM.apiPAT.value = localStorage.getItem(CONFIG.ynabKeyPath) || '';
        DOM.settingsAccountId.value = DOM.accountId.value;
    });

    const closeModal = () => {
        DOM.settingsModal.style.display = 'none';
        document.body.classList.remove('modal-open');
    };

    DOM.btnCloseSettings.addEventListener('click', closeModal);
    window.addEventListener('click', (e) => {
        if (e.target === DOM.settingsModal) closeModal();
    });

    const tabButtons = DOM.settingsModal.querySelectorAll('.tab-btn');
    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            tabButtons.forEach(b => b.classList.remove('active'));
            DOM.settingsModal.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            
            btn.classList.add('active');
            document.getElementById(btn.dataset.tab).classList.add('active');
        });
    });

    DOM.btnResetSetup.addEventListener('click', () => {
        localStorage.removeItem(CONFIG.ynabKeyPath);
        localStorage.removeItem(CONFIG.ynabBudgetIdPath);
        localStorage.removeItem(CONFIG.ynabAccountIdPath);
        
        DOM.apiPAT.value = '';
        DOM.budgetId.value = '';
        DOM.accountId.value = '';
        DOM.settingsAccountId.value = '';

        closeModal();
        showSetupWizard();
    });
}

// --- Setup Wizard Flow ---

function showSetupWizard() {
    DOM.setupWizard.style.display = 'flex';
    document.body.classList.add('setup-mode');

    document.getElementById('wizard-step-1').style.display = 'block';
    document.getElementById('wizard-step-2').style.display = 'none';
    document.getElementById('wizard-step-3').style.display = 'none';

    DOM.setupPat.value = '';
    DOM.setupBudget.value = '';
    DOM.setupAccount.value = '';
}

function initSetupWizardUI() {
    DOM.btnSetupNext1.addEventListener('click', async () => {
        const pat = DOM.setupPat.value.trim();
        if (!pat) {
            showToast('Please enter your Personal Access Token', 'error');
            return;
        }

        DOM.btnSetupNext1.disabled = true;
        DOM.btnSetupNext1.textContent = 'Connecting...';
        DOM.apiPAT.value = pat;

        const budgets = await fetchYNABBudgets();
        DOM.btnSetupNext1.disabled = false;
        DOM.btnSetupNext1.textContent = 'Connect YNAB ➡️';

        if (budgets?.length > 0) {
            document.getElementById('wizard-step-1').style.display = 'none';
            document.getElementById('wizard-step-2').style.display = 'block';
            showToast('Successfully connected to YNAB!', 'success');
        } else {
            showToast('Connection failed. Please check your token.', 'error');
        }
    });

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

    const bindStepNav = (btn, stepToHide, stepToShow) => {
        btn.addEventListener('click', () => {
            document.getElementById(stepToHide).style.display = 'none';
            document.getElementById(stepToShow).style.display = 'block';
        });
    };

    bindStepNav(DOM.btnSetupBack2, 'wizard-step-2', 'wizard-step-1');
    bindStepNav(DOM.btnSetupBack3, 'wizard-step-3', 'wizard-step-2');

    DOM.btnSetupFinish.addEventListener('click', async () => {
        const accountId = DOM.setupAccount.value;
        if (!accountId) {
            showToast('Please select a default account', 'error');
            return;
        }

        DOM.btnSetupFinish.disabled = true;
        DOM.btnSetupFinish.textContent = 'Completing setup...';

        localStorage.setItem(CONFIG.ynabKeyPath, DOM.apiPAT.value);
        localStorage.setItem(CONFIG.ynabBudgetIdPath, DOM.budgetId.value);
        localStorage.setItem(CONFIG.ynabAccountIdPath, accountId);
        
        DOM.accountId.value = accountId;
        DOM.settingsAccountId.value = accountId;

        showToast('Fetching YNAB details...', 'info');
        await fetchYNABCategories(true);
        await fetchYNABPayees(true);
        await fetchYNABTransactionsAndBuildMap(true);
        resetAISession();

        await checkAIAvailability();

        DOM.btnSetupFinish.disabled = false;
        DOM.btnSetupFinish.textContent = 'Finish Setup ✨';

        DOM.setupWizard.style.display = 'none';
        document.body.classList.remove('setup-mode');
        showToast('Setup complete!', 'success');
    });
}

// --- App Entry & Main Initialization ---

async function init() {
    initAISettingsUI();
    initHeuristicsUI();
    initSettingsModalUI();
    initSetupWizardUI();

    syncInputs(DOM.accountId, DOM.settingsAccountId, CONFIG.ynabAccountIdPath);

    DOM.apiPAT.addEventListener('change', async (e) => {
        localStorage.setItem(CONFIG.ynabKeyPath, e.target.value);
        if (e.target.value) await fetchYNABBudgets();
    });

    DOM.budgetId.addEventListener('change', async (e) => {
        const id = e.target.value;
        localStorage.setItem(CONFIG.ynabBudgetIdPath, id);
        if (id) {
            await fetchYNABAccounts(id);
            await fetchYNABCategories(true);
            await fetchYNABPayees(true);
            await fetchYNABTransactionsAndBuildMap(true);
            resetAISession();
        }
    });

    // Startup configuration loading
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

    // Initial Drag and Drop states
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
                        return;
                    } else if (handle.kind === 'file' && isImage(handle.name) && !processedFiles.has(handle.name)) {
                        totalPending++;
                        processReceipt(handle);
                    }
                } catch (err) {
                    console.error("FileSystemHandle error:", err);
                }
            } else {
                const file = item.getAsFile();
                if (file && isImage(file.name) && !processedFiles.has(file.name)) {
                    totalPending++;
                    processReceipt({ name: file.name, getFile: async () => file });
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
    const closeModal = () => {
        document.getElementById('full-view-modal').style.display = 'none';
        document.body.classList.remove('modal-open');
    };

    DOM.btnDismissModal.addEventListener('click', closeModal);
    window.addEventListener('click', (e) => {
        if (e.target === document.getElementById('full-view-modal')) closeModal();
    });

    DOM.btnModeCrop.addEventListener('click', () => {
        document.getElementById('full-view-modal').classList.remove('redact-mode');
        updateModalToolbar();
        clearRedactionCanvas();
    });

    DOM.btnModeRedact.addEventListener('click', () => {
        document.getElementById('full-view-modal').classList.add('redact-mode');
        updateModalToolbar();
        setupRedactionCanvas();
    });

    document.getElementById('btn-delete-redaction').addEventListener('click', deleteSelectedRedaction);
    document.getElementById('btn-clear-redaction').addEventListener('click', clearAllRedactions);
    DOM.btnRetryAI.addEventListener('click', handleRetryAI);
}

// --- AI Retry & Image Preprocessing adjustments ---

async function handleRetryAI() {
    const activeData = getActiveRedactionCard();
    if (!activeData?.card) return;

    const { card, file: originalFile, fileName } = activeData;
    const btn = DOM.btnRetryAI;
    const indicator = document.getElementById('retrying-indicator');
    
    btn.style.display = 'none';
    indicator.style.display = 'flex';

    try {
        const bounds = card.dataset.bounds ? JSON.parse(card.dataset.bounds) : null;
        const redactions = card.dataset.redactions ? JSON.parse(card.dataset.redactions) : [];

        const { blob: processedBlob, chunks } = await applyAdjustments(originalFile, bounds, redactions);
        const processedUrl = URL.createObjectURL(processedBlob);

        card.querySelector('.receipt-preview').src = processedUrl;
        card.dataset.displayUrl = processedUrl;

        card.classList.remove('processing');
        card.classList.add('queued');
        updateProgressCounter();

        document.getElementById('full-view-modal').style.display = 'none';
        document.body.classList.remove('modal-open');
        showToast('Retrying analysis in background...', 'info');

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
            ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

            ctx.fillStyle = '#000';
            redactions.forEach(r => {
                ctx.fillRect(r.x - sx, r.y - sy, r.w, r.h);
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

// --- Folder Pickers & File Scans ---

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
        autoBounds = null;
        chunks = [file];
    }

    const card = createReceiptCard(fileName, optimizedBlob, optimizedUrl, file, autoBounds);
    DOM.receiptList.appendChild(card);

    await runAIExtraction(chunks || optimizedBlob, card, fileName);
}

init();
