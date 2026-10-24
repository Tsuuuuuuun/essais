# Cloudflare へのデプロイ

生成された `_site/` を、Cloudflare Workers の Static Assets に直接アップロードして公開します。
ビルドはローカルで行うため、Cloudflare 側でのビルドステップは不要です。

## 事前準備

Cloudflare の API トークンとアカウント ID が必要です。

- **API トークン**：「Workers スクリプト:編集」権限を付与して作成します。
- **アカウント ID**：Cloudflare ダッシュボードの Workers & Pages 画面右側に表示されています。

これらは環境変数、またはリポジトリ直下の `.env` に設定します。
`.env` は `.gitignore` に含まれているため、リポジトリにはコミットされません。
両方に設定されている場合は、環境変数の値が優先されます。

```sh
cp .env.example .env   # コピーして値を設定
```

## デプロイ手順

```sh
pnpm run deploy
```

執筆画面（`pnpm write`）の右上の矢印のアイコンからも、同じ処理を実行できます。
公開される原稿と下書きの数を確かめてから、開いている原稿を保存して公開します。結果は画面の下端に、詳しい出力は `pnpm write` のターミナルに出ます。

下書き（front matter が `draft: true`）の原稿は、ビルドの段階で除かれるため公開されません。
ビルドは `_site/` を空にしてから書き出すため、消した原稿や下書きに戻した原稿の頁は残りません。

`_site/` をビルド後、`essais` という名前の Worker にアップロードします。
pnpm には同名の標準コマンド `pnpm deploy` が存在するため、`run` を明示して実行します。

変更のあったファイルのみを差分アップロードします。
アップロードの後に、原稿の写しを R2 に取ります（[docs/backup.md](backup.md)）。

公開 URL（独自ドメインや `workers.dev`）は、ダッシュボードの Worker → Settings → Domains & Routes から設定します。
一度設定すれば、再デプロイ後も設定は保持されます。

## ドライラン（事前確認）

```sh
node scripts/deploy.mjs --dry-run
```

アップロード対象のファイル一覧を表示して終了します。
Cloudflare との通信は行わないため、API トークンが未設定でも実行可能です。
（事前に `pnpm build` でファイルを生成しておく必要があります）

## Worker 名の変更

```sh
ESSAIS_WORKER_NAME=essais-test pnpm run deploy
```

検証環境など、本番とは別の Worker にデプロイしたい場合に使用します。
`.env` 内で指定することも可能です。

既存の同名 Worker がこのスクリプト以外で作成されたものである場合、誤上書きを防ぐため処理を中断します。
上書きを許可する場合は `--force` を付与してください。

```sh
node scripts/deploy.mjs --force
```

## サイトの動作仕様

- `/posts/yomu` のように末尾スラッシュのない URL は、`/posts/yomu/` へリダイレクト（正規化）されます。
- 該当するファイルが存在しない URL にアクセスした場合は、`404.html`（`src/404.njk` から生成）を返します。
