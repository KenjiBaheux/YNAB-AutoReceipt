import { DOM } from './dom.js';
import { showToast, updateProgressCounter } from './ui.js';
import { setYNABCategories, getYNABCategories, markAsProcessed, CONFIG } from './config.js';

export async function fetchYNABBudgets() {
    const apiPAT = DOM.apiPAT.value;
    if (!apiPAT) return [];

    try {
        const response = await fetch('https://api.ynab.com/v1/budgets', {
            headers: { 'Authorization': `Bearer ${apiPAT}` }
        });

        if (!response.ok) throw new Error('Failed to fetch budgets');

        const data = await response.json();
        const budgets = data.data.budgets.map(b => ({
            id: b.id,
            name: b.name
        }));

        updateBudgetDropdown(budgets);
        return budgets;
    } catch (err) {
        console.error('Error loading YNAB budgets:', err);
        showToast('Failed to load budgets', 'error');
        return [];
    }
}

export async function fetchYNABAccounts(budgetId) {
    const apiPAT = DOM.apiPAT.value;
    if (!apiPAT || !budgetId) return [];

    try {
        const response = await fetch(`https://api.ynab.com/v1/budgets/${budgetId}/accounts`, {
            headers: { 'Authorization': `Bearer ${apiPAT}` }
        });

        if (!response.ok) throw new Error('Failed to fetch accounts');

        const data = await response.json();
        // Filter for on_budget accounts
        const accounts = data.data.accounts
            .filter(a => a.on_budget && !a.closed)
            .map(a => ({
                id: a.id,
                name: a.name,
                type: a.type
            }));

        updateAccountDropdown(accounts);
        return accounts;
    } catch (err) {
        console.error('Error loading YNAB accounts:', err);
        showToast('Failed to load accounts', 'error');
        return [];
    }
}

function updateBudgetDropdown(budgets) {
    const select = DOM.budgetId;
    const currentBudgetId = localStorage.getItem(CONFIG.ynabBudgetIdPath);

    select.innerHTML = '<option value="">Select a budget...</option>' +
        budgets.map(b => `<option value="${b.id}" ${b.id === currentBudgetId ? 'selected' : ''}>${b.name}</option>`).join('');
}

function updateAccountDropdown(accounts) {
    const select = DOM.accountId;
    const currentAccountId = localStorage.getItem(CONFIG.ynabAccountIdPath);

    select.innerHTML = '<option value="">Select an account...</option>' +
        accounts.map(a => `<option value="${a.id}" ${a.id === currentAccountId ? 'selected' : ''}>${a.name} (${a.type})</option>`).join('');
}

export async function fetchYNABCategories(forceRefresh = false) {
    const apiPAT = DOM.apiPAT.value;
    const budgetId = DOM.budgetId.value;

    if (!apiPAT || !budgetId) {
        updateCategoryUI([]); // Clear UI if no budget
        return [];
    }

    const cached = getYNABCategories();
    // cached now expected to be { budgetId, categories } or []

    // Use cached if available, not forced, and matches current budget
    if (!forceRefresh && cached && cached.budgetId === budgetId && cached.categories.length > 0) {
        console.log(`Using ${cached.categories.length} cached YNAB categories for budget ${budgetId}`);
        updateCategoryUI(cached.categories);
        return cached.categories;
    }

    // UI Feedback for refresh
    const refreshBtn = document.getElementById('btn-refresh-categories');
    if (refreshBtn) refreshBtn.classList.add('rotating');

    try {
        const response = await fetch(`https://api.ynab.com/v1/budgets/${budgetId}/categories`, {
            headers: { 'Authorization': `Bearer ${apiPAT}` }
        });

        if (!response.ok) throw new Error('Failed to fetch categories');

        const data = await response.json();
        const groups = data.data.category_groups;

        const categoriesList = [];
        groups.forEach(group => {
            if (group.hidden || group.deleted) return;
            group.categories.forEach(cat => {
                if (!cat.hidden && !cat.deleted) {
                    categoriesList.push({
                        id: cat.id,
                        name: cat.name,
                        group: group.name
                    });
                }
            });
        });

        setYNABCategories({ budgetId, categories: categoriesList });
        updateCategoryUI(categoriesList);
        showToast(`Loaded ${categoriesList.length} YNAB categories`, 'success');
        console.log(`Loaded ${categoriesList.length} YNAB categories`);
        return categoriesList;
    } catch (err) {
        console.error('Error loading YNAB categories:', err);
        showToast('Failed to load categories', 'error');
        return [];
    } finally {
        if (refreshBtn) refreshBtn.classList.remove('rotating');
    }
}

function updateCategoryUI(categories) {
    const list = document.getElementById('ynab-category-list');
    const countLabel = document.getElementById('category-count');

    if (list) {
        list.innerHTML = categories.map(c => `<option value="${c.name}">${c.group}: ${c.name}</option>`).join('');
    }
    if (countLabel) {
        countLabel.textContent = `${categories.length} cats`;
    }
}

export function prepareTransactionData(card, ynabCategories, accountId) {
    const merchant = card.querySelector('.merchant-input').value;
    const date = card.querySelector('.date-input').value;
    const amountVal = card.querySelector('.amount-input').value;
    const categoryName = card.querySelector('.category-input').value.trim();

    if (!merchant || !date || !amountVal) {
        return { error: 'Missing required fields (Merchant, Date, or Amount)' };
    }

    // Resolve Category ID
    let categoryId = null;
    if (categoryName) {
        // Case-insensitive match, ignore whitespace
        const normalizedInput = categoryName.toLowerCase();
        const match = ynabCategories.find(c => c.name.toLowerCase() === normalizedInput);

        if (match) {
            categoryId = match.id;
        } else if (ynabCategories.length > 0) {
            // Only error if we actually have categories loaded
            return { error: `Category "${categoryName}" not found.` };
        } else {
            return { error: `Categories not loaded. Please refresh.` };
        }
    }

    const amount = parseInt(amountVal) * 1000; // JPY Amount * 1000 for YNAB milliunits

    return {
        data: {
            account_id: accountId,
            date: date,
            amount: -Math.abs(amount), // Outflow
            payee_name: merchant,
            category_id: categoryId,
            cleared: 'cleared',
            approved: true,
            flag_color: 'yellow'
        },
        meta: {
            merchant,
            fileName: card.querySelector('.merchant-input').placeholder || 'receipt'
        }
    };
}

export async function pushToYNAB(card, fileName) {
    const apiPAT = DOM.apiPAT.value;
    const budgetId = DOM.budgetId.value;
    const accountId = DOM.accountId.value;
    if (!apiPAT || !budgetId || !accountId) {
        showToast('Please fill in all YNAB settings.', 'error');
        return false;
    }

    let categoryData = getYNABCategories();
    let ynabCategories = Array.isArray(categoryData) ? categoryData : (categoryData.categories || []);

    // Ensure categories are for the current budget
    if (ynabCategories.length === 0 || (!Array.isArray(categoryData) && categoryData.budgetId !== budgetId)) {
        ynabCategories = await fetchYNABCategories();
        if (ynabCategories.length === 0) {
            showToast('Could not load YNAB categories. Please check API key.', 'error');
            return false;
        }
    }

    const result = prepareTransactionData(card, ynabCategories, accountId);
    if (result.error) {
        showToast(result.error, 'error');
        return false;
    }

    const transaction = {
        transaction: result.data
    };

    const pushBtn = card.querySelector('.btn-push');
    pushBtn.disabled = true;
    pushBtn.textContent = '⏳';

    try {
        const response = await fetch(`https://api.ynab.com/v1/budgets/${budgetId}/transactions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiPAT}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(transaction)
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error.detail || 'YNAB API error');
        }

        showToast(`Synced ${result.meta.merchant} to YNAB!`, 'success');
        card.classList.add('synced');
        setTimeout(() => {
            card.remove();
            markAsProcessed(fileName);
            updateProgressCounter(); // Update progress when a card is removed
        }, 500);
    } catch (err) {
        showToast(err.message, 'error');
        pushBtn.disabled = false;
        pushBtn.innerHTML = '<span class="icon">💰</span> Push to YNAB';
        return false;
    }
    return true;
}

export async function pushAllToYNAB() {
    const allCards = Array.from(DOM.receiptList.querySelectorAll('.receipt-card'));
    const readyCards = allCards.filter(card => {
        const pushBtn = card.querySelector('.btn-push');
        return !card.classList.contains('processing') && !pushBtn.disabled;
    });

    if (readyCards.length === 0) {
        showToast('No receipts ready to push', 'info');
        return;
    }

    const apiPAT = DOM.apiPAT.value;
    const budgetId = DOM.budgetId.value;
    const accountId = DOM.accountId.value;
    if (!apiPAT || !budgetId || !accountId) {
        showToast('Please fill in all YNAB settings.', 'error');
        return;
    }

    let categoryData = getYNABCategories();
    let ynabCategories = Array.isArray(categoryData) ? categoryData : (categoryData.categories || []);

    if (ynabCategories.length === 0 || (!Array.isArray(categoryData) && categoryData.budgetId !== budgetId)) {
        ynabCategories = await fetchYNABCategories();
        if (ynabCategories.length === 0) {
            showToast('Could not load YNAB categories. Please check API key.', 'error');
            return;
        }
    }

    // Prepare all transactions
    const validTransactions = [];
    const processedCards = [];

    for (const card of readyCards) {
        const result = prepareTransactionData(card, ynabCategories, accountId);
        if (result.error) {
            // Highlight error on card but don't block others (or maybe warn user?)
            // For now, let's skip invalid ones and notify at the end
            console.error(`Skipping card due to error: ${result.error}`);
            continue;
        }
        validTransactions.push(result.data);
        processedCards.push(card);
    }

    if (validTransactions.length === 0) {
        showToast('No valid transactions to push.', 'warning');
        return;
    }

    // UI Updates: Disable buttons
    DOM.btnPushAll.disabled = true;
    const allPushBtns = Array.from(DOM.receiptList.querySelectorAll('.btn-push'));
    allPushBtns.forEach(btn => btn.disabled = true);

    // Update progress text
    DOM.progressCounter.querySelector('.progress-text').textContent = `Pushing ${validTransactions.length} transactions...`;

    try {
        const response = await fetch(`https://api.ynab.com/v1/budgets/${budgetId}/transactions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiPAT}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ transactions: validTransactions })
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error.detail || 'YNAB Bulk API error');
        }

        const data = await response.json();
        // data.data.transaction_ids or duplicate_import_ids might be useful but we just assume success for now

        showToast(`Successfully pushed ${validTransactions.length} receipts to YNAB!`, 'success');

        // Cleanup processed cards
        processedCards.forEach(card => {
            const fileName = card.querySelector('.merchant-input').placeholder || 'receipt';
            card.classList.add('synced');
            setTimeout(() => {
                card.remove();
                markAsProcessed(fileName);
                updateProgressCounter();
            }, 500);
        });

    } catch (err) {
        console.error('Bulk push error:', err);
        showToast(`Bulk push failed: ${err.message}`, 'error');
        // Re-enable buttons if failed
        allPushBtns.forEach(btn => {
            // Only re-enable if it wasn't already disabled (but here we disabled all, so re-enable all)
            // Actually we should only re-enable the ones we tried to push
            btn.disabled = false;
            btn.innerHTML = '<span class="icon">💰</span> Push to YNAB';
        });
    } finally {
        DOM.btnPushAll.disabled = false;
        updateProgressCounter();
    }
}
