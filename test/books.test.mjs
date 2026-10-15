import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findIsbns } from '../scripts/lib/books.mjs';

test('findIsbns: ISBN-13 と Amazon のリンク（ISBN-10）を拾う', () => {
  const html = `
    <p>ISBN978-4-7993-1305-3</p>
    <a href="https://www.amazon.co.jp/dp/4478121234">Amazon</a>
    <a href="https://www.amazon.co.jp/%E6%9B%B8%E5%90%8D/dp/4492123456/ref=x">Amazon</a>
    <span>9781234567890</span>`;
  const isbns = findIsbns(html);
  assert.ok(isbns.has('9784799313053'));
  assert.ok(isbns.has('9784478121238'));
  assert.ok(isbns.has('9784492123454'));
  // チェックディジットが合わない数字列は無視する
  assert.ok(!isbns.has('9781234567890'));
});
