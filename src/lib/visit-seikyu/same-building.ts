/**
 * 訪問介護 同一建物減算 (令和6年度〜)
 *
 * 所定単位数 (基本サービス = 身体/生活/通院等の単位合計) に対する % 減算。
 * 加算 (初回/緊急時/生活機能向上/処遇改善) には掛けない。
 *
 * 減算後の単位が区分支給限度基準・処遇改善% の母数になるため、集計側では
 * 所定単位確定後・月加算後・超過判定前に減算行を grossBaseUnits へ反映する。
 *
 * tier は client_office_assignments.same_building_tier ('1'|'2'|'3'|null) に持つ。
 * null = 減算なし。同一建物区分は事業所ごとに異なりうるため junction に持つ。
 *
 * コード/名称はマスタ (kaigo_service_codes, system=介護, service_category=11) から
 * 対象月世代 (validInMonth) で解決するが、マスタの units は 0 なので使わず、
 * 率はここの制度定数を用いる。
 */
export type SameBuildingTier = "1" | "2" | "3";

export interface SameBuildingReduction {
  /** サービスコード 6 桁 */
  code: string;
  /** 減算率 (所定単位数に対する割合) */
  rate: number;
  /** 表示ラベル */
  label: string;
}

/** tier → { code, rate, label }。率は令和6年度改定の制度定数 (マスタ units=0 のため不使用) */
export const SAME_BUILDING_REDUCTION: Record<SameBuildingTier, SameBuildingReduction> = {
  "1": { code: "114114", rate: 0.1, label: "同一建物減算1 (10%)" },
  "2": { code: "114115", rate: 0.15, label: "同一建物減算2 (15%)" },
  "3": { code: "114116", rate: 0.12, label: "同一建物減算3 (12%)" },
};

/** UI セレクタ用の選択肢 (なし + 3 区分) */
export const SAME_BUILDING_OPTIONS: { value: "" | SameBuildingTier; label: string }[] = [
  { value: "", label: "なし" },
  { value: "1", label: "減算1 (10%)" },
  { value: "2", label: "減算2 (15%)" },
  { value: "3", label: "減算3 (12%)" },
];
