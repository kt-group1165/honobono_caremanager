-- 049: スマホURL経由での支援経過 匿名削除を許可
--
-- 背景: /support/[token] 画面（スマホ用）から誤入力した支援経過を
--       本人が取り消せるようにするため、anon ロールでの DELETE を許可する。
--       既に anon_select_support / anon_insert_support は存在している（041）。

CREATE POLICY "anon_delete_support"
  ON kaigo_support_records
  FOR DELETE
  TO anon
  USING (true);
