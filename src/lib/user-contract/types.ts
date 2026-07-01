/**
 * 重要事項説明書 / 契約書 管理 (= 居宅・訪問介護 両版共通) — 型定義
 *
 * 設計方針:
 *  - 利用者は共有マスタ clients を参照 (user_id)
 *  - content (JSONB) は section ごとの自由構造 (= 重要事項説明書 / 契約書 で内容違うため schema-less)
 *  - status は 'draft' / 'issued' / 'archived'
 *  - "use client" boundary を跨いで安全に import するため、ここは純粋な型 + 定数のみ
 *    (= memory: feedback_use_client_const_export.md)
 */

// 2026-06-29: user 確定で 1 値のみ運用に変更 (= 旧 4 値は削除)。
// 既存サンプル含め全 contracts を DELETE 後、CHECK 制約も 1 値に絞った
// (= migrations/applied_archive/user_contracts_v3_single_type.sql)。
export const CONTRACT_TYPES = ["契約書兼重要事項説明書"] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];

export const CONTRACT_STATUSES = ["draft", "issued", "archived"] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const CONTRACT_STATUS_LABELS: Record<ContractStatus, string> = {
  draft: "下書き",
  issued: "交付済",
  archived: "保管 (旧版)",
};

export const CONTRACT_STATUS_COLORS: Record<
  ContractStatus,
  { bg: string; text: string; border: string }
> = {
  draft: { bg: "bg-gray-100", text: "text-gray-700", border: "border-gray-200" },
  issued: { bg: "bg-blue-100", text: "text-blue-700", border: "border-blue-200" },
  archived: { bg: "bg-amber-100", text: "text-amber-700", border: "border-amber-200" },
};

export const CONTRACT_TYPE_COLORS: Record<
  ContractType,
  { bg: string; text: string; border: string }
> = {
  契約書兼重要事項説明書: { bg: "bg-rose-100", text: "text-rose-700", border: "border-rose-200" },
};

/**
 * 業務種別 (= business_type の選択肢)
 * NULL 許容で free text にもなり得るが、UI では select で出す。
 */
export const BUSINESS_TYPES = [
  "居宅介護支援",
  "訪問介護",
  "通所介護",
  "福祉用具",
  "その他",
] as const;
export type BusinessTypeLabel = (typeof BUSINESS_TYPES)[number];

/**
 * 契約書 content (JSONB) の取り扱える section keys (= UI form の整形用)
 *
 * 重要事項説明書 sections:
 *   company_name / company_address / company_phone / company_fax / representative
 *   service_types / operating_days / operating_hours
 *   fee_structure / payment_method / cancel_policy
 *   complaint_contact / complaint_phone / external_complaint_contact
 *   emergency_response
 *   privacy_handling
 *
 * 契約書 sections:
 *   contract_period_text / service_scope
 *   fee_text / payment_terms
 *   termination_conditions / damages_clause
 *   complaint_handling / confidentiality
 *
 * いずれも optional + 文字列フィールド。content は最終的に Record<string, string> 想定だが、
 * 将来拡張のため JSONB として保存する。
 */
export type UserContractContent = Record<string, string | undefined> & {
  _sample_marker?: string;
};

export interface UserContract {
  id: string;
  tenant_id: string;
  user_id: string;
  office_id: string | null;
  contract_type: ContractType;
  business_type: string | null;
  issued_date: string; // YYYY-MM-DD
  effective_from: string | null;
  effective_until: string | null;
  signed_at: string | null;
  signed_by_name: string | null;
  signed_by_relation: string | null;
  content: UserContractContent;
  attachment_url: string | null;
  status: ContractStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

/** INSERT / UPDATE 共用 (= id は UPDATE 時のみ必須、その他は省略可) */
export type UserContractInput = Omit<
  UserContract,
  "id" | "created_at" | "updated_at" | "created_by"
> & {
  id?: string;
};

/**
 * 重要事項説明書 / 契約書 の section 定義 (= UI form の section 順)
 *
 * key は content (JSONB) の field name と一致。
 * 入力欄の type: 'text' (1 行) / 'textarea' (複数行)
 */
export interface ContractSection {
  key: string;
  label: string;
  type: "text" | "textarea";
  placeholder?: string;
}

export const JUUYOU_JIKOU_SECTIONS: ContractSection[] = [
  { key: "company_name", label: "事業者の名称", type: "text", placeholder: "例: 株式会社KTグループ" },
  { key: "company_address", label: "所在地", type: "text", placeholder: "例: 千葉県千葉市..." },
  { key: "company_phone", label: "電話番号", type: "text", placeholder: "例: 043-000-0000" },
  { key: "company_fax", label: "FAX 番号", type: "text" },
  { key: "representative", label: "代表者", type: "text", placeholder: "代表取締役 ..." },
  { key: "service_types", label: "提供サービスの種類と内容", type: "textarea", placeholder: "例: 居宅介護支援、訪問介護" },
  { key: "operating_days", label: "営業日", type: "text", placeholder: "例: 月〜金 (祝日除く)" },
  { key: "operating_hours", label: "営業時間", type: "text", placeholder: "例: 9:00 - 18:00" },
  { key: "fee_structure", label: "利用料", type: "textarea", placeholder: "介護保険適用 / 自費料金 など" },
  { key: "payment_method", label: "支払方法", type: "textarea", placeholder: "口座振替 / 振込 等" },
  { key: "cancel_policy", label: "キャンセル料", type: "textarea" },
  { key: "complaint_contact", label: "苦情対応窓口 (担当者)", type: "text" },
  { key: "complaint_phone", label: "苦情受付 電話番号", type: "text" },
  { key: "external_complaint_contact", label: "外部苦情窓口 (市町村 / 国保連 等)", type: "textarea" },
  { key: "emergency_response", label: "緊急時の対応", type: "textarea" },
  { key: "privacy_handling", label: "個人情報の取扱", type: "textarea" },
];

export const KEIYAKUSHO_SECTIONS: ContractSection[] = [
  { key: "contract_period_text", label: "契約期間", type: "textarea", placeholder: "例: 契約日から1年間、以後自動更新" },
  { key: "service_scope", label: "サービス内容", type: "textarea" },
  { key: "fee_text", label: "利用料", type: "textarea" },
  { key: "payment_terms", label: "支払方法・時期", type: "textarea" },
  { key: "termination_conditions", label: "契約解除条件", type: "textarea" },
  { key: "damages_clause", label: "損害賠償", type: "textarea" },
  { key: "complaint_handling", label: "苦情処理", type: "textarea" },
  { key: "confidentiality", label: "秘密保持", type: "textarea" },
];

export const KOJIN_JOUHOU_SECTIONS: ContractSection[] = [
  { key: "purpose", label: "利用目的", type: "textarea", placeholder: "サービス提供・関係機関連携 など" },
  { key: "shared_with", label: "提供先", type: "textarea", placeholder: "主治医・サービス担当者会議 メンバー 等" },
  { key: "shared_items", label: "提供する情報の項目", type: "textarea" },
  { key: "consent_period", label: "同意の有効期間", type: "text" },
];

export const OTHER_SECTIONS: ContractSection[] = [
  { key: "summary", label: "概要", type: "textarea" },
  { key: "body", label: "本文", type: "textarea" },
];

/**
 * 「契約書兼重要事項説明書」(= 居宅介護支援用) sections
 *
 * docx (`apps/kaigo-app/契約書/居宅介護支援/26.6月 契約書原本(大網）.docx`) の構造に対応。
 *
 * 構成:
 *   - 事業者ヘッダ (company_*, representative_name)
 *   - 契約本文 前文 / 第1〜22条 (article_01 〜 article_22) / 末尾文
 *   - 個人情報取扱い同意条項 (privacy_consent_text)
 *   - 別紙重要事項 1〜8 章 (juyo_01 〜 juyo_08)
 *     - 各章は docx の小見出し単位に分割した複数 key を持つ (= 印刷で見出し付きで render)
 *   - 末尾署名欄の固定文 (= signature_*)
 *
 * 印刷プレビューでは docx の縦書き構造を踏襲。
 */
export const KEIYAKU_KEN_JUYO_SECTIONS: ContractSection[] = [
  // 事業者基本情報 (= 契約書冒頭・末尾の事業者欄)
  { key: "company_name", label: "事業者の名称 (法人名)", type: "text", placeholder: "例: 株式会社儀八" },
  { key: "company_office_name", label: "事業所名", type: "text", placeholder: "例: リンクス居宅介護支援事業所大網白里" },
  { key: "company_address", label: "事業所所在地", type: "text", placeholder: "例: 千葉県大網白里市細草1170" },
  { key: "company_phone", label: "電話番号", type: "text", placeholder: "例: 0475-86-6038" },
  { key: "company_emergency_phone", label: "緊急時連絡先 (担当者携帯)", type: "text", placeholder: "例: 080-9342-6539" },
  { key: "representative_name", label: "法人代表者氏名", type: "text", placeholder: "例: 代表取締役 手代木 正儀" },
  { key: "office_designation_number", label: "介護保険 指定事業所番号", type: "text", placeholder: "例: 1279200081" },
  { key: "office_service_area", label: "通常のサービス実施地域", type: "textarea", placeholder: "例: 大網白里市・東金市・..." },

  // 契約本文 前文 / 末尾
  { key: "preamble_text", label: "契約 前文", type: "textarea" },
  { key: "closing_text", label: "契約 末尾文 (証明・押印・保有)", type: "textarea" },

  // 第1〜22条
  { key: "article_01", label: "第1条 (契約の目的)", type: "textarea" },
  { key: "article_02", label: "第2条 (契約期間)", type: "textarea" },
  { key: "article_03", label: "第3条 (介護支援専門員)", type: "textarea" },
  { key: "article_04", label: "第4条 (居宅サービス計画作成の支援)", type: "textarea" },
  { key: "article_05", label: "第5条 (状況観察・再評価)", type: "textarea" },
  { key: "article_06", label: "第6条 (施設入所への支援)", type: "textarea" },
  { key: "article_07", label: "第7条 (居宅サービス計画の変更)", type: "textarea" },
  { key: "article_08", label: "第8条 (給付管理)", type: "textarea" },
  { key: "article_09", label: "第9条 (要介護認定等の申請に係る援助)", type: "textarea" },
  { key: "article_10", label: "第10条 (サービスの提供の記録)", type: "textarea" },
  { key: "article_11", label: "第11条 (料金)", type: "textarea" },
  { key: "article_12", label: "第12条 (契約の終了)", type: "textarea" },
  { key: "article_13", label: "第13条 (秘密保持)", type: "textarea" },
  { key: "article_14", label: "第14条 (賠償責任)", type: "textarea" },
  { key: "article_15", label: "第15条 (身分証携行義務)", type: "textarea" },
  { key: "article_16", label: "第16条 (相談・苦情対応)", type: "textarea" },
  { key: "article_17", label: "第17条 (善管注意義務)", type: "textarea" },
  { key: "article_18", label: "第18条 (利用者代理人)", type: "textarea" },
  { key: "article_19", label: "第19条 (天災等不可抗力)", type: "textarea" },
  { key: "article_20", label: "第20条 (災害等発生時のサービス提供)", type: "textarea" },
  { key: "article_21", label: "第21条 (本契約に定めない事項)", type: "textarea" },
  { key: "article_22", label: "第22条 (裁判管轄)", type: "textarea" },

  // 個人情報の取扱いについて
  { key: "privacy_consent_text", label: "【個人情報の取り扱いについて】", type: "textarea" },

  // 別紙重要事項 1: 相談窓口
  { key: "juyo_01_contact", label: "別紙1 当事業所が提供する居宅介護支援サービスについての相談窓口", type: "textarea" },

  // 別紙重要事項 2: 当事業所の概要 (本文 + 表 で構成)
  { key: "juyo_02_overview_intro", label: "別紙2 当事業所の概要 — 冒頭の項目箇条書き", type: "textarea" },
  { key: "juyo_02_staff_table_note", label: "別紙2 当事業所の概要 — 職員体制 補足", type: "textarea" },
  { key: "juyo_02_hours_note", label: "別紙2 当事業所の概要 — 営業日・営業時間 補足", type: "textarea" },

  // 別紙重要事項 3: 申し込みからサービス提供までの流れ
  { key: "juyo_03_flow", label: "別紙3 居宅介護支援の申し込みからサービス提供までの流れと主な内容", type: "textarea" },

  // 別紙重要事項 4: 利用料金 (小見出し別)
  { key: "juyo_04_fee_intro", label: "別紙4 利用料金 — 利用料 (法定代理受領の説明)", type: "textarea" },
  { key: "juyo_04_fee_table_note", label: "別紙4 利用料金 — 法定代理受領が出来なくなった場合の料金 表 補足", type: "textarea" },
  { key: "juyo_04_fee_shoguu", label: "別紙4 利用料金 — 介護職員等処遇改善加算", type: "textarea" },
  { key: "juyo_04_fee_transport", label: "別紙4 利用料金 — 交通費", type: "textarea" },
  { key: "juyo_04_fee_other", label: "別紙4 利用料金 — その他 (解約・代行申請・複写)", type: "textarea" },
  { key: "juyo_04_fee_payment", label: "別紙4 利用料金 — 支払方法", type: "textarea" },

  // 別紙重要事項 5: サービスの利用方法 (小見出し別)
  { key: "juyo_05_usage_start", label: "別紙5 サービスの利用方法 — サービスの利用開始", type: "textarea" },
  { key: "juyo_05_usage_end_user", label: "別紙5 サービスの利用方法 — お客様の都合での終了", type: "textarea" },
  { key: "juyo_05_usage_end_office", label: "別紙5 サービスの利用方法 — 当事業所の都合での終了", type: "textarea" },
  { key: "juyo_05_usage_auto_end", label: "別紙5 サービスの利用方法 — 自動終了", type: "textarea" },
  { key: "juyo_05_usage_other_end", label: "別紙5 サービスの利用方法 — その他 (背信行為等による解除)", type: "textarea" },

  // 別紙重要事項 6: 居宅介護支援の特徴等 (= docx の細目をそのまま展開)
  { key: "juyo_06_policy", label: "別紙6 特徴等 — 運営の方針", type: "textarea" },
  { key: "juyo_06_assessment", label: "別紙6 特徴等 — 課題分析票 (アセスメントツール)", type: "textarea" },
  { key: "juyo_06_explanation", label: "別紙6 特徴等 — 居宅サービス計画作成に係る説明・同意", type: "textarea" },
  { key: "juyo_06_usage_ratio", label: "別紙6 特徴等 — サービス利用割合", type: "textarea" },
  { key: "juyo_06_monitoring", label: "別紙6 特徴等 — モニタリング (オンライン要件)", type: "textarea" },
  { key: "juyo_06_carekaigi", label: "別紙6 特徴等 — 地域ケア会議への協力", type: "textarea" },
  { key: "juyo_06_jisshu", label: "別紙6 特徴等 — 新人介護支援専門員の実習協力", type: "textarea" },
  { key: "juyo_06_medical", label: "別紙6 特徴等 — 医療機関との連携", type: "textarea" },
  { key: "juyo_06_gyakutai", label: "別紙6 特徴等 — 虐待に関する措置", type: "textarea" },
  { key: "juyo_06_kansensho", label: "別紙6 特徴等 — 感染症の発生及びまん延の防止に関する措置", type: "textarea" },
  { key: "juyo_06_bcp", label: "別紙6 特徴等 — 非常時における業務継続に向けた取り組み", type: "textarea" },
  { key: "juyo_06_kosoku", label: "別紙6 特徴等 — 身体的拘束に関する措置", type: "textarea" },
  { key: "juyo_06_privacy", label: "別紙6 特徴等 — 個人情報の取扱いについて (秘密保持)", type: "textarea" },
  { key: "juyo_06_incident", label: "別紙6 特徴等 — 事故発生時の対応", type: "textarea" },
  { key: "juyo_06_other", label: "別紙6 特徴等 — その他の重要事項", type: "textarea" },

  // 別紙重要事項 7: 苦情・相談窓口 (小見出し別)
  { key: "juyo_07_complaint_intro", label: "別紙7 苦情・相談窓口 — 冒頭", type: "textarea" },
  { key: "juyo_07_complaint_service", label: "別紙7 苦情・相談窓口 — 居宅サービス計画に基づく各サービスについて", type: "textarea" },
  { key: "juyo_07_complaint_office", label: "別紙7 苦情・相談窓口 — 当社の居宅介護支援に関する相談・苦情", type: "textarea" },
  { key: "juyo_07_complaint_hq", label: "別紙7 苦情・相談窓口 — 本社 お客様サービス係", type: "textarea" },
  { key: "juyo_07_complaint_external", label: "別紙7 苦情・相談窓口 — 市区町村等 外部窓口", type: "textarea" },

  // 別紙重要事項 8: 当社の概要
  { key: "juyo_08_company", label: "別紙8 当社の概要", type: "textarea" },

  // 後方互換 (= 旧 1 key 版 の保存値が残っている場合の fallback)。新規入力では使わない。
  { key: "juyo_02_overview", label: "別紙2 当事業所の概要 (旧 1 key 版・後方互換)", type: "textarea" },
  { key: "juyo_04_fee", label: "別紙4 利用料金 (旧 1 key 版・後方互換)", type: "textarea" },
  { key: "juyo_05_usage", label: "別紙5 サービスの利用方法 (旧 1 key 版・後方互換)", type: "textarea" },
  { key: "juyo_06_features", label: "別紙6 特徴等 (旧 1 key 版・後方互換)", type: "textarea" },
  { key: "juyo_07_complaint", label: "別紙7 苦情・相談窓口 (旧 1 key 版・後方互換)", type: "textarea" },
];

/**
 * 「契約書兼重要事項説明書」のデフォルト本文 (= docx の固定文を section ごとに分割したもの)
 *
 * 新規発行時にこれを content にプリフィルすると、利用者は名称・住所等の事業者欄だけ
 * 書き換えれば実用に達する。
 *
 * 法令引用は docx 原文 (`apps/kaigo-app/契約書/居宅介護支援/26.6月 契約書原本(大網）.docx`)
 * を一字一句保持する。
 */
export function getKeiyakuKenJuyoDefaults(): UserContractContent {
  return {
    // 事業者欄 (company_name / company_office_name / address / phone 等) は defaults に埋めない。
    // page.tsx で contract.office_id → offices + companies を lookup して動的に埋める。
    // preamble_text も事業者名を含むため defaults では空にし、page.tsx で組み立てる。
    preamble_text: "",
    closing_text:
      "上記の契約を証するため本書２通を作成し、利用者・事業者が署名押印の上、１通ずつ保有するものとします。",

    // 条文 (= docx 原文を全角丸括弧・全角数字込みで保持)
    article_01:
      "事業者は、利用者からの委託を受けて、利用者に対し介護保険法令の趣旨に従い「居宅サービス計画」の作成を支援し、指定居宅サービス等の提供が確保されるよう、サービス提供事業者との連絡調整その他の便宜を図ります。",
    article_02:
      "本契約の契約期間は、令和　　　　年　　　　月　　　　日から利用者の要介護認定の有効期間満了日までとします。\n契約満了日までに、利用者から事業者に対して契約終了の申し出がない場合契約は自動更新されるものとします。",
    article_03:
      "事業者は、介護保険法に定める介護支援専門員を利用者へのサービス担当者として任命し、その選定または交代を行った場合は、その氏名を利用者に文書で通知します。",
    article_04:
      "事業者は、次の各項に定める事項を介護支援専門員に担当させ、「居宅サービス計画」の作成を支援します。\n① 利用者の居宅を訪問し、利用者及びその家族等に面接して情報を収集し解決すべき課題を把握します。\n② 当該地域における、指定居宅サービス事業者等に関するサービスの内容・利用料等の情報を、適切に利用者及びその家族に提供し、利用者にサービスの選択を求めます。\n③ 提供されるサービスの目標・その達成時期・サービスを提供する上での留意点等を盛り込んだ「居宅サービス計画」の原案を作成します。\n④ 「居宅サービス計画」の原案に位置付けた指定居宅サービス等について、保険給付の対象となるか否かを区分した上で、その種類・内容・利用料等について利用者及びその家族に説明し、利用者から文書による同意を受けます。\n⑤ 要介護認定の申請や要介護認定の更新があった場合において、サービス担当者会議の開催、担当者に対する照会等により、居宅サービス計画の内容について担当者から必要な意見を求めます。\n⑥ その他、「居宅サービス計画」作成に関する必要な支援を行います。",
    article_05:
      "事業者は「居宅サービス計画」作成後、次の各項に定める事項を介護支援専門員に担当させます。\n① 利用者及びその家族と毎月連絡をとり、サービス提供状況や経過の把握に努めます。\n② 「居宅サービス計画」の目標に沿ってサービスが提供されるよう、指定居宅サービス事業者等との連絡調整を行います。\n③ 利用者の状態について定期的に再評価を行い、状態の変化等に応じて「居宅サービス計画」変更の支援・要介護認定区分変更申請の支援等、必要な対応をします。",
    article_06:
      "事業者は、利用者が介護保険施設等への入院または入所を希望した場合、利用者に対し介護保険施設等の紹介、その他の必要な支援をします。",
    article_07:
      "利用者が「居宅サービス計画」の変更を希望した場合、または事業者が「居宅サービス計画」の変更が必要と判断した場合は、事業者と利用者双方の合意をもって「居宅サービス計画」を変更します。",
    article_08:
      "事業者は、「居宅サービス計画」作成後、その内容に基づき毎月給付管理票を作成し、千葉県国民健康保険団体連合会に提出します。",
    article_09:
      "① 事業者は、利用者が要介護認定等の更新申請、及び状態の変化に伴う区分変更の申請を円滑に行えるよう利用者を支援します。\n② 事業者は、利用者から依頼があった場合は要介護認定等の申請を利用者に代わって無料で行います。",
    article_10:
      "① 事業者は、指定居宅介護支援の提供に関する記録をつけることとし、これを本契約終了後5年間保管します。\n② 利用者は、事業者の営業時間内にその事業所にて、当該利用者に関する第１項のサービス実施記録を閲覧できます。\n③ 利用者は、当該利用者に関する第１項のサービス実施記録の複写物の交付を受けることができます。但し、記録の複写物にかかる費用については、「重要事項説明書」に定める料金を利用者が支払います。\n④ 第１２条第１項から第４項の規定により、利用者または事業者が解約を通知し、かつ、利用者が希望した場合、事業者は直近の「居宅サービス計画」及びその実施状況に関する書面を作成し、利用者に交付します。",
    article_11:
      "事業者が提供する居宅介護支援に対する料金規定は「重要事項説明書」の通りです。",
    article_12:
      "① 利用者は、事業者に文書または口頭で通知することにより、いつでも本契約を解除することができます。\n② 事業者は、介護支援専門員の休退職等による人員不足等、やむを得ない事情がある場合、利用者に対して１ヶ月間の予告期間をおいた上で理由を示した文書で通知をする事により、本契約を解除することができます。この場合、事業者は当該地域の他の指定居宅介護支援事業者に関する情報を利用者に提供するなど必要な措置を講じます。\n③ 事業者は、利用者やその家族等（内縁関係等の関係者を含む）、身元引受人及びその他の利用者の関係者等が、故意に法令違反その他著しく常識を逸脱する行為（乱暴な言動、暴力、怒鳴る、恐喝、物を投げつける、刃物を向ける、無理な要求や対象範囲外のサービスの強要、身体に理由なく触れる、卑猥な言動、ストーカー行為、その他、各種ハラスメントに該当するとみなされる行為等）及び、本契約を継続しがたい程の背信行為を事業者や介護支援専門員等の従業者に対して行った場合は、文書で通知することにより、直ちに本契約を解除することができます。\n④ 次の事由に該当した場合は、本契約は自動的に終了します。\n・利用者が介護保険施設等に入院・入所した場合\n・利用者の要介護認定区分が非該当（自立）または、要支援１・２と認定された場合\n・介護保険サービスの未利用期間が3ヶ月に及んだ場合。（医療機関等への入院を含む）\n・利用者が死亡した場合",
    article_13:
      "① 事業者は、当該居宅介護支援サービスの提供をする上で知り得た利用者及びその家族に関する個人情報を、介護サービスの提供に伴う連絡調整や利用者等の生命、身体に危険がある場合など必要な場合を除き、正当な理由なく第三者に漏らしません。この守秘義務は契約終了後も同様です。\n② 介護保険制度にて義務付けられているサービス担当者会議や利用する各介護・医療サービス等の利用調整等、居宅介護支援サービスを提供する上で必要と認められる場合においては、個人情報を引用できるものとします。この場合にも、使用する個人情報は必要最低限のものにとどめ、当該目的以外に個人情報を引用する事は決していたしません。",
    article_14:
      "① 事業者は、本契約に基づくサービスの実施に伴い、事業者の責に帰すべき事由により利用者の生命・身体・財産に損害を及ぼした場合は、その損害について賠償する責任を負います。\n② 事業者は、民間企業の提供する損害賠償責任保険に加入しております。上記規定の賠償に相当する可能性がある場合には、利用者またはその家族等は当該保険に係わる調査等の手続きに協力して頂きます。",
    article_15:
      "介護支援専門員は常に身分証を携行し、初回訪問時及び利用者・その家族等から提示を求められた時は、いつでも身分証を提示します。",
    article_16:
      "事業者は、利用者からの相談・苦情等に対応する窓口を設置し、自ら提供した居宅介護支援または「居宅サービス計画」に位置付けた指定居宅サービス等に関する利用者の要望・苦情等に対し迅速に対応します。",
    article_17:
      "事業者は、利用者より委託された業務を行うにあたっては、法令を遵守し善良なる管理者の注意をもってその業務を遂行します。",
    article_18:
      "① 利用者は、必要と認められる場合、代理人を選任して本契約を締結させることができ、契約に定める権利の行使と義務の履行を代理して行わせることができます。\n② 利用者の代理人選定に際して必要がある場合は、事業者は成年後見人制度や地域福祉権利擁護事業等の内容を説明するものとします。",
    article_19:
      "① 事業者は、自己の合理的な支配が及ばない事由（以下、「不可抗力」といいます）による、本契約に基づく業務の不履行または履行遅滞については責任を負わないものとします。\n② 不可抗力には、地震・豪雨・豪雪・暴風・洪水等の自然災害、戦争・内乱・暴動等の社会的大変動、法令の改廃・制定・通達・指導等の公権力の作用、その他、火災・交通障害・通信障害・電気・ガス・水道の障害等（これらに限定されるものではない）により、通常業務の遂行が困難な場合等とします。",
    article_20:
      "１　災害発生時や感染症流行時などの非常時においては、事業者は従業員の安全を確保した上でサービスを提供するため、事前に合意した日時・内容通りのサービスが提供できない可能性があります。\n２　利用者が避難所に避難された場合には、サービス提供の場所が変わることになりますので、道路状況・人員体制・避難所の環境等を考慮した上で、サービスの提供が可能と事業者が判断した場合にのみサービスを提供するものとします。",
    article_21:
      "① 利用者と事業者は、信義誠実をもって本契約を履行するものとします。\n② 本契約に定めのない事項については、介護保険法令その他諸法令の定めるところを遵守し、双方が誠意をもって協議の上定めます。",
    article_22:
      "利用者と事業者は、本契約に関してやむを得ず訴訟となる場合は、利用者の住所地を管轄する裁判所を第一管轄裁判所とすることについて予め合意します。",

    privacy_consent_text:
      "利用者は、介護保険制度にて義務付けられているサービス担当者会議や利用する各介護・医療サービス等の利用調整等、居宅介護支援サービスを提供する上で必要と認められる場合において事業所が利用者及び家族の個人情報を用いることについて予め同意します。",

    // ===== 別紙１: 相談窓口 =====
    juyo_01_contact:
      "　電話　　０４７５－８６－６０３８（午前９：００～午後６：００）\n　担当　　介護支援専門員　　○○　○○",

    // ===== 別紙２: 当事業所の概要 =====
    juyo_02_overview_intro:
      "・居宅介護支援事業所の名称、所在地、指定番号、サービスを提供できる地域\n・当事業所の職員体制\n・営業日及び営業時間",
    juyo_02_staff_table_note:
      "管理者 兼 主任介護支援専門員: 常勤１名／非常勤０名 (計 １名)\n主任介護支援専門員: 常勤１名／非常勤０名 (計 １名)\n介護支援専門員: 常勤２名／非常勤０名 (計 ２名)\n事務職員: 常勤１名／非常勤０名 (計 １名)",
    juyo_02_hours_note:
      "営業日:\n月曜日から金曜日です。\n但し、祝日・８月１３日～８月１５日及び１２月３０日～１月３日までにつきましては、その曜日に関わらず年間の休日となります。\n\n営業時間:\n午前９時から午後６時です。\n但し、転送電話等により24時間365日の連絡体制を確保し、かつ必要に応じて利用者様等からの相談に対応 及び 必要と認められる居宅介護支援サービスを行うことができる体制を確保しています。\n※営業日及び営業時間外の連絡につきましては、管理者の会社所有の携帯電話（080-9342-6539）までご連絡いただければ、担当の介護支援専門員に連絡がとれる体制を確保しています。",

    // ===== 別紙３: 申し込みからサービス提供までの流れ =====
    juyo_03_flow:
      "① 居宅介護支援サービス利用申し込みの受付\n② 利用者及びその家族等からニーズ等の聞き取り・各制度等の説明・アセスメント（課題分析）\n③ 地域のサービス情報の提供と利用者によるサービスの選択\n④ 「居宅サービス計画」原案の作成及び支給限度額確認・利用者負担額計算\n⑤ 各居宅サービス事業者等とのサービス調整\n⑥ サービス担当者会議の開催\n⑦ 利用者及びその家族等への説明と同意の確認\n⑧ サービス利用票・サービス提供票の作成\n⑨ 利用者へサービス提供",

    // ===== 別紙４: 利用料金 (小見出し別) =====
    juyo_04_fee_intro:
      "要介護認定を受けられた方は、介護保険制度から全額給付（法定代理受領）されるので自己負担はありません。\n但し、保険料の滞納等により法定代理受領ができなくなった場合は、１ヶ月につき要介護度に応じて下記の金額をお支払い頂き、当社からサービス提供証明書を発行いたします。この証明書を各市町村(特別区)の窓口に提出しますと、全額払い戻しを受けることができます。",
    juyo_04_fee_table_note:
      "※　保険料の滞納等により、法定代理受領ができなくなった場合の料金 (居宅介護支援費 特定事業所加算Ⅱ)\n　要介護１・２　　　１５，３８６円／月\n　要介護３～５　　　１８，７０４円／月\n\n■その他加算\n　初回加算　　　　　　　　　　　　　　　　　　　　 ３，０６３円\n　入院時情報連携加算（Ⅰ）　　　　　　　　　 ２，５５２円\n　入院時情報連携加算（Ⅱ）　　　　　　　　　 ２，０４２円\n　退院・退所加算（Ⅰ）イ　　　　　　　　　　　　 ４，５９４円\n　退院・退所加算（Ⅰ）ロ　　　　　　　　　　　　 ６，１２６円\n　退院・退所加算（Ⅱ）イ　　　　　　　　　　　　 ６，１２６円\n　退院・退所加算（Ⅱ）ロ　　　　　　　　　　　　 ７，６５７円\n　退院・退所加算（Ⅲ）　　　　　　　　　　　　　 ９，１８９円\n　緊急時等居宅カンファレンス加算　　　　　　 ２，０４２円\n　ターミナルケアマネジメント加算　　　　　　 ４，０８４円\n　通院時情報連携加算　　　　　　　　 　　　　　　 ５１０円",
    juyo_04_fee_shoguu:
      "〇　当事業所では介護職員等処遇改善加算を算定します。\n　当該加算は、月の居宅介護支援費に各種加算を加えた1月あたりの総単位数に２.１%を乗じた単位数が加算されます。",
    juyo_04_fee_transport:
      "前記２の「通常のサービス実施地域」にお住まいの方は無料です。\nそれ以外の地域にお住まいの方は、介護支援専門員が訪問する為の交通費の実費分をお支払い頂きます。",
    juyo_04_fee_other:
      "・利用者様はいつでも解約することができ、解約料はかかりません。\n・要介護認定の代行申請にかかる費用は無料です。\n・契約書第１０条３項の複写物にかかる料金は、１０枚までは無料です。但し、１０枚を超えた分につきましては、１枚あたり１０円の実費をお支払い頂きます。",
    juyo_04_fee_payment:
      "　・料金が発生する場合、月ごとの清算とし、毎月２５日までに前月分の請求を致しますので７日以内にお支払いください。お支払い頂いた後、直ちに領収書を発行致します。\n　・お支払い方法につきましては、お客様のご都合により口座振替・現金集金のどちらかを契約の際にお選び頂きます。",

    // ===== 別紙５: サービスの利用方法 (小見出し別) =====
    juyo_05_usage_start:
      "まずは、お電話等でお申込み下さい。当社の介護支援専門員がご自宅を訪問します。その後、契約を締結して頂いた後に本居宅介護支援サービスの提供を開始します。",
    juyo_05_usage_end_user:
      "お申し出下さればいつでも本契約を解除することができます。",
    juyo_05_usage_end_office:
      "介護支援専門員の休退職等による人員不足等、やむを得ない事情により本契約を解除させて頂く場合があります。その場合は、終了１ヶ月前までに文書で通知するとともに、お客様の居住地域の他の指定居宅介護支援事業者をご紹介するなど必要な措置を講じます。",
    juyo_05_usage_auto_end:
      "以下の場合は、双方からの通知が無くとも自動的にサービスを終了とさせて頂きます。\n・利用者様が介護保険施設等に入院・入所された場合\n・利用者様の要介護認定区分が非該当（自立）または要支援と認定された場合（条件を変更して再度契約する事ができます）\n・介護保険サービスの未利用期間が3ヶ月に及んだ場合。（医療機関への入院を含む）\n・利用者様がお亡くなりになられた場合",
    juyo_05_usage_other_end:
      "利用者様やそのご家族等（内縁関係等の関係者を含む）、身元引受人及びその他の利用者様の関係者等が故意に法令違反を行った場合や、当事業所や介護支援専門員等の従業者に対し下記のような行為があった場合は、文書で通知することにより、直ちに当該契約を解除させて頂く場合があります。\n・乱暴な言動、暴力、怒鳴る、恐喝、物を投げつける、刃物を向ける、無理な要求や対象範囲外のサービスの強要など。\n・身体に理由なく触れる、卑猥な言動、ストーカー行為など。\n・その他、各種ハラスメントに該当するとみなされる行為　及び、本契約を継続しがたい程の背信行為を行った場合。",

    // ===== 別紙６: 居宅介護支援の特徴等 (15 細目) =====
    juyo_06_policy:
      "・利用者様の心身の状況及びその置かれている状況、環境等に応じて利用者様の選択に基づき、適切な保健・医療及び福祉サービスが多様な事業者から、総合的かつ効果的に提供されるように、利用者様に対して必要な援助を行います。\n・利用者様の立場に立ち、提供されるサービスが特定の事業者に不当に偏することのないよう、利用者様等のご希望を踏まえつつ公正中立に行います。\n・事業の実施にあたっては、関係市区町村・事業実施地域の保健・医療・福祉サービス事業者と十分に連携を図り、利用者様に対する適切なサービス提供に努めます。\n・利用者様の要介護状態の軽減、若しくは悪化の防止に資するよう、利用者様が現に抱いている問題点を明らかにし、解決すべき課題を十分に把握した上で「居宅サービス計画」の作成にあたるものとします。",
    juyo_06_assessment:
      "　使用するアセスメントツール（課題分析票）は、「居宅サービス計画ガイドライン」を主に、厚生労働省の定める「２３の課題分析標準項目」を満たしたアセスメントツールを使用します。",
    juyo_06_explanation:
      "居宅サービス計画の作成にあたっては、利用者様から介護支援専門員に対して複数の指定居宅サービス事業者等の紹介を求めることや、居宅サービス計画に位置付けた指定居宅サービス事業者等の選定理由について説明を求めることができます。\nなお、上記内容を利用者様又はその家族に説明を行うにあたっては、理解が得られるよう文書の交付に加えて口頭での説明を懇切丁寧に行うとともに、それを理解したことについて必ず利用者様等から署名または捺印を得ることとします。",
    juyo_06_usage_ratio:
      "　当事業所が作成したケアプランにおける訪問介護、通所介護、地域密着型通所介護、福祉用具貸与の利用状況は別紙の通りです。",
    juyo_06_monitoring:
      "　介護支援専門員は、原則１月に１回以上利用者様の居宅を訪問し、利用者様及びご家族等と面接を行い、介護サービスの提供状況や利用者様の心身の状態、生活環境等を把握すると共に評価を行い、必要に応じて居宅サービス計画の変更などの措置を講じる又は検討します。\n　但し、下記の要件を満たした場合は、利用者様の居宅を訪問せずに、テレビ電話等を活用したオンラインによる面接を行うことがあります。\n・オンラインモニタリングについて、文書により利用者様の同意を得ている。（本契約書の同意を持って、当該事項に関しても同意を得たこととさせていただきます）\n・サービス担当者会議や担当者への意見照会等により、主治医・担当者・関係者から「利用者様の状態が安定している」、「利用者様がテレビ電話等を介して意思疎通ができる（家族等のサポート含）」、「リモートによるモニタリングで収集できない情報を、居宅サービス事業者から情報連携シート等を活用して情報提供を受けることにより補完できる」の３点について合意を得ている。\n・介護者の状況、住環境（住宅改修含む）、サービス（保険外含む）に特段の変化がない。\n・２カ月に１回は居宅を訪問してモニタリングを行っている。",
    juyo_06_carekaigi:
      "　市町村または地域包括支援センターが主催する地域ケア会議において、市町村または地域包括支援センターより、お客様に関する情報提供の求めがあった際には必要に応じて協力させて頂きます。",
    juyo_06_jisshu:
      "　当事業所は、介護保険法第六十九条の二第一項に規定する介護支援専門員実務研修における科目「ケアマネジメントの基礎技術に関する実習」等に協力する体制をとっており、千葉県より当該実習の協力の求めがあった際には、実習先として当該研修実習生の受け入れを致します。",
    juyo_06_medical:
      "・利用者様が医療機関に入院された場合には、入院先医療機関との情報共有など連携を円滑に行う必要があるため、入院先の医療機関に対し当事業所の名称と担当の介護支援専門員の氏名及び連絡先をお伝え下さい。\n・また、早期に当事業所の担当介護支援専門員にご一報ください。",
    juyo_06_gyakutai:
      "・利用者様への虐待防止、人権擁護のため、虐待の発生又はその再発を防止するための対策を検討する委員会や担当者の設置、指針の整備等必要な体制を整備すると共に、従事者に対し定期的に研修を実施します。\n・高齢者虐待と認める事案があった場合には、介護サービス事業者・介護支援専門員には、市町村または地域包括支援センター等に速やかに通報を行うことが義務付けられていますので、迅速に通報する等の必要な措置を講じます。",
    juyo_06_kansensho:
      "感染症の予防及びまん延の防止に努めるため、感染症に関する委員会の設置、指針の整備等必要な体制を整備すると共に、従業者に対し定期的に研修及び訓練を実施します。",
    juyo_06_bcp:
      "　感染症の蔓延や自然災害が発生した場合であっても、できる限り利用者様に必要な居宅介護支援サービスを継続的に提供できる体制を構築するため、「業務継続計画」を策定すると共に、従業者に対し当該計画に沿った研修及び訓練を実施します。",
    juyo_06_kosoku:
      "・サービスの提供にあたっては、利用者様または他者の生命又は身体を保護するため緊急やむを得ない場合を除き、身体的拘束は行いません。\n・やむを得ず身体的拘束等を行う場合には、その態様及び時間、その際の利用者様の心身の状況並びに緊急やむを得ない理由を記録します。",
    juyo_06_privacy:
      "・事業者、介護支援専門員及び事業者の使用する者は、当該居宅介護支援サービスの提供をする上で知り得た利用者様及びそのご家族等に関する個人情報を、介護サービスの提供に伴う連絡調整や利用者様等の生命、身体に危険がある場合など必要な場合を除き、正当な理由なく第三者に漏らしません。この守秘義務は契約終了後も同様です。\n・利用者様及びそのご家族に関する個人情報に関しては、漏洩することのないよう適切な管理を行い、その取り扱いには充分に注意します。\n・介護保険制度にて義務付けられているサービス担当者会議や利用される各介護・医療サービス等の利用調整等、居宅介護支援サービスを提供する上で必要と認められる場合においては、個人情報を引用させていただきます。この場合にも、使用する個人情報は必要最低限のものにとどめ、当該目的以外に個人情報を引用する事は決していたしません。",
    juyo_06_incident:
      "・居宅介護支援の提供により事故が発生した場合は、市町村、ご家族等に速やかに連絡を行うと共に、必要で最善な措置を講じます。\n・事業者の責に帰すべき事由により利用者様の生命・身体・財産に損害を及ぼした場合は、その損害について賠償します。",
    juyo_06_other:
      "・政省令の完全なる理解や表示事項、さらにサービスガイドライン検討小委員会の作成する「介護保険事業者ガイドライン」を遵守し、利用者様に対して公正中立な立場で適切なサービスを提供できるよう努めます。\n・サービス提供主体の多様化等により、介護保険サービスを巡る消費トラブルが多発することを想定し、それを未然に防げるような体制作りに努めます。\n・「居宅サービス計画」の作成または変更に関し、公正中立にこれを行い、利用者様に対して特定の居宅サービス事業者等によるサービスを利用させることの代償として、当該居宅サービス事業者等から金品、その他の財産上の利益を収受しません。",

    // ===== 別紙７: 苦情・相談窓口 (5 細目) =====
    juyo_07_complaint_intro:
      "　苦情・相談に関する窓口",
    juyo_07_complaint_service:
      "○「居宅サービス計画」に基づいて提供している各サービスについて\n　担当介護支援専門員　　○○　○○　（０４７５－８６－６０３８）",
    juyo_07_complaint_office:
      "〇当社の居宅介護支援に関するご相談・苦情\n　管理者　山科　博美　　　　　　（０４７５－８６－６０３８）\n　受付時間は月曜日から金曜日の午前９時から午後６時です。\n　但し、転送電話等により24時間365日の連絡体制を確保し、かつ必要に応じて利用者様等からの相談に対応 及び 必要と認められる居宅介護支援サービスを行うことができる体制を確保しています。\n　※営業日及び営業時間外の連絡につきましては、管理者の会社所有の携帯電話（080-9342-6539）までご連絡いただければ、担当の介護支援専門員に連絡がとれる体制を確保しています。",
    juyo_07_complaint_hq:
      "〇本社　お客様サービス係　　　　　　（０４３６－６０－３２３８）\n　受付時間は月曜日から金曜日の午前９時から午後６時です。",
    juyo_07_complaint_external:
      "〇当社以外に、市区町村の相談・苦情窓口等に伝えることができます。\n　千葉県国民健康保険団体連合会　　　　　　　　043-254-7428\n　大網白里市 高齢者支援課　　　　　　　　　　 0475-70-0309\n　東金市高齢者支援課                          0475-50-1219\n　九十九里町健康福祉課                        0475-70-3184\n　山武市高齢者福祉課                          0479-80-2641\n　横芝光町福祉課                              0479-84-1257\n　茂原市高齢者支援課                          0475-20-1572\n　白子町健康福祉課                            0475-33-2113\n　一宮町福祉健康課                            0475-42-1431\n　長生村福祉課                                0475-32-6809\n　千葉市緑区高齢障害支援課介護保険室          043-292-9491\n　八街市高齢者福祉課                          043-443-1491",

    // ===== 別紙８: 当社の概要 =====
    juyo_08_company:
      "　商号　　　　　株式会社儀八\n　本社　　　　　千葉県市原市姉崎東２丁目２番地６　ケイティビル９階\n　　　　　　　　（０４３６－６０－３２３８）\n　代表者　　　　代表取締役　　　手代木　正儀\n　設立　　　　　平成１２年１月１８日\n　資本金　　　　１,０００万円",

    // ===== 後方互換 (= 旧 1 key 版。新規発行で生成された保存値がここに来た場合の表示用) =====
    juyo_02_overview: "",
    juyo_04_fee: "",
    juyo_05_usage: "",
    juyo_06_features: "",
    juyo_07_complaint: "",
  };
}

/**
 * contract_type → section 定義配列を返す helper
 */
export function getSectionsForType(type: ContractType): ContractSection[] {
  // 2026-06-29: 1 値のみ運用なので常に 「契約書兼重要事項説明書」 の sections を返す。
  // 旧 helpers (JUUYOU_JIKOU_SECTIONS / KEIYAKUSHO_SECTIONS / KOJIN_JOUHOU_SECTIONS / OTHER_SECTIONS)
  // は未使用 (= 必要なら後日 再追加)。
  if (type === "契約書兼重要事項説明書") return KEIYAKU_KEN_JUYO_SECTIONS;
  return KEIYAKU_KEN_JUYO_SECTIONS;
}

/**
 * contract_type → デフォルト本文 (= 新規発行時に prefill)
 * 「契約書兼重要事項説明書」は法令引用が多いため defaults を返す。
 * 他は空 (= 既存挙動を維持)。
 */
// 2026-06-29: 1 値のみ運用なので _type 引数は形だけ (= 既存呼出 互換)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function getDefaultContentForType(_type: ContractType): UserContractContent {
  return getKeiyakuKenJuyoDefaults();
}

/**
 * 空の contract input を返す (= 新規作成 form 初期値)
 */
export function emptyContractInput(params: {
  tenantId: string;
  userId: string;
  officeId: string | null;
  contractType?: ContractType;
  businessType?: string | null;
}): UserContractInput {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  return {
    tenant_id: params.tenantId,
    user_id: params.userId,
    office_id: params.officeId,
    contract_type: params.contractType ?? "契約書兼重要事項説明書",
    business_type: params.businessType ?? null,
    issued_date: `${yyyy}-${mm}-${dd}`,
    effective_from: `${yyyy}-${mm}-${dd}`,
    effective_until: null,
    signed_at: null,
    signed_by_name: null,
    signed_by_relation: "本人",
    content: {},
    attachment_url: null,
    status: "draft",
    notes: null,
  };
}
