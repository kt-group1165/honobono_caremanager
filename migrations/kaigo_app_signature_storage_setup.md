# 電子署名 Storage セットアップ手順

電子署名 PNG 保存機能 v1 で利用する Supabase Storage の設定手順。
DB migration (`kaigo_app_signature_columns.sql`) と合わせて apply する。

## 1. bucket 作成

Supabase Studio → Storage → "New bucket"

| 項目 | 値 |
| --- | --- |
| Name | `signatures` |
| Public bucket | OFF (private) |
| File size limit | 1 MB (推奨) |
| Allowed MIME types | `image/png` |

## 2. Storage RLS policy

Storage → `signatures` → Policies で以下を作成。

### 2-1. SELECT (authenticated のみ)

```sql
CREATE POLICY "authenticated_read_signatures"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'signatures');
```

### 2-2. INSERT (authenticated のみ)

```sql
CREATE POLICY "authenticated_insert_signatures"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'signatures');
```

### 2-3. UPDATE (authenticated のみ — 再署名対応)

```sql
CREATE POLICY "authenticated_update_signatures"
ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'signatures')
WITH CHECK (bucket_id = 'signatures');
```

> anon role には SELECT/INSERT/UPDATE 全て付与しない。Supabase Studio では UI で
> "Allowed roles" を `authenticated` のみに絞る or 上記 SQL を直接 SQL Editor で実行。
> SQL Editor で実行する場合は `BEGIN;` を外す (Editor は auto-rollback する罠あり)。

## 3. file path 命名規則

```
{tenant_id}/{record_table}/{record_id}.png
```

例:

- `kt-group/kaigo_visit_records/3f5a8b2c-...uuid....png`
- `kt-group/kaigo_support_records/9d1e7c4f-...uuid....png`

`tenant_id` は `lib/tenant-resolver.ts` の `resolvePreferredTenantId()` 戻り値を使用。
`record_table` は table 名そのまま。`record_id` は record の UUID。

## 4. 法定保存年数の考慮

介護記録は最低 5 年保管が一般的。bucket 削除や file path 設計を変更する際は、
- 既存 record の `signature_image_url` を破壊しない
- file 移動した場合は record table の `signature_image_url` を更新する

を厳守すること。

## 5. signed URL の有効期限

### v1 (deprecated)
UI で `createSignedUrl(path, 60 * 60 * 24 * 365)` (1 年) で発行し DB の `signature_image_url` に保存していた。
→ 1 年経過後 token 失効で `<img src>` が表示不可になる問題あり。

### v2 (現行)
- DB には `signature_image_path` (Storage path) のみ保存する。
- 表示時に `useSignedUrls(paths, "signatures", 3600)` (`src/lib/use-signed-url.ts`) で 1 時間期限の signed URL を動的発行する。
- 1 年経過しても何度でも再発行可能。
- v1 の `signature_image_url` は deprecated 扱いで残置。path 未 backfill の record は URL fallback で表示する (v1 の 1 年以内のみ動作)。
- backfill: `migrations/kaigo_app_signature_path_backfill.mjs` (DRY_RUN default true)。
