/**
 * 帳票 (kaigo_report_documents) の「マスタから引ける欄」を表示・印刷時に引き直すヘルパー。
 *
 * ── 背景 (2026-09-05 実測・user 指摘) ────────────────────────────────────
 *   要介護度・認定日・認定有効期間・保険者番号・被保険者番号・保険者名・支給限度額・
 *   生年月日・住所は、帳票作成時に認定マスタ (client_insurance_records) / clients から
 *   初期値を写して以来 form_data に文字列として固定され、認定が後から更新されても
 *   保存済みの帳票は古い値のまま — 実データで care-plan-1 122件・service-usage 96件
 *   (計218件) の要介護度食い違いを確認した。
 *
 * ── 方針 ──────────────────────────────────────────────────────────────
 *   ① 保存済みの form_data は消さない (履歴として残す)。
 *   ② 表示・印刷のときはマスタの値を優先して使う (このモジュールが担当)。
 *   ③ 保存値とマスタが食い違うときは画面にだけ通知を出す (印刷には出さない。
 *      呼出側が resolved.changed / collectChangedNotices の結果を画面表示にのみ使うこと)。
 *
 * ── 対象外 (編集できることに意味がある欄。このモジュールでは扱わない) ──────
 *   cert_status (認定済み/申請中の手動切替) / 第2表の変更後要介護度・変更日
 *   (care_level_changed / care_level_change_date)。
 *
 * ── 認定の選び方 ──────────────────────────────────────────────────────
 *   src/lib/careplan-selection.ts (ケアプランの現在選択) と同じ考え方で揃えている:
 *   certification_status='認定済み' の行のうち certification_start_date が最も新しい
 *   ものを選ぶ。
 *   ⚠⚠⚠ 既知の限界 (careplan-selection.ts と同型) ⚠⚠⚠
 *   certification_end_date (認定の有効期限) を一切見ない。期限切れの認定でも
 *   start_date が新しければ選ばれてしまう。直さない (今回は測るだけ・user判断待ち)。
 *   直すときは両ファイルを揃えて更新すること。
 */

export interface CertMasterLike {
  certification_start_date: string | null;
  certification_status: string | null;
}

/**
 * client_insurance_records の行群から「現在の認定」を選ぶ。
 * certification_status==='認定済み' が1件も無ければ null。
 */
export function selectCurrentCertForClient<T extends CertMasterLike>(certs: T[]): T | null {
  const active = certs.filter((c) => c.certification_status === "認定済み");
  if (active.length === 0) return null;
  return active.reduce((latest, c) =>
    (c.certification_start_date ?? "") > (latest.certification_start_date ?? "") ? c : latest,
  );
}

export interface ResolvedField {
  /** 表示・印刷に使う値。masterValue があればそちらを優先する */
  value: string;
  /** 保存値とmasterValueが両方あって食い違うか (画面通知の要否) */
  changed: boolean;
  /** 元の保存値 (画面通知の表示用。masterValueが無ければ value と同じ) */
  savedValue: string | null;
}

/**
 * 1欄ぶんの解決。masterValue (フォーマット済み文字列。呼出側が fmtReiwa 等で整形してから渡す)
 * が有れば優先、無ければ保存値にフォールバックする。
 */
export function resolveMasterField(
  masterValue: string | null | undefined,
  savedValue: string | null | undefined,
): ResolvedField {
  const m = masterValue ?? null;
  const s = savedValue ?? null;
  if (m != null && m !== "") {
    return { value: m, changed: s != null && s !== "" && s !== m, savedValue: s };
  }
  return { value: s ?? "", changed: false, savedValue: s };
}

/**
 * 複数欄の resolved 結果から、画面にだけ出す「保存時: X / 現在: Y」通知を組み立てる。
 * 印刷には使わないこと (呼出側が編集画面でのみ表示する)。
 */
export function collectChangedNotices(
  resolved: Record<string, ResolvedField>,
  labels: Record<string, string>,
): string[] {
  const notices: string[] = [];
  for (const [key, r] of Object.entries(resolved)) {
    if (r.changed) {
      const label = labels[key] ?? key;
      notices.push(`${label}: 保存時「${r.savedValue}」→ 現在「${r.value}」`);
    }
  }
  return notices;
}
