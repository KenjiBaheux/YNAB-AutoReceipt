import { DOM } from './dom.js';

// --- State ---
let activeRedactionCard = null;
let isBoxDragging = false;
let startX, startY;
let currentCropBox = null; // Standardised internally as { x, y, w, h }
let currentRedactions = [];
let interactionType = null; // 'crop-move', 'crop-resize', 'redaction-move', 'redaction-resize', 'draw-redaction'
let activeHandle = null;
let selectedRedactionIndex = -1;

// --- Helper Functions for Coordinate Conversion & Styling ---

function boxToRect(bounds) {
    if (!bounds) return null;
    return {
        x: bounds.left,
        y: bounds.top,
        w: bounds.right - bounds.left,
        h: bounds.bottom - bounds.top
    };
}

function rectToBox(rect) {
    if (!rect) return null;
    return {
        left: rect.x,
        top: rect.y,
        right: rect.x + rect.w,
        bottom: rect.y + rect.h
    };
}

function updateRectStyles(element, rect, scaleX, scaleY) {
    element.style.left = `${rect.x * scaleX}px`;
    element.style.top = `${rect.y * scaleY}px`;
    element.style.width = `${rect.w * scaleX}px`;
    element.style.height = `${rect.h * scaleY}px`;
}

// --- Modal & Interaction Setup ---

export function setupCroppingUI(img, bounds) {
    const container = document.getElementById('crop-overlay');
    container.innerHTML = '';
    if (!bounds) return;

    currentCropBox = boxToRect(bounds);

    const rect = img.getBoundingClientRect();
    const scaleX = rect.width / img.naturalWidth;
    const scaleY = rect.height / img.naturalHeight;

    const box = document.createElement('div');
    box.className = 'crop-box';
    updateRectStyles(box, currentCropBox, scaleX, scaleY);

    const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
    handles.forEach(h => {
        const handle = document.createElement('div');
        handle.className = `crop-handle handle-${h}`;
        handle.dataset.handle = h;
        box.appendChild(handle);
    });

    box.addEventListener('mousedown', (e) => startBoxInteraction(e, 'crop'));
    container.appendChild(box);
}

export function startBoxInteraction(e, type, index = -1) {
    e.preventDefault();
    e.stopPropagation();
    isBoxDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    selectedRedactionIndex = index;

    if (type === 'draw-redaction') {
        interactionType = 'draw-redaction';
        return;
    }

    if (e.target.classList.contains('crop-handle')) {
        interactionType = `${type}-resize`;
        activeHandle = e.target.dataset.handle;
    } else {
        interactionType = `${type}-move`;
    }
}

// --- Global Mouse Move & Up Handlers ---

window.addEventListener('mousemove', (e) => {
    if (!isBoxDragging) return;
    e.preventDefault();

    const img = DOM.modalImg;
    const rect = img.getBoundingClientRect();
    const scaleX = img.naturalWidth / rect.width;
    const scaleY = img.naturalHeight / rect.height;

    const deltaX = (e.clientX - startX) * scaleX;
    const deltaY = (e.clientY - startY) * scaleY;

    if (interactionType.startsWith('crop')) {
        updateRect(currentCropBox, deltaX, deltaY, img.naturalWidth, img.naturalHeight);

        const box = document.querySelector('.crop-box');
        if (box) updateRectStyles(box, currentCropBox, 1 / scaleX, 1 / scaleY);

        const card = getActiveRedactionCard().card;
        card.dataset.bounds = JSON.stringify(rectToBox(currentCropBox));
    }
    else if (interactionType.startsWith('redaction') && selectedRedactionIndex !== -1) {
        const redaction = currentRedactions[selectedRedactionIndex];
        updateRect(redaction, deltaX, deltaY, img.naturalWidth, img.naturalHeight);

        renderRedactions(currentRedactions);

        const activeData = getActiveRedactionCard();
        activeData.redactions = currentRedactions;
        activeData.card.dataset.redactions = JSON.stringify(currentRedactions);
    }
    else if (interactionType === 'draw-redaction') {
        const canvas = document.getElementById('redaction-canvas');
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const startRelX = startX - rect.left;
        const startRelY = startY - rect.top;

        ctx.fillStyle = 'rgba(255, 77, 77, 0.5)';
        ctx.fillRect(startRelX, startRelY, mouseX - startRelX, mouseY - startRelY);
        ctx.strokeStyle = '#ff4d4d';
        ctx.lineWidth = 2;
        ctx.strokeRect(startRelX, startRelY, mouseX - startRelX, mouseY - startRelY);
    }

    if (interactionType !== 'draw-redaction') {
        startX = e.clientX;
        startY = e.clientY;
    }
});

window.addEventListener('mouseup', (e) => {
    if (interactionType === 'draw-redaction' && isBoxDragging) {
        const img = DOM.modalImg;
        const rect = img.getBoundingClientRect();
        const scaleX = img.naturalWidth / rect.width;
        const scaleY = img.naturalHeight / rect.height;

        const endX = e.clientX;
        const endY = e.clientY;

        const x = Math.min(startX, endX) - rect.left;
        const y = Math.min(startY, endY) - rect.top;
        const w = Math.abs(endX - startX);
        const h = Math.abs(endY - startY);

        if (w > 5 && h > 5) {
            const newRedaction = {
                x: x * scaleX,
                y: y * scaleY,
                w: w * scaleX,
                h: h * scaleY
            };
            currentRedactions.push(newRedaction);

            renderRedactions(currentRedactions);
            updateModalToolbar();

            const canvas = document.getElementById('redaction-canvas');
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            const activeData = getActiveRedactionCard();
            activeData.redactions = currentRedactions;
            activeData.card.dataset.redactions = JSON.stringify(currentRedactions);
        }
    }

    isBoxDragging = false;
    interactionType = null;
    activeHandle = null;
});

function updateRect(rectObj, dx, dy, maxW, maxH) {
    if (interactionType.endsWith('move')) {
        rectObj.x = Math.max(0, Math.min(rectObj.x + dx, maxW - rectObj.w));
        rectObj.y = Math.max(0, Math.min(rectObj.y + dy, maxH - rectObj.h));
    }
    else if (interactionType.endsWith('resize')) {
        const minSize = 10;
        if (activeHandle.includes('n')) {
            const newY = Math.max(0, Math.min(rectObj.y + dy, rectObj.y + rectObj.h - minSize));
            rectObj.h += rectObj.y - newY;
            rectObj.y = newY;
        }
        if (activeHandle.includes('s')) {
            rectObj.h = Math.max(minSize, Math.min(rectObj.h + dy, maxH - rectObj.y));
        }
        if (activeHandle.includes('w')) {
            const newX = Math.max(0, Math.min(rectObj.x + dx, rectObj.x + rectObj.w - minSize));
            rectObj.w += rectObj.x - newX;
            rectObj.x = newX;
        }
        if (activeHandle.includes('e')) {
            rectObj.w = Math.max(minSize, Math.min(rectObj.w + dx, maxW - rectObj.x));
        }
    }
}

// --- Public Interface ---

export function setActiveRedactionCard(data) {
    activeRedactionCard = data;
    currentRedactions = data.redactions || [];
}

export function getActiveRedactionCard() {
    return activeRedactionCard;
}

export function updateModalToolbar() {
    const modal = document.getElementById('full-view-modal');
    const isRedactMode = modal.classList.contains('redact-mode');

    const btnDelete = document.getElementById('btn-delete-redaction');
    const btnClear = document.getElementById('btn-clear-redaction');

    if (isRedactMode) {
        btnDelete.style.display = 'block';
        btnClear.style.display = 'block';

        btnDelete.disabled = (selectedRedactionIndex === -1);
        btnClear.disabled = (currentRedactions.length === 0);

        btnDelete.style.opacity = btnDelete.disabled ? '0.5' : '1';
        btnClear.style.opacity = btnClear.disabled ? '0.5' : '1';
    } else {
        btnDelete.style.display = 'none';
        btnClear.style.display = 'none';
    }
}

export function renderRedactions(redactions) {
    currentRedactions = redactions;
    const container = document.getElementById('redactions-container');
    container.innerHTML = '';
    const img = document.getElementById('full-receipt-img');
    const rect = img.getBoundingClientRect();
    const scaleX = rect.width / img.naturalWidth;
    const scaleY = rect.height / img.naturalHeight;

    currentRedactions.forEach((r, index) => {
        const div = document.createElement('div');
        div.className = `redaction-block ${index === selectedRedactionIndex ? 'selected' : ''}`;
        updateRectStyles(div, r, scaleX, scaleY);

        if (index === selectedRedactionIndex) {
            const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
            handles.forEach(h => {
                const handle = document.createElement('div');
                handle.className = `crop-handle handle-${h}`;
                handle.dataset.handle = h;
                div.appendChild(handle);
            });
        }

        div.addEventListener('mousedown', (e) => {
            if (!document.getElementById('full-view-modal').classList.contains('redact-mode')) return;
            e.stopPropagation();
            selectedRedactionIndex = index;
            renderRedactions(currentRedactions);
            updateModalToolbar();
            startBoxInteraction(e, 'redaction', index);
        });

        container.appendChild(div);
    });
}

export function setupRedactionCanvas() {
    const modalImg = DOM.modalImg;
    const canvas = document.getElementById('redaction-canvas');
    const rect = modalImg.getBoundingClientRect();

    canvas.width = rect.width;
    canvas.height = rect.height;
    canvas.style.display = 'block';

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    canvas.onmousedown = (e) => startBoxInteraction(e, 'draw-redaction');
}

export function clearRedactionCanvas() {
    const canvas = document.getElementById('redaction-canvas');
    canvas.style.display = 'none';
}

export function deleteSelectedRedaction() {
    if (selectedRedactionIndex === -1) return;
    currentRedactions.splice(selectedRedactionIndex, 1);
    selectedRedactionIndex = -1;
    renderRedactions(currentRedactions);
    updateModalToolbar();

    const activeData = getActiveRedactionCard();
    activeData.redactions = currentRedactions;
    activeData.card.dataset.redactions = JSON.stringify(currentRedactions);
}

export function clearAllRedactions() {
    currentRedactions = [];
    selectedRedactionIndex = -1;

    const container = document.getElementById('redactions-container');
    if (container) container.innerHTML = '';

    renderRedactions(currentRedactions);
    updateModalToolbar();

    const activeData = getActiveRedactionCard();
    if (activeData && activeData.card) {
        activeData.redactions = currentRedactions;
        activeData.card.dataset.redactions = JSON.stringify(currentRedactions);
    }
}
