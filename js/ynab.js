import { DOM } from './dom.js';
import { showToast, updateProgressCounter } from './ui.js';
import { setYNABCategories, getYNABCategories, markAsProcessed, CONFIG, getYNABPayees, setYNABPayees, getYNABPayeeCategories, setYNABPayeeCategories } from './config.js';

// --- API Helpers ---

async function ynabFetch(endpoint, options = {}) {
    const apiPAT = DOM.apiPAT.value;
    if (!apiPAT) return null;

    const url = `https://api.ynab.com/v1/${endpoint}`;
    const headers = {
        'Authorization': `Bearer ${apiPAT}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers
    };

    try {
        const response = await fetch(url, { ...options, headers });
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error?.detail || `YNAB API error (${response.status})`);
        }
        return await response.json();
    } catch (err) {
        console.error(`Error YNAB request to ${endpoint}:`, err);
        showToast(err.message || 'YNAB connection failed', 'error');
        throw err;
    }
}

async function postTransactions(payload) {
    const budgetId = DOM.budgetId.value;
    return ynabFetch(`budgets/${budgetId}/transactions`, {
        method: 'POST',
        body: JSON.stringify(payload)
    });
}

// --- UI Rendering Helpers ---

function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/[&<>'"]/g, 
        tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
    );
}

function populateSelect(selectEl, items, selectedValue, defaultText, formatter = (x) => x) {
    if (!selectEl) return;
    selectEl.innerHTML = `<option value="">${defaultText}</option>` +
        items.map(item => {
            const val = typeof item === 'object' ? item.id : item;
            const formatted = formatter(item);
            return `<option value="${escapeHTML(val)}" ${val === selectedValue ? 'selected' : ''}>${escapeHTML(formatted)}</option>`;
        }).join('');
}

function updateBudgetDropdown(budgets) {
    const currentBudgetId = localStorage.getItem(CONFIG.ynabBudgetIdPath);
    [DOM.budgetId, DOM.setupBudget].forEach(el => 
        populateSelect(el, budgets, currentBudgetId, 'Select a budget...', b => b.name)
    );
}

function updateAccountDropdown(accounts) {
    const currentAccountId = localStorage.getItem(CONFIG.ynabAccountIdPath);
    [DOM.accountId, DOM.setupAccount, DOM.settingsAccountId].forEach(el => 
        populateSelect(el, accounts, currentAccountId, 'Select an account...', a => `${a.name} (${a.type})`)
    );
}

function updateCategoryUI(categories) {
    const list = document.getElementById('ynab-category-list');
    const countLabel = document.getElementById('category-count');

    if (list) {
        list.innerHTML = categories.map(c => 
            `<option value="${escapeHTML(c.name)}">${escapeHTML(c.group)}: ${escapeHTML(c.name)}</option>`
        ).join('');
    }
    if (countLabel) {
        countLabel.textContent = `${categories.length} cats`;
    }
}

export function updatePayeeUI(payees) {
    const list = document.getElementById('ynab-merchant-list');
    if (list) {
        const arr = Array.isArray(payees) ? payees : [];
        list.innerHTML = arr.slice(0, 100).map(p => `<option value="${escapeHTML(p)}"></option>`).join('');
    }
}

// --- Data Fetching Functions ---

export async function fetchYNABBudgets() {
    try {
        const data = await ynabFetch('budgets');
        if (!data) return [];
        const budgets = data.data.budgets.map(b => ({ id: b.id, name: b.name }));
        updateBudgetDropdown(budgets);
        return budgets;
    } catch {
        return [];
    }
}

export async function fetchYNABAccounts(budgetId) {
    if (!budgetId) return [];
    try {
        const data = await ynabFetch(`budgets/${budgetId}/accounts`);
        if (!data) return [];
        const accounts = data.data.accounts
            .filter(a => a.on_budget && !a.closed)
            .map(a => ({ id: a.id, name: a.name, type: a.type }));
        updateAccountDropdown(accounts);
        return accounts;
    } catch {
        return [];
    }
}

async function ensureCategoriesLoaded(budgetId) {
    const categoryData = getYNABCategories();
    let ynabCategories = Array.isArray(categoryData) ? categoryData : (categoryData?.categories || []);
    if (ynabCategories.length === 0 || (!Array.isArray(categoryData) && categoryData.budgetId !== budgetId)) {
        ynabCategories = await fetchYNABCategories();
    }
    return ynabCategories;
}

export async function fetchYNABCategories(forceRefresh = false) {
    const budgetId = DOM.budgetId.value;
    if (!budgetId) {
        updateCategoryUI([]);
        return [];
    }

    const cached = getYNABCategories();
    if (!forceRefresh && cached && cached.budgetId === budgetId && cached.categories.length > 0) {
        console.log(`Using ${cached.categories.length} cached YNAB categories for budget ${budgetId}`);
        updateCategoryUI(cached.categories);
        return cached.categories;
    }

    const refreshBtn = document.getElementById('btn-refresh-categories');
    if (refreshBtn) refreshBtn.classList.add('rotating');

    try {
        const data = await ynabFetch(`budgets/${budgetId}/categories`);
        if (!data) return [];

        const categoriesList = [];
        data.data.category_groups.forEach(group => {
            if (group.hidden || group.deleted) return;
            group.categories.forEach(cat => {
                if (!cat.hidden && !cat.deleted) {
                    categoriesList.push({ id: cat.id, name: cat.name, group: group.name });
                }
            });
        });

        setYNABCategories({ budgetId, categories: categoriesList });
        updateCategoryUI(categoriesList);
        showToast(`Loaded ${categoriesList.length} YNAB categories`, 'success');
        return categoriesList;
    } catch {
        return [];
    } finally {
        if (refreshBtn) refreshBtn.classList.remove('rotating');
    }
}

export async function fetchYNABPayees(forceRefresh = false) {
    const budgetId = DOM.budgetId.value;
    if (!budgetId) {
        updatePayeeUI([]);
        return [];
    }

    const cached = getYNABPayees();
    if (!forceRefresh && cached && cached.budgetId === budgetId && cached.payees.length > 0) {
        console.log(`Using ${cached.payees.length} cached YNAB payees for budget ${budgetId}`);
        updatePayeeUI(cached.payees);
        return cached.payees;
    }

    try {
        const data = await ynabFetch(`budgets/${budgetId}/payees`);
        if (!data) return [];

        const payeesList = data.data.payees
            .filter(p => !p.deleted && !p.transfer_account_id)
            .map(p => p.name);

        setYNABPayees({ budgetId, payees: payeesList });
        updatePayeeUI(payeesList);
        return payeesList;
    } catch {
        return [];
    }
}

export async function fetchYNABTransactionsAndBuildMap(forceRefresh = false) {
    const budgetId = DOM.budgetId.value;
    if (!budgetId) return null;

    const cached = getYNABPayeeCategories();
    if (!forceRefresh && cached && cached.budgetId === budgetId && cached.map) {
        console.log(`Using cached YNAB payee->category map for budget ${budgetId}`);
        const cachedPayeesData = getYNABPayees();
        if (cachedPayeesData && cachedPayeesData.budgetId === budgetId && cachedPayeesData.payees) {
            updatePayeeUI(cachedPayeesData.payees);
        }
        return cached.map;
    }

    try {
        const data = await ynabFetch(`budgets/${budgetId}/transactions`);
        if (!data) return null;

        const freqMap = {};
        const payeeCountMap = {};
        for (const t of data.data.transactions) {
            if (t.deleted || !t.payee_name || !t.category_name || t.category_name === 'Uncategorized' || t.transfer_account_id) continue;

            const { payee_name: payee, category_name: category } = t;
            freqMap[payee] = freqMap[payee] || {};
            freqMap[payee][category] = (freqMap[payee][category] || 0) + 1;
            payeeCountMap[payee] = (payeeCountMap[payee] || 0) + 1;
        }

        const finalMap = {};
        for (const payee in freqMap) {
            let maxCount = 0;
            let bestCategory = null;
            for (const category in freqMap[payee]) {
                if (freqMap[payee][category] > maxCount) {
                    maxCount = freqMap[payee][category];
                    bestCategory = category;
                }
            }
            if (bestCategory) finalMap[payee] = bestCategory;
        }

        setYNABPayeeCategories({ budgetId, map: finalMap });

        const cachedPayeesData = getYNABPayees();
        if (cachedPayeesData && cachedPayeesData.budgetId === budgetId && cachedPayeesData.payees) {
            const payeesList = [...cachedPayeesData.payees].sort((a, b) => {
                const countDiff = (payeeCountMap[b] || 0) - (payeeCountMap[a] || 0);
                return countDiff !== 0 ? countDiff : a.localeCompare(b);
            });
            setYNABPayees({ budgetId, payees: payeesList });
            updatePayeeUI(payeesList);
        }

        return finalMap;
    } catch {
        return null;
    }
}

// --- Levenshtein Distance & Payee Fuzzy Match ---

function levenshteinDistance(a, b) {
    const matrix = [];
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1, // substitution
                    matrix[i][j - 1] + 1,     // insertion
                    matrix[i - 1][j] + 1      // deletion
                );
            }
        }
    }
    return matrix[b.length][a.length];
}

export function findClosestPayee(target, payeesList) {
    if (!target || !payeesList || payeesList.length === 0) return null;

    let closest = null;
    let minDistance = Infinity;
    const normalizedTarget = target.toLowerCase().trim();

    for (const payee of payeesList) {
        const normalizedPayee = payee.toLowerCase().trim();
        if (normalizedTarget === normalizedPayee) return payee; // Exact match

        const distance = levenshteinDistance(normalizedTarget, normalizedPayee);
        if (distance < minDistance) {
            minDistance = distance;
            closest = payee;
        }
    }

    if (minDistance > 0 && minDistance <= Math.max(3, normalizedTarget.length * 0.4)) {
        return closest;
    }
    return null;
}

// --- Push Transactions ---

export function prepareTransactionData(card, ynabCategories, accountId) {
    const merchant = card.querySelector('.merchant-input').value.trim();
    const date = card.querySelector('.date-input').value;
    const amountVal = card.querySelector('.amount-input').value;
    const categoryName = card.querySelector('.category-input').value.trim();

    if (!merchant || !date || !amountVal) {
        return { error: 'Missing required fields (Merchant, Date, or Amount)' };
    }

    let categoryId = null;
    if (categoryName) {
        const normalizedInput = categoryName.toLowerCase();
        const match = ynabCategories.find(c => c.name.toLowerCase() === normalizedInput);
        if (match) {
            categoryId = match.id;
        } else {
            return { error: ynabCategories.length > 0 ? `Category "${categoryName}" not found.` : `Categories not loaded. Please refresh.` };
        }
    }

    return {
        data: {
            account_id: accountId,
            date,
            amount: -Math.abs(parseInt(amountVal) * 1000), // Outflow in milliunits
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
    const budgetId = DOM.budgetId.value;
    const accountId = DOM.accountId.value;
    if (!budgetId || !accountId) {
        showToast('Please fill in all YNAB settings.', 'error');
        return false;
    }

    const ynabCategories = await ensureCategoriesLoaded(budgetId);
    if (ynabCategories.length === 0) {
        showToast('Could not load YNAB categories. Please check API key.', 'error');
        return false;
    }

    const result = prepareTransactionData(card, ynabCategories, accountId);
    if (result.error) {
        showToast(result.error, 'error');
        return false;
    }

    const pushBtn = card.querySelector('.btn-push');
    pushBtn.disabled = true;
    pushBtn.textContent = '⏳';

    try {
        await postTransactions({ transaction: result.data });
        showToast(`Synced ${result.meta.merchant} to YNAB!`, 'success');
        card.classList.add('synced');
        setTimeout(() => {
            card.remove();
            markAsProcessed(fileName);
            updateProgressCounter();
        }, 500);
        return true;
    } catch {
        pushBtn.disabled = false;
        pushBtn.innerHTML = '<span class="icon">💰</span> Push to YNAB';
        return false;
    }
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

    const budgetId = DOM.budgetId.value;
    const accountId = DOM.accountId.value;
    if (!budgetId || !accountId) {
        showToast('Please fill in all YNAB settings.', 'error');
        return;
    }

    const ynabCategories = await ensureCategoriesLoaded(budgetId);
    if (ynabCategories.length === 0) {
        showToast('Could not load YNAB categories. Please check API key.', 'error');
        return;
    }

    const validTransactions = [];
    const processedCards = [];

    for (const card of readyCards) {
        const result = prepareTransactionData(card, ynabCategories, accountId);
        if (result.error) {
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

    DOM.btnPushAll.disabled = true;
    const allPushBtns = Array.from(DOM.receiptList.querySelectorAll('.btn-push'));
    allPushBtns.forEach(btn => btn.disabled = true);
    DOM.progressCounter.querySelector('.progress-text').textContent = `Pushing ${validTransactions.length} transactions...`;

    try {
        await postTransactions({ transactions: validTransactions });
        showToast(`Successfully pushed ${validTransactions.length} receipts to YNAB!`, 'success');

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
        allPushBtns.forEach(btn => {
            btn.disabled = false;
            btn.innerHTML = '<span class="icon">💰</span> Push to YNAB';
        });
    } finally {
        DOM.btnPushAll.disabled = false;
        updateProgressCounter();
    }
}
