/**
 * 利用票 (第6表) の福祉用具貸与行 (category=17) の月計単位 — 画面・印刷・検査が同じ式を使うための純関数。
 *
 * もともと reports-content.tsx (client component) の中にあり、検査から呼べなかった (SESSION_START ⑪)。
 * 2026-11-13 に挙動を変えずにここへ移し、そのうえで rental_month_actual_units を足した。
 *
 * ── 単位数の 2 つの持ち方 (2026-11-13・H 判断) ──────────────────────────────
 *   manual_units               ★ 1 月あたりの単価 (按分前)。日付の印から 1月/半月 を判定して按分する。
 *                              ServiceSelector の自動入力 (rental_price ÷ 10)・用具の実績取込・
 *                              ケアサポ明細の backfill (fukuyogu_meisai_*) はすべてこの意味で入れる。
 *   rental_month_actual_units  ★ その月に実際にかかった額 (半月なら半額)。★ 印で按分しない。
 *                              別表 (第7表) の値がこれ (migrations/fill_rental_units_from_betsuhyou.mjs)。
 *                              別表には日数も単価も印字されず、どの行が半月かは分からない。
 *                              按分しないので、それでも正しく表示できる。
 * 両方あれば manual_units を使う (手入力・自動入力が優先)。どちらも無ければ 0。
 *
 * ── ★ 半月の判定規則は 意図的に 2 つある。揃えてはいけない (2026-11-13・H 判断) ─────────────
 *   rental-units.ts (画面・ここ)     入力 = 利用票の日付マーク (慣習表記。印 0 個 839 行 / 1 日だけが大半)。
 *                                   日数 >= 16 + 単独マークの例外 (autoRentalPeriodType)。
 *                                   ほのぼのの日割区分と 95.6% 一致 (2026-11-12 実測 1,201 行)
 *   equipment-record-units.ts (取込) 入力 = order-app の実際の開始日・終了日。
 *                                   前半・後半の両方に貸与日があれば満額 (order-app lib/half-month-units.ts と同じ式)。
 *                                   order-app 側の実測で 98.6%
 *   ★ 画面の規則を order-app 方式にすると 1,201 行中 282 行が壊れる (72.8% に落ちる)。
 *   ★ 逆に取込を画面方式にすると、実日付という良い材料を捨てることになる。
 *
 * ⚠ 以前は別表の値も manual_units に入れ、_units_period="month_actual" で区別していた (286 行)。
 *   タグは編集で消えない・付け直されないため、印を変えると半額をさらに半分にしえた。
 *   migrations/migrate_rental_month_actual_units.mjs で別キーへ移す。
 */

export type RentalPeriod = "1month" | "half_month";

/** 貸与行の月計に使う項目だけ。画面の SvcRow はこれを満たす */
export type RentalRowLike = {
  manual_units?: number | null;
  rental_month_actual_units?: number | null;
  planned: boolean[];
  actual: boolean[];
};

/** yyyy-MM から月の日数を計算。Invalid な値は 30 にフォールバック (UI 表示安全側)。 */
export function daysInMonthOf(yearMonth: string): number {
  const m = /^(\d{4})-(\d{1,2})$/.exec(yearMonth);
  if (!m) return 30;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || mo < 1 || mo > 12) return 30;
  return new Date(y, mo, 0).getDate();
}

/**
 * 利用票の日付マークから区分 (1月 / 半月) を自動判定する。
 *
 * 介護保険の福祉用具貸与の算定ルール (厚労省 解釈通知):
 *   - 月の途中で開始または終了 → 原則「半月」
 *   - ただし「月初から開始」または「月末まで継続」で **利用日数 ≥ 16 日** → 「1月」
 *   - 同月内開始+終了 (boundary に触れない) → 常に「半月」
 *
 * 実装:
 *   - 0 マーク → 1月 (default)
 *   - 単独マーク:
 *       1日 or 末日 のみ → 1月 (= 月全体継続の慣習表記)
 *       中の日 のみ → 開始日と解釈し、末日までの利用日数 ≥16 → 1月、未満 → 半月
 *   - 2+ マーク:
 *       1日〜末日 (全月) → 1月
 *       boundary 触れる (1日 or 末日 を含む) → 利用日数 (= last - first + 1) ≥16 → 1月、未満 → 半月
 *       boundary 触れない → 常に 半月
 *
 * ⚠ 行を貸与に切り替えた瞬間に画面が「1 日に印」を自動で付ける (reports-content の rentalSwitchOn)。
 *   なので「印が 1 日目だけ」は既定値であって、まるごと 1 か月だった証拠にはならない。
 */
export function autoRentalPeriodType(marks: boolean[], yearMonth: string): RentalPeriod {
  const daysInMonth = daysInMonthOf(yearMonth);
  const days: number[] = [];
  for (let i = 0; i < Math.min(daysInMonth, marks.length); i++) {
    if (marks[i]) days.push(i + 1);
  }
  if (days.length === 0) return "1month";
  const first = days[0];
  const last = days[days.length - 1];
  if (days.length === 1) {
    if (first === 1 || first === daysInMonth) return "1month";
    const utilizationDays = daysInMonth - first + 1;
    return utilizationDays >= 16 ? "1month" : "half_month";
  }
  if (first === 1 && last === daysInMonth) return "1month";
  if (first === 1 || last === daysInMonth) {
    const utilizationDays = last - first + 1;
    return utilizationDays >= 16 ? "1month" : "half_month";
  }
  return "half_month";
}

/** その行の単位数がどちらの持ち方か (画面の表示切替用)。manual_units 優先 */
export function rentalUnitsKind(svc: Pick<RentalRowLike, "manual_units" | "rental_month_actual_units">): "rate" | "month_actual" | null {
  const rate = Number(svc.manual_units ?? 0);
  if (Number.isFinite(rate) && rate > 0) return "rate";
  const act = Number(svc.rental_month_actual_units ?? 0);
  if (Number.isFinite(act) && act > 0) return "month_actual";
  return null;
}

/**
 * rental 行の月計単位数。
 *   manual_units (単価) があれば round(単価 × 倍率)。倍率は印から 1月=1 / 半月=0.5
 *   無くて rental_month_actual_units (実額) があれば round(実額)。★ 印は見ない (予定・実績とも同じ値)
 *   どちらも無ければ 0
 */
export function rentalMonthlyUnits(svc: RentalRowLike, yearMonth: string, kind: "planned" | "actual" = "planned"): number {
  const k = rentalUnitsKind(svc);
  if (k === "rate") {
    const units = Number(svc.manual_units);
    const marks = kind === "planned" ? svc.planned : svc.actual;
    const period = autoRentalPeriodType(marks ?? [], yearMonth);
    return period === "1month" ? Math.round(units) : Math.round(units * 0.5);
  }
  if (k === "month_actual") return Math.round(Number(svc.rental_month_actual_units));
  return 0;
}
