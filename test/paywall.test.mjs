import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectAccess } from '../scripts/lib/paywall.mjs';

test('構造化データ isAccessibleForFree:false は有料記事', () => {
  const html = '<script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":false}</script>';
  assert.equal(detectAccess(html, 'https://toyokeizai.net/articles/-/1'), 'paid');
  assert.equal(detectAccess('{"isAccessibleForFree": "False"}', 'https://example.com/a'), 'paid');
});

test('無料の記事やメニューに「有料会員」とあるだけの記事は判定しない', () => {
  assert.equal(detectAccess('{"isAccessibleForFree":true}', 'https://www3.nhk.or.jp/news/1'), null);
  assert.equal(detectAccess('<a href="/tkm/">有料会員登録</a>', 'https://toyokeizai.net/articles/-/2'), null);
});

test('日本経済新聞の会員限定記事', () => {
  const html = '<span class="text_t1xreeks">この記事は会員限定記事です</span>';
  assert.equal(detectAccess(html, 'https://www.nikkei.com/article/DGXZQO1/'), 'members');
  // 他のサイトでは日経の目印を使わない
  assert.equal(detectAccess(html, 'https://example.com/'), null);
});
