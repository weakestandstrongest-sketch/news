// 記事ページの HTML から、有料記事・会員限定記事かを判定する
// 'paid'（有料記事） / 'members'（会員限定・登録が必要） / null（無料で読める・判定できない）
//
// サイトのメニューや広告にも「有料会員」などの文字は出てくるため、単純な文字検索はしない。
// 検索エンジン向けの構造化データ（isAccessibleForFree）と、配信元ごとに確認した目印だけを使う。

const SITE_RULES = [
  // 日本経済新聞：記事に鍵のバナーが出る
  { host: 'nikkei.com', access: 'members', test: /この記事は会員限定記事です|class="paid-banner-title"/ },
  // 朝日新聞：見出しの近くに「有料記事」の印（無料の記事には出ない）
  { host: 'asahi.com', access: 'paid', test: />有料記事</ },
  // 東洋経済：構造化データでも判定できるが、見出しの「有料会員限定」も見る
  { host: 'toyokeizai.net', access: 'paid', test: /article-heading__member[^"]*--paid-lock/ },
];

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function detectAccess(html, url) {
  const host = hostOf(url);
  for (const rule of SITE_RULES) {
    if ((host === rule.host || host.endsWith(`.${rule.host}`)) && rule.test.test(html)) return rule.access;
  }
  // schema.org の「無料で読めるか」（Google 向けに多くの配信元が付けている）
  if (/"isAccessibleForFree"\s*:\s*"?false"?/i.test(html)) return 'paid';
  return null;
}
