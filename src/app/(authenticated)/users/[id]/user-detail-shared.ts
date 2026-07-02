/**
 * server / client 両方で使う型 + 純粋ヘルパー。
 * "use client" を付けないことで RSC (page.tsx) からの import 呼び出しを許容する。
 */

/** 訪問介護のサービス種別 */
export const HOME_CARE_CATEGORIES = [
  "介護",
  "総合事業",
  "居宅介護",
  "重度訪問介護",
  "同行援護",
  "移動支援",
  "自費",
] as const;
export type HomeCareCategoryName = (typeof HOME_CARE_CATEGORIES)[number];

/** 完結した過去の利用期間 (履歴) */
export type ServicePeriod = {
  start_date: string | null;
  end_date: string | null;
};

export type HomeCareCategory = {
  category: HomeCareCategoryName;
  active: boolean;
  /** 現行期間の開始日 */
  start_date: string | null;
  /** 現行期間の終了日 (入っていれば「終了済」。再開すると history に退避) */
  end_date: string | null;
  /** 過去の完結期間 (古い順)。終了 → 再開 を繰り返すと積まれる */
  history: ServicePeriod[];
};

export type OfficeServiceRow = {
  id: string;
  office_id: string;
  start_date: string | null;
  end_date: string | null;
  service_notes: string | null;
  home_care_categories: HomeCareCategory[];
};

export type OfficeRow = { id: string; name: string; service_type: string };

export type ClientMemoRow = {
  id: string;
  client_id: string;
  scope: string;
  tenant_id: string | null;
  body: string;
};

/** DB から取得した値を 7 カテゴリ全てが揃った配列に正規化 (旧形式 = history 無し も吸収) */
export function normalizeCategories(raw: unknown): HomeCareCategory[] {
  const list = Array.isArray(raw) ? (raw as Partial<HomeCareCategory>[]) : [];
  return HOME_CARE_CATEGORIES.map((name) => {
    const found = list.find((c) => c?.category === name);
    return {
      category: name,
      active: !!found?.active,
      start_date: found?.start_date ?? null,
      end_date: found?.end_date ?? null,
      history: Array.isArray(found?.history) ? found.history : [],
    };
  });
}
