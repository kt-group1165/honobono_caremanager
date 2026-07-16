/**
 * パート職員 給与計算 — サービス類型別 時給 × 実働時間 (純関数)。
 *
 * ★ money-safety: 給与額の計算式はこの純関数に閉じ込め、scripts/smoke-payroll.mts で
 *   固定入力→固定期待値を回帰する。UI/loader は入力を組み立てて呼ぶだけ。
 *
 * 計算式 (payroll-app の page.tsx の時給計算と同一):
 *   1 訪問ごとに pay = round(実働分 / 60 * 類型時給)
 *   職員別に pay を整数加算 (端数処理は訪問単位で確定させ、合算では丸めない)。
 *   マッピング未設定 (service_type→類型が無い/時給不明) の訪問は pay=null で除外し、
 *   未マッピングとして可視化する (握り潰さない)。
 */

/** 実績 1 訪問 (kaigo_visit_schedule status='completed' 由来) */
export interface PartTimeVisit {
  staffId: string;
  staffName?: string;
  staffNameKana?: string; // 並び順 (ふりがな)。無ければ staffName で照合
  serviceType: string; // schedule.service_type の生値
  minutes: number; // 実働分 (end - start、負値・NaN は 0 に矯正)
  date: string; // 'YYYY-MM-DD'
}

/** サービス類型 (時給の単位) */
export interface WageCategory {
  id: string;
  name: string;
  hourlyRate: number; // 円/時
}

/** 訪問 1 件の給与内訳 */
export interface PartTimeVisitDetail {
  date: string;
  serviceType: string;
  minutes: number;
  categoryId: string | null;
  categoryName: string | null;
  hourlyRate: number | null;
  pay: number | null; // null = 未マッピング (時給不明で計算対象外)
}

/** 職員 1 名 × 月 の集計 */
export interface PartTimeStaffResult {
  staffId: string;
  staffName: string;
  staffNameKana: string;
  visits: PartTimeVisitDetail[];
  totalMinutes: number; // 全訪問の実働分 (未マッピング含む)
  paidMinutes: number; // 時給が付いた訪問の実働分
  totalPay: number; // 時給×実働の合計 (未マッピングは除外)
  unmappedCount: number;
  unmappedMinutes: number;
}

export interface PartTimePayrollResult {
  byStaff: PartTimeStaffResult[];
  /** マッピング未設定で pay 計算できなかった service_type の生値一覧 */
  unmappedServiceTypes: string[];
  grandTotalPay: number;
  grandTotalMinutes: number;
}

const toMinutes = (n: number): number =>
  Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;

/**
 * 実績訪問・マッピング・類型から、職員別のパート給与 (時給分) を算出する。
 */
export function calcPartTimePayroll(
  visits: PartTimeVisit[],
  mappings: { serviceType: string; categoryId: string | null }[],
  categories: WageCategory[],
): PartTimePayrollResult {
  const catById = new Map(categories.map((c) => [c.id, c]));
  const catByServiceType = new Map<string, WageCategory | null>();
  for (const m of mappings) {
    catByServiceType.set(
      m.serviceType,
      m.categoryId ? (catById.get(m.categoryId) ?? null) : null,
    );
  }

  const byStaffMap = new Map<string, PartTimeStaffResult>();
  const unmappedSet = new Set<string>();

  for (const v of visits) {
    const minutes = toMinutes(v.minutes);
    const cat = catByServiceType.has(v.serviceType)
      ? catByServiceType.get(v.serviceType)!
      : null;
    const hourlyRate = cat ? cat.hourlyRate : null;
    // 時給が引けた場合のみ pay を確定 (round は訪問単位)
    const pay =
      hourlyRate !== null ? Math.round((minutes / 60) * hourlyRate) : null;
    if (pay === null) unmappedSet.add(v.serviceType);

    let s = byStaffMap.get(v.staffId);
    if (!s) {
      s = {
        staffId: v.staffId,
        staffName: v.staffName ?? "",
        staffNameKana: v.staffNameKana ?? "",
        visits: [],
        totalMinutes: 0,
        paidMinutes: 0,
        totalPay: 0,
        unmappedCount: 0,
        unmappedMinutes: 0,
      };
      byStaffMap.set(v.staffId, s);
    }
    if (v.staffName && !s.staffName) s.staffName = v.staffName;
    if (v.staffNameKana && !s.staffNameKana) s.staffNameKana = v.staffNameKana;
    s.visits.push({
      date: v.date,
      serviceType: v.serviceType,
      minutes,
      categoryId: cat?.id ?? null,
      categoryName: cat?.name ?? null,
      hourlyRate,
      pay,
    });
    s.totalMinutes += minutes;
    if (pay !== null) {
      s.paidMinutes += minutes;
      s.totalPay += pay;
    } else {
      s.unmappedCount += 1;
      s.unmappedMinutes += minutes;
    }
  }

  const byStaff = [...byStaffMap.values()].sort((a, b) =>
    (a.staffNameKana || a.staffName).localeCompare(
      b.staffNameKana || b.staffName,
      "ja",
    ),
  );
  for (const s of byStaff) {
    s.visits.sort((a, b) =>
      a.date === b.date
        ? a.serviceType.localeCompare(b.serviceType, "ja")
        : a.date < b.date
          ? -1
          : 1,
    );
  }

  return {
    byStaff,
    unmappedServiceTypes: [...unmappedSet].sort((a, b) =>
      a.localeCompare(b, "ja"),
    ),
    grandTotalPay: byStaff.reduce((s, x) => s + x.totalPay, 0),
    grandTotalMinutes: byStaff.reduce((s, x) => s + x.totalMinutes, 0),
  };
}

/** 'HH:MM'(:SS) の開始・終了から実働分を出す (日跨ぎは翌日跨ぎとして +24h 補正) */
export function minutesBetween(
  start: string | null | undefined,
  end: string | null | undefined,
): number {
  if (!start || !end) return 0;
  const p = (t: string): number | null => {
    const m = /^(\d{1,2}):(\d{2})/.exec(t);
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  };
  const s = p(start);
  const e = p(end);
  if (s === null || e === null) return 0;
  let diff = e - s;
  if (diff < 0) diff += 24 * 60; // 日跨ぎ (例 23:30→00:30)
  return diff;
}
