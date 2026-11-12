/**
 * 福祉用具の実績取込 (order-app → ImportEquipmentRecordModal) で、利用票の貸与行をどう入れ替えるか — 純関数。
 * 取込の保存 (persistEquipmentRecords) と 利用票画面の「用具ごと / 種別ごと」切替 (reports-content) が同じ判定を使う。
 *
 * ── なぜ (2026-11-13・H 判断 A) ─────────────────────────────────────────────────
 * 以前は取込のたびに種類 17 の貸与行を ★ 出どころに関係なく全部消して作り直していた。
 *   その時点の本番: 貸与行のある利用票 2,249 件 / 9,006 行。うち出どころ付き 421 帳票 / 1,490 行
 *   (ケアサポ明細 fukuyogu_meisai_* 1,204 + 別表 betsuhyou_* 286)。確認画面はこれを「削除されません」と表示したうえで
 *   全部消していた (2026-11-13 実測。本番の取込は 0 件なので未発火。表示は a9034dcb で先に直した)。
 *
 * ── 決まり ───────────────────────────────────────────────────────────────────
 *   ① 取込が作る行には印 _units_source = "equipment_import" を付ける (本番の取込 0 件のうちに付けたので、取込由来は全部印付き)
 *   ② 消してよいのは 印付きの行だけ
 *   ③ 送信元の事業所と同じかもしれない事業所に、印の無い / 他の出どころの貸与行があれば ★ 止めて人に選ばせる
 *        keep_existing    既存を残し、取込行は足さない
 *        replace_existing 既存 (その事業所かもしれない行) を消して取込に置き換える
 *      ★ 既定は作らない (どちらかが既定だと、また黙って壊れる)
 *   ★ 同じ用具かどうかを機械的に照合しない: 利用票の事業所名は 10 文字ほどで切れ、品目もサービス名と商品名で表記が違う。
 *     事業所の判定は「どちらかがもう片方で始まる (空白・全半角をそろえて)」か「事業所名が空」なら ★ 同じかもしれない側に倒す。
 *     どちらにも当たらない行は ★ 別の事業所として触らない (画面に一覧を出すので、表記ゆれで漏れても人が気づける)
 *   ⚠ 種類 67 (介護予防の貸与) は対象外 (2026-11-13 時点で 5 行)。消えない代わりに、取込とも突き合わない
 */

export const EQUIPMENT_IMPORT_SOURCE = "equipment_import";

export type MergeRow = {
  category?: string | null;
  provider?: string | null;
  content?: string | null;
  _units_source?: string | null;
};

export type ImportChoice = "keep_existing" | "replace_existing";

const isRental17 = (r: MergeRow) => String(r.category ?? "") === "17";
export const isImportRow = (r: MergeRow) => isRental17(r) && r._units_source === EQUIPMENT_IMPORT_SOURCE;

const normProv = (s: string | null | undefined) =>
  (s ?? "").normalize("NFKC").replace(/[\s　]/g, "").replace(/^[*＊]+/, "");

/** 利用票の事業所名が 送信元の事業所 (offices.name) と同じかもしれないか。空・前方一致 (どちら向きでも) なら true */
export function mayBeSameProvider(rowProvider: string | null | undefined, senderName: string | null | undefined): boolean {
  const a = normProv(rowProvider), b = normProv(senderName);
  if (!a || !b) return true;
  return a.startsWith(b) || b.startsWith(a);
}

export type MergePlan<T extends MergeRow> =
  | { status: "ok"; services: T[]; removedImportRows: number; replacedRows: number; keptOtherProviderRows: T[] }
  | { status: "needs_choice"; conflicts: T[]; bySource: Record<string, number>; keptOtherProviderRows: T[] };

/**
 * @param services   今の利用票の services[]
 * @param importRows 取込から作った行 (全部に印が付いていること)。keep_existing なら使わない
 * @param senderName 送信元の事業所名 (offices.name)
 * @param choice     止まったあとに人が選んだもの。null = まだ選んでいない
 */
export function planEquipmentImport<T extends MergeRow>(
  services: T[],
  importRows: T[],
  senderName: string | null | undefined,
  choice: ImportChoice | null,
): MergePlan<T> {
  const nonRental = services.filter((r) => !isRental17(r));
  const oldImport = services.filter(isImportRow);
  const others = services.filter((r) => isRental17(r) && !isImportRow(r));
  const conflicts = others.filter((r) => mayBeSameProvider(r.provider, senderName));
  const keptOtherProviderRows = others.filter((r) => !mayBeSameProvider(r.provider, senderName));
  if (conflicts.length && choice == null) {
    const bySource: Record<string, number> = {};
    for (const r of conflicts) {
      const k = r._units_source ? String(r._units_source).replace(/_\d{4}-?\d{2}(-?\d{2})?$/, "_*") : "(出どころ無し: 手入力・ほのぼの取込など)";
      bySource[k] = (bySource[k] ?? 0) + 1;
    }
    return { status: "needs_choice", conflicts, bySource, keptOtherProviderRows };
  }
  if (conflicts.length && choice === "keep_existing") {
    // 既存を残し、取込行は足さない。以前の取込行もそのまま (触らない)
    return { status: "ok", services: [...services], removedImportRows: 0, replacedRows: 0, keptOtherProviderRows };
  }
  // 衝突なし、または replace_existing: 以前の取込行と (replace なら) 衝突行を消して、取込行を足す
  const stray = importRows.filter((r) => !isImportRow(r));
  if (stray.length) throw new Error(`取込から作った行に印 (${EQUIPMENT_IMPORT_SOURCE}) が無い: ${stray.length} 行`);
  return {
    status: "ok",
    services: [...nonRental, ...keptOtherProviderRows, ...importRows],
    removedImportRows: oldImport.length,
    replacedRows: choice === "replace_existing" ? conflicts.length : 0,
    keptOtherProviderRows,
  };
}
