import assert from 'node:assert/strict';
import test from 'node:test';
import { cropRectFromPointer } from '../src/utils/screenshot-geometry.js';

test('screenshot crop scales independently on each display axis', () => {
    assert.deepEqual(
        cropRectFromPointer(110, 70, 210, 170, { left: 10, top: 20, width: 400, height: 300 }, 800, 900),
        { left: 200, top: 150, width: 200, height: 300 },
    );
});

test('screenshot crop clamps drags outside the image', () => {
    assert.deepEqual(
        cropRectFromPointer(200, 200, -100, -100, { left: 0, top: 0, width: 100, height: 100 }, 200, 200),
        { left: 0, top: 0, width: 200, height: 200 },
    );
    assert.equal(cropRectFromPointer(200, 200, 210, 210, { left: 0, top: 0, width: 100, height: 100 }, 200, 200), null);
});
