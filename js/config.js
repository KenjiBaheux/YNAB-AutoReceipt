export const CONFIG = {
    processedFilesKey: 'ynab_receipt_porter_processed',
    ynabCategoriesKey: 'ynab_receipt_porter_categories',
    ynabKeyPath: 'ynab_api_pat',
    ynabBudgetIdPath: 'ynab_budget_id',
    ynabAccountIdPath: 'ynab_account_id'
};

// State
let processedFiles = new Set(JSON.parse(localStorage.getItem(CONFIG.processedFilesKey) || '[]'));
let ynabCategories = JSON.parse(localStorage.getItem(CONFIG.ynabCategoriesKey) || 'null');

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
    localStorage.setItem(CONFIG.ynabCategoriesKey, JSON.stringify(categories));
}
