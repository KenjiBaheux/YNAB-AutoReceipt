export const DOM = {
    // YNAB Main View Elements
    apiPAT: document.getElementById('ynab-api-pat'),
    budgetId: document.getElementById('ynab-budget-id'),
    accountId: document.getElementById('ynab-account-id'),
    btnSync: document.getElementById('btn-sync-folder'),
    btnPushAll: document.getElementById('btn-push-all'),
    btnClearQueue: document.getElementById('btn-clear-queue'),
    progressCounter: document.getElementById('progress-counter'),
    aiStatus: document.getElementById('ai-status'),
    receiptList: document.getElementById('receipt-list'),
    initialState: document.getElementById('initial-state'),
    processedCount: document.getElementById('processed-count'),
    toastContainer: document.getElementById('toast-container'),

    // First-run Setup Wizard Elements
    setupWizard: document.getElementById('setup-wizard'),
    setupPat: document.getElementById('setup-ynab-pat'),
    setupBudget: document.getElementById('setup-ynab-budget'),
    setupAccount: document.getElementById('setup-ynab-account'),
    btnSetupNext1: document.getElementById('btn-wizard-next-1'),
    btnSetupBack2: document.getElementById('btn-wizard-back-2'),
    btnSetupNext2: document.getElementById('btn-wizard-next-2'),
    btnSetupBack3: document.getElementById('btn-wizard-back-3'),
    btnSetupFinish: document.getElementById('btn-wizard-finish'),

    // Settings Modal Elements
    btnOpenSettings: document.getElementById('btn-open-settings'),
    settingsModal: document.getElementById('settings-modal'),
    btnCloseSettings: document.getElementById('btn-close-settings'),
    settingsAccountId: document.getElementById('settings-ynab-account-id'),
    btnResetSetup: document.getElementById('btn-reset-setup'),

    // AI Advanced Settings
    aiSystemPrompt: document.getElementById('ai-system-prompt'),
    aiSamplingMode: document.getElementById('ai-sampling-mode'),
    aiSamplingModeGroup: document.getElementById('ai-sampling-mode-group'),
    aiLegacyParamsGroup: document.getElementById('ai-legacy-params-group'),
    aiTemperature: document.getElementById('ai-temperature'),
    valTemperature: document.getElementById('val-temperature'),
    aiTopK: document.getElementById('ai-topk'),
    aiConcurrency: document.getElementById('ai-concurrency'),
    aiUserPrompt: document.getElementById('ai-user-prompt'),
    aiResponseSchema: document.getElementById('ai-response-schema'),
    btnResetAISettings: document.getElementById('btn-reset-ai-settings'),
    settingsSaveIndicator: document.getElementById('settings-save-indicator'),

    // Heuristics & Custom Rules Settings
    heuristicFilenameEnabled: document.getElementById('heuristic-filename-enabled'),
    heuristicFilenamePattern: document.getElementById('heuristic-filename-pattern'),
    heuristicFilenameDetails: document.getElementById('heuristic-filename-details'),
    heuristicPayeeMatchingEnabled: document.getElementById('heuristic-payee-matching-enabled'),
    heuristicTypicalCategoryEnabled: document.getElementById('heuristic-typical-category-enabled'),
    regexTestInput: document.getElementById('regex-test-input'),
    regexResultDate: document.getElementById('regex-result-date'),
    regexResultPayee: document.getElementById('regex-result-payee'),
    regexResultAmount: document.getElementById('regex-result-amount'),

    // Image Zoom, Crop & Redact Modal
    modal: document.getElementById('full-view-modal'),
    modalImg: document.getElementById('full-receipt-img'),
    btnDismissModal: document.getElementById('btn-dismiss-modal'),
    btnRetryAI: document.getElementById('btn-retry-ai'),
    btnModeCrop: document.getElementById('btn-mode-crop'),
    btnModeRedact: document.getElementById('btn-mode-redact'),
    btnDeleteRedaction: document.getElementById('btn-delete-redaction'),
    btnClearRedaction: document.getElementById('btn-clear-redaction'),
    redactionsContainer: document.getElementById('redactions-container')
};
