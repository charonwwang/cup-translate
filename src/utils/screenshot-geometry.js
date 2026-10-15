export function cropRectFromPointer(startX, startY, endX, endY, bounds, imageWidth, imageHeight) {
    if (
        !bounds ||
        bounds.width <= 0 ||
        bounds.height <= 0 ||
        imageWidth <= 0 ||
        imageHeight <= 0 ||
        ![
            startX,
            startY,
            endX,
            endY,
            bounds.left,
            bounds.top,
            bounds.width,
            bounds.height,
            imageWidth,
            imageHeight,
        ].every(Number.isFinite)
    ) {
        return null;
    }

    const clamp = (value, limit) => Math.max(0, Math.min(value, limit));
    const scaleX = imageWidth / bounds.width;
    const scaleY = imageHeight / bounds.height;
    const left = clamp(Math.floor((Math.min(startX, endX) - bounds.left) * scaleX), imageWidth);
    const top = clamp(Math.floor((Math.min(startY, endY) - bounds.top) * scaleY), imageHeight);
    const right = clamp(Math.ceil((Math.max(startX, endX) - bounds.left) * scaleX), imageWidth);
    const bottom = clamp(Math.ceil((Math.max(startY, endY) - bounds.top) * scaleY), imageHeight);

    if (right <= left || bottom <= top) return null;
    return { left, top, width: right - left, height: bottom - top };
}
