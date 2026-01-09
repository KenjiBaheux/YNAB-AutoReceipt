import { DOM } from './dom.js';

export function showToast(message, type = 'info', duration = 3000) {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;

    DOM.toastContainer.appendChild(toast);

    // Trigger reflow
    toast.offsetHeight;
    toast.classList.add('visible');

    setTimeout(() => {
        toast.classList.remove('visible');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

export function updateProgressCounter() {
    const allCards = Array.from(DOM.receiptList.querySelectorAll('.receipt-card'));
    const total = allCards.length;
    const analyzed = allCards.filter(card => !card.classList.contains('processing')).length;

    if (total === 0) {
        DOM.progressCounter.style.display = 'none';
        DOM.btnPushAll.disabled = true;
        return;
    }

    DOM.progressCounter.style.display = 'flex';
    DOM.progressCounter.querySelector('.progress-text').textContent = `Analyzed ${analyzed}/${total}...`;

    // Enable Push All button if at least one receipt is analyzed
    DOM.btnPushAll.disabled = analyzed === 0;
}

export function renderChips(container, values, onSelect) {
    container.innerHTML = '';
    // If only one (or no) value, nothing to suggest
    if (!values || values.length <= 1) return;

    values.forEach((val, idx) => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        if (idx === 0) chip.classList.add('active');

        // Formatting for display
        let displayVal = val;
        if (typeof val === 'number') displayVal = `¥${val}`;

        chip.textContent = displayVal;
        chip.title = `Switch to ${displayVal}`;

        chip.addEventListener('click', () => {
            onSelect(val);
            container.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
        });
        container.appendChild(chip);
    });
}
