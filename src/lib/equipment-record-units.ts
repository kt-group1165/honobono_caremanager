/**
 * order-app から送られる福祉用具の実績 (shared_documents / service_record_monthly の records[]) を
 * 利用票の貸与行の単位にする純関数 — ImportEquipmentRecordModal と検査が同じ式を使うため (SESSION_START ⑪)。
 *
 * ── 受け取る値 (order-app commit 46819a4 の契約・2026-11-13) ─────────────────────
 *   monthly_rental_fee   ★ 円・按分前・1 個あたり
 *   quantity             数量。null / 0 / 未設定は 1
 *   payment_type         orders の生の値 "介護" / "自費" / "特価自費" / null (不明)。絞らずに送られてくる
 *   date_range_start/end 当月の貸与期間 (常に埋まる)
 *
 * ── 直した 3 つ (2026-11-13。本番の取込は 0 件 = 未発火のうちに直した) ──────────────
 *   ① 円を ÷10 していなかった (単位が 10 倍)
 *   ② 数量を掛けていなかった
 *   ③ 自費も介護保険の単位に入れていた
 *     ★ "介護" と完全一致するものだけ入れる。"特価自費" も自費 (名前に「特価」が付くだけ)。
 *     ★ null (不明) は入れない。入れなかった件数は呼び出し側が必ず出す (黙って落とさない)
 *     ★ payment_type が未設定 (= 列が無い古い payload) のときだけ従来どおり入れる
 *
 * ── 按分 ─────────────────────────────────────────────────────────────────────
 *   ★ date_range から按分し、その月の実額として rental_month_actual_units に入れる (src/lib/rental-units.ts)。
 *   画面の日付の印は使わない: 印は貸与に切り替えた瞬間に自動で付く既定値で根拠にならず、
 *   種別ごとに集約するモードでは期間の違う複数の用具の印を和集合にするので 1 台ごとの期間が失われる。
 *   規則は order-app の請求と同じにする (order-app/lib/half-month-units.ts の halfMonthFlags / halfMonthUnits):
 *     前半 (1〜15 日) と後半 (16 日〜末日) の両方に貸与日 → 満額 / 片方だけ → round(1 個の単位 ÷ 2) / どちらも無い → 0
 *     そのうえで × 数量 (1 明細の当月の算定単位は 1 個あたり)
 *   ⚠ 別アプリ (別 Vercel) なので import できず、同じ式をここに書いている。
 *     ★ order-app lib/half-month-units.ts を直したら ★ こちらも直すこと
 *
 * ── ★ 半月の判定規則は 意図的に 2 つある。揃えてはいけない (2026-11-13・H 判断) ─────────────
 *   rental-units.ts (画面)          入力 = 利用票の日付マーク (慣習表記。印 0 個 839 行 / 1 日だけが大半)。
 *                                   日数 >= 16 + 単独マークの例外。ほのぼのの日割区分と 95.6% 一致 (2026-11-12 実測 1,201 行)
 *   equipment-record-units.ts (ここ) 入力 = order-app の実際の開始日・終了日。
 *                                   前半・後半の両方に貸与日があれば満額 (order-app と同じ式)。order-app 側の実測で 98.6%
 *   ★ 画面の規則を order-app 方式にすると 1,201 行中 282 行が壊れる (72.8% に落ちる)。
 *   ★ 逆に取込を画面方式にすると、実日付という良い材料を捨てることになる。
 *   例 6/5〜6/25: こちら 満額 / 画面 半月 (入力の意味が違うので、それで正しい)
 *   ⚠ payload に休止・入院・日割り設定は無い。order-app でそれらがある明細は、請求の値とずれうる
 */

export type EquipmentRecordLike = {
  date_range_start: string;
  date_range_end: string;
  monthly_rental_fee: number;
  quantity?: number | null;
  payment_type?: string | null;
};

/** 介護保険の単位に入れる行か。"介護" と完全一致のみ。payment_type が未設定 (古い payload) は従来どおり入れる */
export function isInsuranceRecord(r: Pick<EquipmentRecordLike, "payment_type">): boolean {
  if (r.payment_type === undefined) return true;
  return typeof r.payment_type === "string" && r.payment_type.trim() === "介護";
}

/** 入れる行と入れない行に分ける。入れない行は理由ごとに数える (呼び出し側が表示する) */
export function splitInsuranceRecords<T extends Pick<EquipmentRecordLike, "payment_type">>(records: T[]): {
  insured: T[];
  skipped: { 自費: number; 支払区分不明: number; その他: number };
} {
  const insured: T[] = [];
  const skipped = { 自費: 0, 支払区分不明: 0, その他: 0 };
  for (const r of records) {
    if (isInsuranceRecord(r)) { insured.push(r); continue; }
    const p = r.payment_type == null ? "" : String(r.payment_type).trim();
    if (!p) skipped.支払区分不明++;
    else if (p === "自費" || p === "特価自費") skipped.自費++;
    else skipped.その他++;
  }
  return { insured, skipped };
}

const daysOfYm = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/** 前半 (1〜15 日) / 後半 (16 日〜末日) に貸与日があるか。日付は文字列比較 (タイムゾーンで 1 日ずれない) */
export function rentalHalves(start: string, end: string, ym: string): { firstHalf: boolean; secondHalf: boolean } {
  const n = daysOfYm(ym);
  const s = (start ?? "").slice(0, 10), e = (end ?? "").slice(0, 10);
  let firstHalf = false, secondHalf = false;
  for (let d = 1; d <= n; d++) {
    const day = `${ym}-${String(d).padStart(2, "0")}`;
    if (s && day < s) continue;
    if (e && day > e) continue;
    if (d <= 15) firstHalf = true; else secondHalf = true;
  }
  return { firstHalf, secondHalf };
}

/** 数量。null / 0 / 負 / 数でない は 1 */
export function quantityOf(r: Pick<EquipmentRecordLike, "quantity">): number {
  const q = Number(r.quantity);
  return Number.isFinite(q) && q > 0 ? q : 1;
}

/** 1 明細の当月の単位 (その月の実額)。round(円 ÷ 10) を 1 個の単位とし、半月按分してから × 数量 */
export function recordMonthActualUnits(r: EquipmentRecordLike, ym: string): number {
  const piece = Math.round((Number(r.monthly_rental_fee) || 0) / 10);
  const { firstHalf, secondHalf } = rentalHalves(r.date_range_start, r.date_range_end, ym);
  const perPiece = firstHalf && secondHalf ? piece : !firstHalf && !secondHalf ? 0 : Math.round(piece / 2);
  return perPiece * quantityOf(r);
}
