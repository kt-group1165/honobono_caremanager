-- ============================================================
-- 文例データベース (bunrei_master)
-- 2026-07-12
-- ============================================================
-- 目的:
--   ケアマネ帳票の自由記述欄 (ケアプラン第1表/第2表・モニタリング・
--   支援経過・アセスメント) にワンクリック挿入できる「文例」の master。
--   ほのぼのの文例DB (約3,000件) 相当の仕組み。
--
-- 位置づけ:
--   - 文例 = フィールド単位の短文 (この table)
--   - テンプレ = 記録全体の雛形 (既存 kaigo_record_templates / master/record-templates)
--   と役割を分ける。重複しない。
--
-- 運用:
--   - is_builtin = true  … seed_bunrei.mjs で投入する初期文例 (一括削除の目印)
--   - is_builtin = false … 現場で「この内容を文例に保存」した自前蓄積
--   - usage_count は挿入のたびに bunrei_increment_usage() で +1
--     (人気順ソートに使う)
--
-- RLS:
--   - 他 kaigo_* master と同じ pattern (= authenticated 全許可)
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS bunrei_master (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   TEXT NOT NULL,
  category    TEXT NOT NULL,        -- 下記 CHECK の enum 的 TEXT
  care_level  TEXT,                 -- 任意: 要支援1/要支援2/要介護1〜5 (NULL = 共通)
  text        TEXT NOT NULL,        -- 文例本文
  usage_count INTEGER NOT NULL DEFAULT 0,
  is_builtin  BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bunrei_master_category_check CHECK (category IN (
    '計画1-意向',          -- 第1表: 利用者及び家族の生活に対する意向
    '計画1-方針',          -- 第1表: 総合的な援助の方針
    '計画2-課題',          -- 第2表: 生活全般の解決すべき課題 (ニーズ)
    '計画2-長期目標',      -- 第2表: 長期目標
    '計画2-短期目標',      -- 第2表: 短期目標
    '計画2-サービス内容',  -- 第2表: サービス内容
    'モニタリング',        -- モニタリング記録 (総合所見・評価など)
    '支援経過',            -- 支援経過記録 (第5表)
    'アセスメント'         -- アセスメントまとめ・特記事項
  )),
  CONSTRAINT bunrei_master_care_level_check CHECK (
    care_level IS NULL OR care_level IN (
      '要支援1', '要支援2',
      '要介護1', '要介護2', '要介護3', '要介護4', '要介護5'
    )
  ),
  CONSTRAINT bunrei_master_text_not_blank CHECK (btrim(text) <> '')
);

-- 同一 tenant × category 内での完全重複を防ぐ (「文例に保存」の二度押し対策)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_bunrei_master_tenant_category_text
  ON bunrei_master (tenant_id, category, md5(text));

-- picker の主クエリ: tenant + category で絞って usage_count 降順
CREATE INDEX IF NOT EXISTS idx_bunrei_master_tenant_category_usage
  ON bunrei_master (tenant_id, category, usage_count DESC);

COMMENT ON TABLE bunrei_master IS
  '文例データベース。帳票の自由記述欄に挿入する短文 master。is_builtin=true は seed 由来。';
COMMENT ON COLUMN bunrei_master.category IS
  '挿入先フィールド種別 (計画1-意向 / 計画1-方針 / 計画2-課題 / 計画2-長期目標 / 計画2-短期目標 / 計画2-サービス内容 / モニタリング / 支援経過 / アセスメント)';
COMMENT ON COLUMN bunrei_master.care_level IS
  '要介護度での絞込 (NULL = 全介護度共通)';

-- usage_count インクリメント (read-modify-write の競合を避ける)
CREATE OR REPLACE FUNCTION bunrei_increment_usage(p_id UUID)
RETURNS void AS $$
  UPDATE bunrei_master SET usage_count = usage_count + 1 WHERE id = p_id;
$$ LANGUAGE sql SECURITY DEFINER;

REVOKE ALL ON FUNCTION bunrei_increment_usage(UUID) FROM public;
GRANT EXECUTE ON FUNCTION bunrei_increment_usage(UUID) TO authenticated;

-- RLS
ALTER TABLE bunrei_master ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bunrei_master_auth ON bunrei_master;
CREATE POLICY bunrei_master_auth
  ON bunrei_master FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

COMMIT;
