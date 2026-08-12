export const CONFIG = {
    processedFilesKey: 'ynab_receipt_porter_processed',
    ynabCategoriesKey: 'ynab_receipt_porter_categories',
    ynabPayeesKey: 'ynab_receipt_porter_payees',
    ynabPayeeCategoriesKey: 'ynab_receipt_porter_payee_cats',
    ynabKeyPath: 'ynab_api_pat',
    ynabBudgetIdPath: 'ynab_budget_id',
    ynabAccountIdPath: 'ynab_account_id',
    heuristicFilenameEnabledKey: 'ynab_receipt_porter_heuristic_filename_enabled',
    heuristicFilenamePatternKey: 'ynab_receipt_porter_heuristic_filename_pattern',
    heuristicPayeeMatchingEnabledKey: 'ynab_receipt_porter_heuristic_payee_matching_enabled',
    heuristicTypicalCategoryEnabledKey: 'ynab_receipt_porter_heuristic_typical_category_enabled'
};

// State
let processedFiles = new Set(JSON.parse(localStorage.getItem(CONFIG.processedFilesKey) || '[]'));
let ynabCategories = JSON.parse(localStorage.getItem(CONFIG.ynabCategoriesKey) || 'null');
let ynabPayees = JSON.parse(localStorage.getItem(CONFIG.ynabPayeesKey) || 'null');
let ynabPayeeCategories = JSON.parse(localStorage.getItem(CONFIG.ynabPayeeCategoriesKey) || 'null');

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

export function getYNABPayees() {
    return ynabPayees;
}

export function setYNABPayees(payees) {
    ynabPayees = payees;
    localStorage.setItem(CONFIG.ynabPayeesKey, JSON.stringify(payees));
}

export function getYNABPayeeCategories() {
    return ynabPayeeCategories;
}

export function setYNABPayeeCategories(map) {
    ynabPayeeCategories = map;
    localStorage.setItem(CONFIG.ynabPayeeCategoriesKey, JSON.stringify(map));
}

// Heuristics Settings Getters and Setters
export function isHeuristicFilenameEnabled() {
    const val = localStorage.getItem(CONFIG.heuristicFilenameEnabledKey);
    return val === null ? true : val === 'true';
}

export function setHeuristicFilenameEnabled(enabled) {
    localStorage.setItem(CONFIG.heuristicFilenameEnabledKey, String(enabled));
}

export function getHeuristicFilenamePattern() {
    return localStorage.getItem(CONFIG.heuristicFilenamePatternKey) || '^(\\d{4}_\\d{2}_\\d{2})_+(.*)$';
}

export function setHeuristicFilenamePattern(pattern) {
    localStorage.setItem(CONFIG.heuristicFilenamePatternKey, pattern);
}

export function isHeuristicPayeeMatchingEnabled() {
    const val = localStorage.getItem(CONFIG.heuristicPayeeMatchingEnabledKey);
    return val === null ? true : val === 'true';
}

export function setHeuristicPayeeMatchingEnabled(enabled) {
    localStorage.setItem(CONFIG.heuristicPayeeMatchingEnabledKey, String(enabled));
}

export function isHeuristicTypicalCategoryEnabled() {
    const val = localStorage.getItem(CONFIG.heuristicTypicalCategoryEnabledKey);
    return val === null ? true : val === 'true';
}

export function setHeuristicTypicalCategoryEnabled(enabled) {
    localStorage.setItem(CONFIG.heuristicTypicalCategoryEnabledKey, String(enabled));
}
