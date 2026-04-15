# 孤立データ防止ポリシー

## 基本方針
全ての外部キー(FK)制約は `ON DELETE CASCADE` を設定する。
親レコードを削除した場合、参照する子レコードも自動削除される。

## 新規テーブル作成時のルール

```sql
-- ✅ 推奨: CASCADE を明示
CREATE TABLE kaigo_new_table (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES kaigo_users(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES kaigo_parent(id) ON DELETE CASCADE,
  ...
);

-- ❌ 非推奨: CASCADE なし（将来孤立が発生）
CREATE TABLE kaigo_new_table (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES kaigo_users(id),  -- ← CASCADEなし
  ...
);
```

## 例外: ON DELETE SET NULL が適切なケース
- 職員(staff)参照で、職員退職後も記録を残したい場合
- その場合は staff_id を nullable にし、ON DELETE SET NULL

## 派生データの自動同期
画面表示時に元データ（source of truth）から上書き取得する方式を採用。
例: 緊急時シートの利用中サービスは、開くたびに第2表から再取得して上書き。

## 定期メンテナンス
必要に応じて以下のクエリで孤立データを検出・削除:

```sql
-- 例: 孤立ケアプランサービスの削除
DELETE FROM kaigo_care_plan_services
WHERE care_plan_id NOT IN (SELECT id FROM kaigo_care_plans);
```
