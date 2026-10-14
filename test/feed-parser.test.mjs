import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseFeed, stripHtml } from '../scripts/lib/feed-parser.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('RSS 2.0: タイトル・リンク・日付・画像を取り出す', () => {
  const items = parseFeed(fixture('rss2.xml'));
  assert.equal(items.length, 2, 'リンクのない item は除外される');
  assert.equal(items[0].title, '円相場、一時150円台に　"介入警戒"');
  assert.equal(items[0].url, 'https://example.com/a/1?utm_source=rss');
  assert.equal(items[0].publishedAt, '2026-10-14T00:30:00.000Z');
  assert.equal(items[0].summary, '東京外国為替市場で円安が進んだ。');
  assert.equal(items[0].image, 'https://example.com/img/1.jpg');
  assert.equal(items[1].image, 'https://example.com/img/2.jpg');
  assert.equal(items[1].summary, 'エンティティ化された&HTML');
});

test('RSS 1.0 (はてなブックマーク): ブックマーク数と画像', () => {
  const [item] = parseFeed(fixture('rdf.xml'));
  assert.equal(item.title, '個人開発でニュースアプリを作った話');
  assert.equal(item.url, 'https://example.org/post');
  assert.equal(item.score, 512);
  assert.equal(item.image, 'https://example.org/og.png');
  assert.equal(item.publishedAt, '2026-10-13T22:12:34.000Z');
});

test('Atom: alternate リンクを使う', () => {
  const [item] = parseFeed(fixture('atom.xml'));
  assert.equal(item.title, 'Atom & エントリー');
  assert.equal(item.url, 'https://example.net/entry/1');
  assert.equal(item.summary, '概要テキスト');
  assert.equal(item.score, null);
});

test('stripHtml: script を除去し空白を詰める', () => {
  assert.equal(stripHtml('<p>a</p>\n<script>x()</script>  <p>b</p>'), 'a b');
});
