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

test('朝日新聞・東洋経済の目印', () => {
  assert.equal(detectAccess('<span class="x">有料記事</span>', 'https://www.asahi.com/articles/AST1.html'), 'paid');
  assert.equal(detectAccess('<p>有料会員になると会員限定の<span>有料記事もお読みいただけます</span></p>', 'https://www.asahi.com/articles/AST2.html'), null);
  assert.equal(detectAccess('<span class="article-heading__member --paid-lock">有料会員限定</span>', 'https://toyokeizai.net/articles/-/3'), 'paid');
});
