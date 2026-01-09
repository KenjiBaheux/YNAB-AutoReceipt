import { DOM } from './dom.js';
import { showToast, updateProgressCounter } from './ui.js';
import { setYNABCategories, getYNABCategories, markAsProcessed, CONFIG } from './config.js';

export async function fetchYNABCategories() {
    const apiPAT = DOM.apiPAT.value;
    const budgetId = DOM.budgetId.value;

    if (!apiPAT || !budgetId) return;

    try {
        const response = await fetch(`https://api.ynab.com/v1/budgets/${budgetId}/categories`, {
            headers: { 'Authorization': `Bearer ${apiPAT}` }
        });

        if (!response.ok) throw new Error('Failed to fetch categories');

        const data = await response.json();
        const groups = data.data.category_groups;

        const categories = [];
        groups.forEach(group => {
            if (group.hidden || group.deleted) return;
            group.categories.forEach(cat => {
                if (!cat.hidden && !cat.deleted) {
                    categories.push({
                        id: cat.id,
                        name: cat.name,
                        group: group.name
                    });
                }
            });
        });

        setYNABCategories(categories);
        console.log(`Loaded ${categories.length} YNAB categories`);
    } catch (err) {
        console.error('Error loading YNAB categories:', err);
        // Don't show toast here to avoid spamming on init if offline/bad key
    }
}

export async function pushToYNAB(card, fileName) {
    const apiPAT = DOM.apiPAT.value;
    const budgetId = DOM.budgetId.value;
    const accountId = DOM.accountId.value;
    const ynabCategories = getYNABCategories();

    if (!apiPAT || !budgetId || !accountId) {
        showToast('Please fill in all YNAB settings.', 'error');
        return;
    }

    const merchant = card.querySelector('.merchant-input').value;
    const date = card.querySelector('.date-input').value;
    const amountVal = card.querySelector('.amount-input').value;
    const categoryName = card.querySelector('.category-input').value;

    if (!merchant || !date || !amountVal) {
        showToast('Please verify all fields before pushing.', 'error');
        return;
    }

    // Resolve Category ID
    let categoryId = null;
    if (categoryName) {
        const match = ynabCategories.find(c => c.name === categoryName);
        if (match) {
            categoryId = match.id;
        } else if (ynabCategories.length > 0) {
            // If we have categories loaded but user typed something else
            showToast(`Category "${categoryName}" not found in YNAB. Please select a valid category.`, 'error');
            return;
        }
    }

    const amount = parseInt(amountVal) * 1000; // JPY Amount * 1000 for YNAB milliunits

    const transaction = {
        transaction: {
            account_id: accountId,
            date: date,
            amount: -Math.abs(amount), // Outflow
            payee_name: merchant,
            category_id: categoryId,
            cleared: 'cleared'
        }
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

        showToast(`Synced ${card.dataset.merchant || merchant} to YNAB!`, 'success');
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

    // Disable the Push All button during operation
    DOM.btnPushAll.disabled = true;

    // Disable all individual push buttons to prevent interference
    const allPushBtns = Array.from(DOM.receiptList.querySelectorAll('.btn-push'));
    allPushBtns.forEach(btn => btn.disabled = true);

    let successCount = 0;
    let errorCount = 0;
    const total = readyCards.length;

    for (let i = 0; i < readyCards.length; i++) {
        const card = readyCards[i];
        const fileName = card.querySelector('.merchant-input').placeholder || 'receipt';

        // Update progress
        DOM.progressCounter.querySelector('.progress-text').textContent = `Pushing ${i + 1}/${total}...`;

        try {
            await pushToYNAB(card, fileName);
            successCount++;
        } catch (err) {
            console.error(`Failed to push ${fileName}:`, err);
            errorCount++;
        }
    }

    // Show final summary
    if (errorCount === 0) {
        showToast(`Successfully pushed ${successCount} receipt${successCount !== 1 ? 's' : ''} to YNAB!`, 'success');
    } else {
        showToast(`Pushed ${successCount}/${total} receipts (${errorCount} failed)`, 'error');
    }

    // Re-enable remaining push buttons
    const remainingPushBtns = Array.from(DOM.receiptList.querySelectorAll('.btn-push'));
    remainingPushBtns.forEach(btn => btn.disabled = false);

    // Restore analysis progress counter
    updateProgressCounter();
}
