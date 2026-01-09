export async function optimizeImageForAI(file) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d', { willReadFrequently: true });

            // Limit analysis size to avoid performance issues
            const scale = Math.min(1, 1500 / Math.max(img.width, img.height));
            canvas.width = img.width * scale;
            canvas.height = img.height * scale;
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const bounds = findContentBounds(imageData);

            // Map bounds back to original size
            const finalBounds = {
                top: Math.max(0, (bounds.top / scale) - 20),
                bottom: Math.min(img.height, (bounds.bottom / scale) + 20),
                left: Math.max(0, (bounds.left / scale) - 20),
                right: Math.min(img.width, (bounds.right / scale) + 20)
            };

            const cropWidth = finalBounds.right - finalBounds.left;
            const cropHeight = finalBounds.bottom - finalBounds.top;

            const finalCanvas = document.createElement('canvas');
            finalCanvas.width = cropWidth;
            finalCanvas.height = cropHeight;
            const finalCtx = finalCanvas.getContext('2d');
            finalCtx.drawImage(img, finalBounds.left, finalBounds.top, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

            finalCanvas.toBlob(blob => {
                resolve({
                    blob,
                    url: URL.createObjectURL(blob),
                    bounds: finalBounds
                });
            }, 'image/jpeg', 0.9);
        };
        img.onerror = reject;
        img.src = URL.createObjectURL(file);
    });
}

function findContentBounds(imageData) {
    const { width, height, data } = imageData;
    let top = 0, bottom = height, left = 0, right = width;

    // Helper to check if a pixel is "not background"
    // We assume background is mostly white/light
    const isContent = (x, y) => {
        const idx = (y * width + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        // Threshold: If any channel is < 235 (not pure white)
        return r < 235 || g < 235 || b < 235;
    };

    // Scan from top
    for (let y = 0; y < height; y++) {
        let hasContent = false;
        for (let x = 0; x < width; x++) {
            if (isContent(x, y)) {
                hasContent = true;
                break;
            }
        }
        if (hasContent) {
            top = y;
            break;
        }
    }

    // Scan from bottom
    for (let y = height - 1; y >= top; y--) {
        let hasContent = false;
        for (let x = 0; x < width; x++) {
            if (isContent(x, y)) {
                hasContent = true;
                break;
            }
        }
        if (hasContent) {
            bottom = y;
            break;
        }
    }

    // Scan from left
    for (let x = 0; x < width; x++) {
        let hasContent = false;
        for (let y = top; y <= bottom; y++) {
            if (isContent(x, y)) {
                hasContent = true;
                break;
            }
        }
        if (hasContent) {
            left = x;
            break;
        }
    }

    // Scan from right
    for (let x = width - 1; x >= left; x--) {
        let hasContent = false;
        for (let y = top; y <= bottom; y++) {
            if (isContent(x, y)) {
                hasContent = true;
                break;
            }
        }
        if (hasContent) {
            right = x;
            break;
        }
    }

    return { top, bottom, left, right };
}
