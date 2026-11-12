import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// `.cargo/audit.toml` 是安全例外的登记处，不是通用的告警压制开关。
// 每条条目都必须是 2026-11-11 复审过、且不进入任何发布目标编译图的告警。
const REVIEWED_LOCK_ONLY = [
    'RUSTSEC-2024-0399',
    'RUSTSEC-2026-0285',
    'RUSTSEC-2026-0346',
    'RUSTSEC-2026-0348',
    'RUSTSEC-2026-0349',
    'RUSTSEC-2026-0049',
    'RUSTSEC-2026-0098',
    'RUSTSEC-2026-0099',
    'RUSTSEC-2026-0104',
    'RUSTSEC-2026-0382',
    'RUSTSEC-2025-0009',
    'RUSTSEC-2026-0001',
    'RUSTSEC-2026-0235',
    'RUSTSEC-2023-0071',
    'RUSTSEC-2025-0055',
];

// 这 8 条进入发布产物，必须继续报告；出现在忽略清单里说明抑制范围被扩大。
const RELEASE_BUILD_ADVISORIES = [
    'RUSTSEC-2026-0258',
    'RUSTSEC-2026-0459',
    'RUSTSEC-2026-0194',
    'RUSTSEC-2026-0195',
    'RUSTSEC-2026-0429',
    'RUSTSEC-2026-0367',
    'RUSTSEC-2026-0368',
    'RUSTSEC-2026-0369',
];

test('cargo audit ignores only the reviewed lockfile-only advisories', async () => {
    const toml = await readFile('.cargo/audit.toml', 'utf8');
    const ids = [...toml.matchAll(/"(RUSTSEC-\d{4}-\d{4})"/g)].map((match) => match[1]);

    assert.equal(
        ids.length,
        REVIEWED_LOCK_ONLY.length,
        'ignore list size changed; update docs/reviews/dependency-audit-2026-11-04.md and this test together'
    );
    assert.deepEqual(
        [...ids].sort(),
        [...REVIEWED_LOCK_ONLY].sort(),
        'ignore list must match the reviewed advisory IDs'
    );
    for (const id of RELEASE_BUILD_ADVISORIES) {
        assert.ok(!ids.includes(id), `${id} reaches release builds and must not be ignored`);
    }
    assert.match(toml, /复审截止：2027-02-11/, 'ignore list must keep a review deadline');
});
