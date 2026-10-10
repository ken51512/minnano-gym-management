# みんなのジム 経営管理アプリ

Next.js + TypeScript を利用した経営管理アプリです。Supabase Auth、RLS、既存の月次RPCをブラウザから利用し、GitHub Pagesへ静的配信できる構成です。

## 必要な環境

- Node.js 20 以上
- PostgreSQL（Prismaのスキーマ確認・将来の接続用）

## ローカル起動

```powershell
corepack pnpm@9.15.9 install --ignore-workspace --frozen-lockfile
if (-not (Test-Path .env.local)) { Copy-Item .env.example .env.local }
# Set only NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY locally.
pnpm db:generate
pnpm dev
```

ブラウザで http://localhost:3000 を開きます。Next.jsは`.env.local`をdev/build時に読み込みます。Prismaなど単独のNodeプロセスでは必要な環境変数をそのプロセスへ別途ロードしてください。値をコマンド引数やログへ出さないでください。

## 構成

- `src/app`: App Router、レイアウト、画面
- `src/lib/monthly-ui-client.ts`: Browser Clientによる認証済み月次読込・RPC呼出し
- `src/lib/supabase-browser.ts`: 公開Supabase URL/anon keyだけを使うBrowser Client
- `src/lib/roles.ts`: `ALBA_ADMIN` / `EARNES` と権限判定
- `src/lib/db.ts`: Prisma Clientの共有インスタンス
- `prisma/schema.prisma`: PostgreSQL向けのデータモデル
- `src/legacy-server-routes`: 静的export対象から退避した旧Route Handler（削除せず保管）

### データモデル

`User`、`MonthlyRecord`、`RevenueEntry`、`ExpenseEntry`、`ExpenseCategory`、`MembershipStats`、`MonthlyClosing`、`AuditLog` を定義しています。金額は税込の整数（円）で保持し、未入力は `null`、返金・取消は負数で表現できます。月次確定、監査ログ、ロールをDB構造に含めています。

## 品質確認

```powershell
pnpm typecheck
pnpm lint
pnpm build
```

Unit tests (Node.js 24):

```powershell
$tests = rg --files src -g '*test.ts' -g '*test.mjs'
node --experimental-strip-types --experimental-specifier-resolution=node --test $tests
```

## GitHub Pages（公開前）

`GITHUB_PAGES=true pnpm build` で、`/minnano-gym-management/` のサブパスを前提とする静的ファイルを `out/` に生成します。`.github/workflows/deploy-pages.yml` はmain更新時に同じURLへ配信する定義ですが、現時点では公開していません。

公開する前に、GitHubリポジトリのPages設定を有効化し、Repository Variables に次の公開値だけを設定してください。

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

`DATABASE_URL`、service role key、Secret key、DBパスワードはPagesにもブラウザにも設定しません。Supabase AuthのRedirect URLには、公開後の `https://ken51512.github.io/minnano-gym-management/auth/callback/` を追加してください。既存のlocalhost設定は削除しません。

## 現在の実装状態

- ダッシュボードと月次入力は表示用の未接続UIです。KPIは未取得を示す`—`、入力欄と保存操作はdisabledで、業務データは保存しません。
- Auth/DBの実接続、実ログイン、許可ユーザーの運用登録、DBへの確定・解除記録は未検証または未実装です。
- 月次純粋関数は`src/lib/monthly-core.ts`です。報酬対象会員数には入力対象月の前月末時点の値を渡し、未入力は`null`のまま扱います。
- 月次確定の実行ロールは `ALBA_ADMIN`、必須項目は入力済み売上・経費、前月末会員数、新規入会数、退会数です。`RevenueEntry` / `ExpenseEntry` の空集合は未入力、明細金額0は入力済み値として区別できます。`MembershipStats` の各値も `null` と0を区別します。サーバー側の確定・解除処理は `src/lib/monthly-service.ts` にあります。画面は未接続で、実DBでの動作確認はしていません。
- 会員統計の通常編集はEARNES、財務編集と確定解除はALBA_ADMINです。確定後の通常編集は禁止し、解除にはALBA_ADMINと理由が必要です。画面上の説明表示は実際のロール認可を代替しません。

秘密情報を含む`.env*`はGit管理対象外です。`.env.example`には変数名と空欄だけを記載し、実値は共有・ログ出力しないでください。


## UI preview status

The current eight-screen UI is a connection-independent preview. Its sessionRole is fixed to null; the management gate is a client-side placeholder and does not verify an authenticated session. Login, data loading, saving, and management operations are not implemented in this preview. This UI preview is a separate, ongoing workflow and is not claimed as a required first-phase deliverable.

## Supabase SQL preparation (not applied)

Apply local SQL in this order only after reviewing the target project's schema, grants, and RLS policies:

1. `supabase/migrations/20261005000000_schema_and_rls.sql`
2. `supabase/migrations/20261006000000_user_allowlist_self_read.sql`
3. `supabase/migrations/20261007000000_monthly_update_rpc.sql`
4. `supabase/migrations/20261008000000_monthly_finalize_unlock_rpc.sql`
5. `supabase/migrations/20261009000000_monthly_backend_health_rpc.sql` (for the health endpoint only)
6. `supabase/migrations/20261010000000_monthly_request_idempotency.sql` (required before enabling monthly writes)
7. `supabase/migrations/20261013000000_monthly_expense_named_items.sql` (adds recurring expense labels after reviewing the named-item policy)
8. `supabase/migrations/20261014000000_monthly_expense_item_name_history.sql` (adds effective-month name history and the ALBA-only rename RPC)
9. `supabase/migrations/20261015000000_monthly_expense_item_registration_amount.sql` (atomically adds a named item and its optional first-month amount)

The bootstrap uses `CREATE TABLE IF NOT EXISTS`; it does not alter existing table definitions or rows, but it does change RLS and grants on the eight protected tables. Existing tables must be checked against `prisma/schema.prisma` first; this SQL does not reconcile schema drift. It stops when it finds existing policies, broad grants, or forced RLS on the allowlist table instead of removing or replacing them. Review such findings manually before any application. The migration runner must be allowed to transfer the role helper function, the `MonthlyRequest` ledger, and the protected wrapper functions to the owner of `public."User"`. These files have not been applied to a remote database.

The monthly update RPC is prepared in `supabase/migrations/20261007000000_monthly_update_rpc.sql`; the finalize and unlock RPCs are in `supabase/migrations/20261008000000_monthly_finalize_unlock_rpc.sql`. Migration 6 adds an actor-scoped request ledger and wraps these same public function names/signatures with a mandatory `x-monthly-request-id` header. It renames and revokes client execution of the former implementations, then calls them only after the request ID, actor role, operation, period, and JSON payload have been claimed in the same PostgreSQL transaction. Replaying the same ID and payload returns the stored success outcome without repeating business writes; changing the operation, month, or payload under that actor's ID is rejected. Distinct IDs permit distinct identical-value entries. The ledger has RLS enabled and no client table grants. SQL is local and has not been applied or executed against PostgreSQL. Static SQL-contract tests are not database atomicity or concurrency tests.

Before applying locally to a Supabase project, compare every existing table with `prisma/schema.prisma`, review RLS policies and grants, and run the files in the order above. The migration role must be able to alter the role-helper owner; the SECURITY DEFINER RPC owner must have SELECT/INSERT/UPDATE/DELETE access and bypass RLS (for example, a BYPASSRLS migration role), or own all affected tables without FORCE ROW LEVEL SECURITY. Apply first to an isolated nonproduction project; these migrations have not been exercised against a database in this repository workflow. After application, verify the migration history, authenticated allowlist identity mapping, allowed and rejected role cases, transaction rollback on audit failure, and concurrent update/finalize/unlock behavior before accepting the integration. Migration 5 is additional health-check SQL and was not part of the earlier four-migration approval. The application runtime now routes all monthly writes through Supabase RPC; Prisma remains for schema/client tooling and is no longer imported by the runtime service path.

`GET /api/health` performs a verified Auth check, a caller-scoped allowlist read, and the read-only `monthly_backend_health()` RPC independently. The response contains only component states and fixed error codes; an unauthenticated caller does not trigger database or RPC probes. Migration 6 updates this health RPC to verify that the request ledger, private implementations, and guarded public wrappers are installed; the historical function names alone do not make the monthly write path ready.

## Password recovery (local)

The recovery flow uses Supabase Auth PKCE through the `@supabase/ssr` browser client. The code verifier is stored in the browser's SSR cookie storage, so the user must open the reset email in the same browser profile that requested it. The callback exchanges the one-time code server-side and immediately redirects to a fixed reset page; the app does not log the callback URL, code, email, or password. Avoid enabling request URL/query-string logging in any proxy placed in front of this local app.

For this machine's fixed local app, add the exact callback `http://127.0.0.1:3005/auth/callback` to Supabase Auth Redirect URLs. The owner has configured the broader local allowlist `http://127.0.0.1:3005/**`. Supabase's default Site URL and redirect allowlist are managed separately; changing them is outside this repository workflow. An expired or invalid link must be replaced with a newly requested email.
