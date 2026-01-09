export const CONFIG = {
    processedFilesKey: 'ynab_receipt_porter_processed',
    ynabKeyPath: 'ynab_api_key',
    ynabBudgetIdPath: 'ynab_budget_id',
    ynabAccountIdPath: 'ynab_account_id'
};

// State
let processedFiles = new Set(JSON.parse(localStorage.getItem(CONFIG.processedFilesKey) || '[]'));
let ynabCategories = [];

// Getters and Setters
export function getProcessedFiles() {
    return processedFiles;
}

export function isProcessed(fileName) {
    return processedFiles.has(fileName);
}

export function markAsProcessed(fileName) {
    processedFiles.add(fileName);
    localStorage.setItem(CONFIG.processedFilesKey, JSON.stringify([...processedFiles]));
}

export function getYNABCategories() {
    return ynabCategories;
}

export function setYNABCategories(categories) {
    ynabCategories = categories;
}
