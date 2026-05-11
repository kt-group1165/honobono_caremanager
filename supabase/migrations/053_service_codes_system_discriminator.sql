-- ===========================================================================
-- 053: kaigo_service_codes に system 区分を追加 (介護保険 / 障害福祉 の判別)
-- ===========================================================================
-- 目的:
--   同一の service_category prefix (例: '11') が
--     介護保険では「訪問介護」
--     障害福祉では「居宅介護」
--   を意味するため、両制度のサービスコードを同一テーブルに同居させるには
--   system カラム ('介護' | '障害') による discriminator が必要。
--
-- 変更:
--   1. system カラム追加 (NOT NULL DEFAULT '介護' CHECK ('介護', '障害'))
--   2. 既存 UNIQUE (service_code, valid_from) を DROP
--   3. UNIQUE (system, service_code, valid_from) で再作成
--   4. 検索用 index に system を含めた version も追加
--
-- ロールバック:
--   ALTER TABLE kaigo_service_codes DROP CONSTRAINT kaigo_service_codes_system_service_code_valid_from_key;
--   ALTER TABLE kaigo_service_codes
--     ADD CONSTRAINT kaigo_service_codes_service_code_valid_from_key
--     UNIQUE (service_code, valid_from);
--   ALTER TABLE kaigo_service_codes DROP COLUMN system;
-- ===========================================================================

BEGIN;

-- ── 1. system カラム追加 ─────────────────────────────────────────────────
ALTER TABLE kaigo_service_codes
  ADD COLUMN IF NOT EXISTS system TEXT NOT NULL DEFAULT '介護'
    CHECK (system IN ('介護', '障害', '総合事業'));

COMMENT ON COLUMN kaigo_service_codes.system IS
  '制度区分: 介護=介護保険サービス / 障害=障害福祉サービス / 総合事業=介護予防・日常生活支援総合事業';

-- ── 2. UNIQUE 制約を (system, service_code, valid_from) に差し替え ─────
ALTER TABLE kaigo_service_codes
  DROP CONSTRAINT IF EXISTS kaigo_service_codes_service_code_valid_from_key;

ALTER TABLE kaigo_service_codes
  ADD CONSTRAINT kaigo_service_codes_system_service_code_valid_from_key
  UNIQUE (system, service_code, valid_from);

-- ── 3. 検索用 index (system + service_code + 有効期間 lookup) ─────────
CREATE INDEX IF NOT EXISTS idx_kaigo_service_codes_system_validity
  ON kaigo_service_codes(system, service_code, valid_from, valid_until);

-- ── 4. system 単独 index (system='障害' だけを横断検索する用) ───────
CREATE INDEX IF NOT EXISTS idx_kaigo_service_codes_system
  ON kaigo_service_codes(system);

COMMIT;

-- ===========================================================================
-- 確認クエリ (commit 後に実行):
-- ===========================================================================
-- 1) system 列の存在 + check 制約
--   SELECT column_name, data_type, column_default, is_nullable
--   FROM information_schema.columns
--   WHERE table_name = 'kaigo_service_codes' AND column_name = 'system';
--
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conrelid = 'kaigo_service_codes'::regclass
--     AND contype IN ('u', 'p', 'c');
--
-- 2) 既存行は全て system='介護' になっているはず
--   SELECT system, COUNT(*) FROM kaigo_service_codes GROUP BY system;
--   -- 期待: 介護=N, 障害=0, 総合事業=0
--
-- 3) サンプル: 介護 11=訪問介護 と 障害 11=居宅介護 を共存させる
--   INSERT INTO kaigo_service_codes (system, service_category, service_category_name,
--     service_code, service_name, units, unit_type, calculation_type, valid_from)
--   VALUES ('障害', '11', '居宅介護', '111111', '居宅介護(身体)1.0', 255, '1回につき', '基本', '2024-04-01');
--   -- 介護側に 111111 訪問介護 (身体介護１) が既存でも、system 違いで insert 可能
