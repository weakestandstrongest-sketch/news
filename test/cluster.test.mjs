import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clusterArticles, normalizeTitle } from '../scripts/lib/cluster.mjs';

let n = 0;
const art = (source, title, summary = '', hoursAgo = 1) => ({
  id: `a${++n}`, source, title, summary,
  publishedAt: new Date(Date.parse('2026-10-14T12:00:00Z') - hoursAgo * 3600_000).toISOString(),
});

// 実際の見出しを元にした例
const spyNhk = art('NHK', 'ロシアが北海道新聞記者をスパイ容疑で拘束 長期化の懸念も');
const spyBbc = art('BBCニュース', 'ロシア、スパイ容疑で日本人記者を拘束');
const spyToyo = art('東洋経済オンライン', 'スパイ容疑で北海道新聞記者をロシア当局が拘束 かつて米紙記者には懲役16年の判決後､囚人交換で帰国 | 政治・経済・投資 | 東洋経済オンライン');
const csSe = art('NHK', 'CSファイナルステージ セ・リーグの第1戦はDeNAが完封勝ち');
const csPa = art('NHK', 'CSファイナルステージ パ・リーグの第1戦はソフトバンクが勝利');
const csYahoo = art('Yahoo!ニュース', 'DeNA好発進 CSで阪神に完封勝ち');
const saize2 = art('Impress Watch', 'サイゼリヤ値上げ　ミラノ風ドリアは320円に');
const saize3 = art('朝日新聞', 'サイゼリヤ、平均6%値上げへ　ミラノ風ドリアは320円に：朝日新聞');
const unrelated = art('ITmedia', 'Apple、スマートホームハブを正式発表');
const old = art('NHK', 'ロシアが北海道新聞記者をスパイ容疑で拘束', '', 100);

// 実際の取得結果（約 350 件）に近い条件にするため、無関係な見出しで水増しする
// （2-gram の珍しさ＝IDF は記事の総数に左右されるため）
let seed = 1;
const rand = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
const filler = Array.from({ length: 300 }, (_, i) =>
  art(`メディア${i % 20}`, Array.from({ length: 20 }, () => String.fromCharCode(0x4e00 + Math.floor(rand() * 3000))).join('')));

const all = [spyNhk, spyBbc, spyToyo, csSe, csPa, csYahoo, saize2, saize3, unrelated, old, ...filler];
const topics = clusterArticles(all);
const topicOf = (a) => topics.find((t) => t.articleIds.includes(a.id));

test('別々のメディアが報じた同じ出来事はまとまる', () => {
  assert.equal(topicOf(spyNhk), topicOf(spyBbc));
  assert.equal(topicOf(spyNhk), topicOf(spyToyo));
  assert.deepEqual(topicOf(spyNhk).sources.sort(), ['BBCニュース', 'NHK', '東洋経済オンライン'].sort());
  assert.equal(topicOf(saize2), topicOf(saize3));
});

test('同じメディアの「似た型の別の記事」はまとめない', () => {
  assert.notEqual(topicOf(csSe), topicOf(csPa));
  assert.equal(topicOf(csSe), topicOf(csYahoo));
});

test('関係ない記事や時間が離れた記事はまとめない', () => {
  assert.equal(topicOf(unrelated), undefined);
  assert.notEqual(topicOf(old), topicOf(spyNhk));
});

test('normalizeTitle: 【速報】やサイト名の後付けを除く', () => {
  assert.equal(normalizeTitle('【速報】見出し | NHKニュース'), ' 見出し');
  assert.equal(normalizeTitle('見出し：朝日新聞'), '見出し');
  assert.equal(normalizeTitle('見出し - 日本経済新聞'), '見出し');
});
