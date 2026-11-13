// ============================================================================
// 「KY 8222 の貸与が 1 行だけの人」の利用票の貸与行を埋める判定 (純関数。2026-11-13 H 承認)
//   取込 fill_rental_units_from_ky_single.mjs と 検査 check:rental-units の両方が使う (逐語コピーしない)
//
// 条件 (全部そろったときだけ埋める):
//   ・利用票の貸与行 (category 17/67) が その帳票に ★ ちょうど 1 行
//   ・その 1 行がまだ単位を持たない (manual_units も rental_month_actual_units も 0/空)
//   ・KY 8222 のその人 (居宅事業所番号, 被保番) の貸与行 (種類 17/67) が ★ ちょうど 1 行
//   ・種類が利用票の行の category と同じ (17 と 17 / 67 と 67)
// 埋める値: KY の給付計画単位数 = その月の実額 (半月なら半額済み) → rental_month_actual_units (印で按分しない)
// 根拠: 別表 1 行・KY 1 行の人で 別表の単位 = KY の単位 が 47/47 (2026-11-13・いすみ/高品/木更津)
// ============================================================================

const RENTAL = new Set(["17", "67"]);
const hasUnits = (s) => Number(s?.manual_units) > 0 || Number(s?.rental_month_actual_units) > 0;

/**
 * @param {Array<Record<string, unknown>>} services  利用票の content.services
 * @param {Array<{serviceKind: string, plannedUnits: number}>} kyRental  その人の KY 8222 の貸与行 (17/67 のみ)
 * @returns {{ok: true, index: number, units: number} | {ok: false, reason: string}}
 */
export function planKySingle(services, kyRental) {
  const rows = (services ?? []).map((s, i) => ({ s, i })).filter(({ s }) => RENTAL.has(String(s?.category ?? "")));
  if (rows.length === 0) return { ok: false, reason: "利用票に貸与行なし" };
  if (rows.length > 1) return { ok: false, reason: "利用票の貸与行が複数" };
  const { s, i } = rows[0];
  if (hasUnits(s)) return { ok: false, reason: "既に単位あり" };
  if (!kyRental || kyRental.length === 0) return { ok: false, reason: "KY に貸与行なし" };
  if (kyRental.length > 1) return { ok: false, reason: "KY の貸与行が複数" };
  const k = kyRental[0];
  if (String(k.serviceKind) !== String(s.category)) return { ok: false, reason: `種類が違う (利用票 ${s.category} / KY ${k.serviceKind})` };
  const units = Number(k.plannedUnits);
  if (!Number.isFinite(units) || units <= 0) return { ok: false, reason: "KY の単位が 0 以下" };
  return { ok: true, index: i, units };
}

/** 書いた後に読み直した行が、KY の貸与合計と一致するか (H 指示: 書いた後に確かめる)
 * @param {Record<string, unknown> | undefined} row
 * @param {number} kyTotal
 * @param {string} source
 * @returns {boolean} */
export function verifyKySingle(row, kyTotal, source) {
  return !!row && row._units_source === source && Number(row.rental_month_actual_units) === Number(kyTotal) && !(Number(row.manual_units) > 0);
}
