-- apps/kaigo-app/migrations/fix_bath_office_area_category.sql
-- 2026-09-01 監査是正: 訪問入浴 5 事業所の地域区分が全部「その他 / 単価 10.00」だった。
--
-- 【何が起きるか】
--   訪問入浴介護の人件費割合は 70% で訪問介護と同じ。同じ市区町村なら単価も同じになる。
--   なのに 5 事業所とも area_category='その他' / unit_price=10.00 のままで、
--   同一地域の訪問介護事業所は 11.05 / 10.42 等が入っている。
--   → 稼働させると **約 10% の過少請求**になる。
--   (offices.address は 5 事業所とも NULL だったため所在地は user に確認した)
--
-- 【所在地 (2026-09-01 user 確認) と根拠】
--   Ｈａｎａ訪問入浴花見川   千葉市      3級地 11.05  ← Ｈａｎａヘルパーステーション花見川
--   Ｈａｎａ訪問入浴         千葉市      3級地 11.05  ← 同上
--   リンクス訪問入浴茂原     茂原市      6級地 10.42  ← リンクスヘルパーステーション
--   リンクス訪問入浴         大網白里市  7級地 10.21  ← リンクスヘルパーステーション大網白里
--   ムツミ訪問入浴           市原市      5級地 10.70  ← 市原ムツミヘルパーステーション
--
--   単価は 10 × (1 + 上乗せ率 × 人件費割合70%) と一致することを確認済:
--     3級地 15% → 11.05 / 5級地 10% → 10.70 / 6級地 6% → 10.42 / 7級地 3% → 10.21
--
-- 【影響】
--   kaigo_bath_visit_records は現在 0 行なので**過去の請求は変わらない**。
--   稼働後の請求からこの単価が使われる。
--
-- ⚠ 名前の前方一致に注意: 「Ｈａｎａ訪問入浴」は「Ｈａｎａ訪問入浴花見川」の接頭辞、
--   「リンクス訪問入浴」は「リンクス訪問入浴茂原」の接頭辞。LIKE を使わず完全一致で更新する。

BEGIN;

DROP TABLE IF EXISTS _backup_offices_bath_area_20260901;
CREATE TABLE _backup_offices_bath_area_20260901 AS
  SELECT id, name, service_type, area_category, unit_price
    FROM offices WHERE service_type = '訪問入浴';

DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count FROM _backup_offices_bath_area_20260901;
  IF v_count <> 5 THEN
    RAISE EXCEPTION '訪問入浴の事業所が 5 件でなく % 件です。対象を確認してください', v_count;
  END IF;
  RAISE NOTICE '✓ バックアップ作成 (% 件)', v_count;
END $$;

UPDATE offices SET area_category = '3級地', unit_price = 11.05
 WHERE service_type = '訪問入浴' AND name = 'Ｈａｎａ訪問入浴花見川';
UPDATE offices SET area_category = '3級地', unit_price = 11.05
 WHERE service_type = '訪問入浴' AND name = 'Ｈａｎａ訪問入浴';
UPDATE offices SET area_category = '6級地', unit_price = 10.42
 WHERE service_type = '訪問入浴' AND name = 'リンクス訪問入浴茂原';
UPDATE offices SET area_category = '7級地', unit_price = 10.21
 WHERE service_type = '訪問入浴' AND name = 'リンクス訪問入浴';
UPDATE offices SET area_category = '5級地', unit_price = 10.70
 WHERE service_type = '訪問入浴' AND name = 'ムツミ訪問入浴';

DO $$
DECLARE r RECORD; v_bad INT := 0;
BEGIN
  RAISE NOTICE '── 適用後 ──';
  FOR r IN
    SELECT name, area_category, unit_price FROM offices
     WHERE service_type = '訪問入浴' ORDER BY name
  LOOP
    RAISE NOTICE '  % : % / %', r.name, r.area_category, r.unit_price;
    IF r.area_category = 'その他' OR r.unit_price = 10.00 THEN
      v_bad := v_bad + 1;
    END IF;
  END LOOP;
  IF v_bad > 0 THEN
    RAISE EXCEPTION '検証失敗: % 件が「その他 / 10.00」のままです (名前の不一致?)', v_bad;
  END IF;
  RAISE NOTICE '✓ 訪問入浴 5 事業所の地域区分を設定しました';
END $$;

COMMIT;

-- ロールバック:
--   UPDATE offices o SET area_category = b.area_category, unit_price = b.unit_price
--     FROM _backup_offices_bath_area_20260901 b WHERE b.id = o.id;
