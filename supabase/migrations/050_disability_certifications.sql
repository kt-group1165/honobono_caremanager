-- 050: 障害福祉サービス受給者証
-- 利用者管理画面の「障害」タブ用 — 受給者証・支給量・利用者負担割合・事業者記入欄を保持

CREATE TABLE IF NOT EXISTS kaigo_disability_certifications (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES kaigo_users(id) ON DELETE CASCADE,

  -- ─── 受給者証 ─────────────────────────────────────────────────────────────
  recipient_number TEXT,                        -- 受給者証番号
  issue_date DATE,                              -- 交付年月日
  municipality_code TEXT,                       -- 支給市町村コード
  municipality_name TEXT,                       -- 支給市町村名
  period_start DATE,                            -- 期間開始
  period_end DATE,                              -- 期間終了
  is_applying BOOLEAN DEFAULT FALSE,            -- 申請中
  support_level INTEGER,                        -- 障害支援区分（1-6, NULL=未設定）
  is_deafblind BOOLEAN DEFAULT FALSE,           -- 盲ろう者
  is_severely_disabled BOOLEAN DEFAULT FALSE,   -- 著しく重度の者
  is_post_h30_apr BOOLEAN DEFAULT FALSE,        -- H30/4以降支給決定
  is_short_multiple_visit BOOLEAN DEFAULT FALSE,-- 短時間複数訪問
  is_special_area BOOLEAN DEFAULT FALSE,        -- 特別地域加算

  -- ─── 支給量 ───────────────────────────────────────────────────────────────
  -- 時間/分の組（時間 0-, 分 0-59）
  body_care_hours INTEGER DEFAULT 0,            -- 身体介護中心
  body_care_minutes INTEGER DEFAULT 0,
  transfer_assist_count INTEGER DEFAULT 0,      -- 乗降介助中心（回）
  housework_hours INTEGER DEFAULT 0,            -- 家事援助中心
  housework_minutes INTEGER DEFAULT 0,
  hospital_escort_hours INTEGER DEFAULT 0,      -- 通院介助中心
  hospital_escort_minutes INTEGER DEFAULT 0,
  hospital_escort_with_body_hours INTEGER DEFAULT 0,   -- 通院介助(身体あり)
  hospital_escort_with_body_minutes INTEGER DEFAULT 0,
  accompany_hours INTEGER DEFAULT 0,            -- 同行援護中心
  accompany_minutes INTEGER DEFAULT 0,
  accompany_with_body_hours INTEGER DEFAULT 0,  -- 同行援護(身体あり)
  accompany_with_body_minutes INTEGER DEFAULT 0,
  behavior_support_hours INTEGER DEFAULT 0,     -- 行動援護中心
  behavior_support_minutes INTEGER DEFAULT 0,
  severe_inclusive_units INTEGER DEFAULT 0,     -- 重度包括中心（単位）
  severe_visit_inclusive_hours INTEGER DEFAULT 0,   -- 重度訪問介護包括支援
  severe_visit_inclusive_minutes INTEGER DEFAULT 0,
  severe_visit_lv6_hours INTEGER DEFAULT 0,     -- 重度訪問介護区分6該当
  severe_visit_lv6_minutes INTEGER DEFAULT 0,
  severe_visit_other_hours INTEGER DEFAULT 0,   -- 重度訪問介護その他
  severe_visit_other_minutes INTEGER DEFAULT 0,

  -- ─── 利用者負担割合 ───────────────────────────────────────────────────────
  burden_rate INTEGER DEFAULT 10,               -- 利用者負担割合（%）
  income_category TEXT,                         -- 所得区分
  monthly_burden_cap INTEGER DEFAULT 0,         -- 利用者負担上限月額（円）
  is_swc_exemption BOOLEAN DEFAULT FALSE,       -- 社会福祉法人減免
  is_cap_reach_expected BOOLEAN DEFAULT FALSE,  -- 上限額到達見込
  monthly_burden_cap_reduced INTEGER DEFAULT 0, -- 利用者負担軽減後上限月額（円）
  is_household_cap_management BOOLEAN DEFAULT FALSE, -- 同一世帯の複数利用者で上限管理
  cap_management_office TEXT,                   -- 上限額管理事業所
  municipality_amount INTEGER DEFAULT 0,        -- 市町村が定める額（円）

  -- ─── 事業者記入欄（6スロット） ────────────────────────────────────────────
  -- 形式: [{ slot: 1, business_no: '...', business_name: '...', note: '...' }, ...]
  business_entries JSONB DEFAULT '[]'::jsonb,
  reserve1 TEXT,                                -- 予備1
  reserve2 TEXT,                                -- 予備2
  reserve3 TEXT,                                -- 予備3

  memo TEXT,
  status TEXT DEFAULT 'active',                 -- active | expired | pending

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_disability_cert_user ON kaigo_disability_certifications(user_id);
CREATE INDEX IF NOT EXISTS idx_disability_cert_period ON kaigo_disability_certifications(period_start, period_end);

ALTER TABLE kaigo_disability_certifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_all" ON kaigo_disability_certifications FOR ALL TO authenticated USING (true) WITH CHECK (true);
