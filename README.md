# My News

広告のない、自分のためのニュースリーダーです。iPhone の Safari で動く Web アプリ（PWA）で、ホーム画面に追加すればアプリのように使えます。

SmartNews・NewsPicks・日経電子版を参考に、**落ち着いて読めること**と**迷わない操作**を大事にしています。

| 参考にしたところ | 取り入れたもの |
| --- | --- |
| 日経電子版 | 明朝体の見出し、紙のような背景色、トップ面に「各カテゴリの主なニュース」 |
| SmartNews | 上部のカテゴリタブ、左右スワイプでカテゴリ切り替え |
| NewsPicks | 記事の保存とメモ（ピック）、「話題」タブでの注目度（はてなブックマーク数）表示 |

## 主な機能

- カテゴリ：トップ / 経済 / テクノロジー / 話題 / 国内 / 政治 / 国際 / 科学 / スポーツ / エンタメ
- 左右スワイプ・タブでカテゴリ移動、下に引っ張って更新
- 記事をタップすると概要を表示 →「続きを読む」で配信元サイトへ
- 保存（しおり）とメモ、保存した記事の一覧
- 見出し・概要のキーワード検索
- 既読の記事は見出しを薄く表示
- 設定：文字の大きさ（4 段階）、テーマ（自動 / ライト / ダーク）、画像の表示切り替え、カテゴリの表示切り替え
- オフラインでも前回取得したニュースを表示

保存した記事・メモ・設定は端末のブラウザ内（localStorage）にだけ保存され、外部には送信されません。

## しくみ

```
GitHub Actions（30 分ごと）
  └─ scripts/fetch-news.mjs が feeds.json の RSS を取得
       └─ public/data/news.json を生成
            └─ GitHub Pages で public/ を公開 → iPhone のブラウザで表示
```

サーバーを用意する必要はなく、GitHub の無料枠だけで動きます。ブラウザから直接 RSS を読むと CORS で弾かれるため、取得は GitHub Actions 側で行っています。

## 公開の手順

1. このブランチの内容を `main` ブランチに入れ、`main` をデフォルトブランチにする（ワークフローは `main` への push と定期実行で動きます）
2. GitHub のリポジトリで **Settings → Pages → Build and deployment → Source** を **GitHub Actions** にする
3. **Actions → 「ニュースを取得して公開」→ Run workflow** で初回を実行
4. iPhone の Safari で `https://<ユーザー名>.github.io/<リポジトリ名>/` を開く
5. 共有ボタン →「ホーム画面に追加」

> 無料プランの GitHub Pages は公開リポジトリでのみ使えます。また、公開リポジトリで 60 日間 push がないと定期実行が自動停止するので、その場合は Actions 画面から再開してください。

各フィードの取得結果は Actions のログに `✓` / `✗` で表示されます。

## ニュースの取得元を変える

`feeds.json` を編集します。

```json
{
  "id": "tech",
  "label": "テクノロジー",
  "feeds": [
    { "source": "ITmedia", "url": "https://rss.itmedia.co.jp/rss/2.0/news_bursts.xml" }
  ]
}
```

- RSS 2.0 / RSS 1.0（RDF）/ Atom に対応しています
- `"sort": "score"` を付けると、はてなブックマーク数の多い順に並びます
- RSS に画像や概要がない記事は、記事ページの OGP（og:image / og:description）から補います
- 一部のフィードが取得できなくても、残りのフィードで公開を続けます

## 手元で動かす

Node.js 20 以上が必要です（外部パッケージは使っていません）。

```sh
npm run fetch   # RSS を取得して public/data/news.json を作る
npm run serve   # http://localhost:8080 で表示
npm test        # RSS パーサーのテスト
```

リポジトリに入っている `public/data/news.json` は表示確認用のサンプルです。公開時は GitHub Actions が最新のニュースで置き換えます。

## ファイル構成

```
public/            公開されるアプリ本体
  index.html
  styles.css       デザイン（色・文字の大きさはファイル冒頭の変数で調整できます）
  app.js
  sw.js            オフライン対応
  data/news.json   ニュースデータ（自動生成）
scripts/
  fetch-news.mjs   RSS 取得・整形
  lib/feed-parser.mjs
feeds.json         取得するフィードの一覧
.github/workflows/deploy.yml
```

記事の著作権は各配信元に帰属します。このアプリは RSS で公開されている見出しと概要だけを表示し、本文は配信元のサイトで読む形にしています。
