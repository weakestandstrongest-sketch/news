// 本のデータ取得先の確認用（一時的）
const urls = [
  'https://ndlsearch.ndl.go.jp/api/opensearch?ndc=336&cnt=5&from=2026-08',
  'https://ndlsearch.ndl.go.jp/api/opensearch?ndc=159&cnt=5&from=2026-08',
  'https://api.openbd.jp/v1/get?isbn=9784799131053',
  'https://www.googleapis.com/books/v1/volumes?q=subject:Business&langRestrict=ja&orderBy=newest&maxResults=5&printType=books',
  'https://ndlsearch.ndl.go.jp/thumbnail/9784799131053.jpg',
];
for (const u of urls) {
  try {
    const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PersonalNewsReader/1.0)' }, signal: AbortSignal.timeout(15000) });
    const t = r.headers.get('content-type') || '';
    const body = t.includes('image') ? `[image ${(await r.arrayBuffer()).byteLength} bytes]` : (await r.text()).slice(0, 1500).replace(/\s+/g, ' ');
    console.log(`PROBE ${r.status} ${u}\n${body}\n`);
  } catch (e) { console.log(`PROBE ERR ${u} ${e.message}`); }
}
