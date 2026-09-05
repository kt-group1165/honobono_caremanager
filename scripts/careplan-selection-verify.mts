/**
 * 「現在有効なケアプラン」選択ロジック (src/lib/careplan-selection.ts) の検証
 * (DB不使用・純関数のみ。H割当のシナリオA/B/C/Dを境界値として再現)
 *
 *   npx tsx scripts/careplan-selection-verify.mts
 *
 * ── 背景 ────────────────────────────────────────────────────────────────
 *   2026-09-05: 高品ケアプラン欠落調査で「status='active'のうち start_date が
 *   最新の行を選ぶ、end_date(期限)は一切見ない」という実装を発見。
 *   このファイルは reports/monitoring/support-records/meeting-minutes の
 *   5箇所に散っていたインラインロジックを src/lib/careplan-selection.ts に
 *   統合した後の回帰検査 (2026-09-05 に統合実施。以前は5箇所が別々のコピーだった)。
 */
import { selectCurrentPlanForReports, selectCurrentPlanWithFallback, hasMonitoringInMonth, isExpired, type CarePlanForSelection } from "../src/lib/careplan-selection";

let n = 0, ng = 0;
function eq(label: string, actual: unknown, expected: unknown) {
  n++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) ng++;
  console.log(`  ${ok ? "OK " : "NG "} ${label.padEnd(70)} ${ok ? "" : `実際=${JSON.stringify(actual)} 期待=${JSON.stringify(expected)}`}`);
}

const today = "2026-09-05"; // 参考: 実装は new Date() を直接使うのでこの値自体はテストに使わない
void today;

const P = (id: string, status: string | null, start_date: string | null): CarePlanForSelection => ({ id, status, start_date });

console.log("═══ シナリオA: 期限切れの計画しか無い ═══");
{
  // 実装は end_date を見ないので、期限切れでも status='active' なら選ばれてしまう
  const plans = [P("expired-only", "active", "2026-01-01")]; // end_date は型に無い(見ていないことの裏返し)
  eq("reports: 期限切れでも status=active なら選ばれる (end_date未チェックの実証)", selectCurrentPlanForReports(plans)?.id, "expired-only");
  eq("monitoring/support-records: 同様に選ばれる", selectCurrentPlanWithFallback(plans)?.id, "expired-only");
}

console.log("\n═══ シナリオB: 期限切れ(新しいstart_date) + 現在有効(古いstart_date) ═══");
{
  // start_date が新しい方が無条件に勝つ。期限切れ(expired)の方がstart_dateが新しい設定。
  const plans = [P("expired-newer", "active", "2026-08-01"), P("valid-older", "active", "2026-06-01")];
  eq("reports: start_date が新しい期限切れの方が選ばれる (期限切れが勝つ=バグの実証)", selectCurrentPlanForReports(plans)?.id, "expired-newer");
  eq("monitoring/support-records: 同様 (配列はstart_date降順で渡す前提)", selectCurrentPlanWithFallback(plans)?.id, "expired-newer");
  // 逆順 (valid の方がstart_dateが新しい) なら正しく valid が選ばれることも確認 (対照)
  const plans2 = [P("valid-newer", "active", "2026-08-01"), P("expired-older", "active", "2026-06-01")];
  eq("対照: valid の方がstart_dateが新しければ正しく選ばれる", selectCurrentPlanForReports(plans2)?.id, "valid-newer");
}

console.log("\n═══ シナリオC: status='completed' しか無い ═══");
{
  const plans = [P("completed-only", "completed", "2026-06-01")];
  eq("① reports: active が無いので null (呼出側は空プランを自動生成する)", selectCurrentPlanForReports(plans), null);
  eq("② monitoring/support-records: 1件でもあるのでフォールバックで拾う (空にならない)", selectCurrentPlanWithFallback(plans)?.id, "completed-only");
}

console.log("\n═══ シナリオD: 計画が0件 ═══");
{
  const plans: CarePlanForSelection[] = [];
  eq("reports: null (正常系。空プラン自動生成のトリガーだが0件自体は正しい判定)", selectCurrentPlanForReports(plans), null);
  eq("monitoring/support-records: null (「有効なケアプランがありません」が正しく出る)", selectCurrentPlanWithFallback(plans), null);
}

console.log("\n═══ 追加境界: null status が混在 (実データでは本来あり得ない。防御的に確認) ═══");
{
  // kaigo_care_plans.status は NOT NULL 制約があり実データにnullは無いことを実機で確認済み (2026-09-05)。
  // それでも関数自体がnullを安全に扱うかは確認しておく。
  const plans = [P("null-status", null, "2026-08-01"), P("active-older", "active", "2026-06-01")];
  eq("reports: null-statusは対象外、activeのみから選ぶ", selectCurrentPlanForReports(plans)?.id, "active-older");
  eq("monitoring/support-records: activeを優先 (nullはfallbackにも使われない。配列に他のactiveがあるため)", selectCurrentPlanWithFallback(plans)?.id, "active-older");
  // null-statusしか無いケース (フォールバックがnull-statusの行を拾うか)
  const plans2 = [P("null-only", null, "2026-08-01")];
  eq("monitoring/support-records: activeが無ければnull-statusでもfallbackで拾う", selectCurrentPlanWithFallback(plans2)?.id, "null-only");
}

console.log("\n═══ 負のコントロール (ロジックを壊して検出できるか) ═══");
{
  // ① end_dateチェックを"追加した"つもりのロジックと、いまの実装(未チェック)を区別できるか
  const plans = [P("expired-newer", "active", "2026-08-01"), P("valid-older", "active", "2026-06-01")];
  const withEndDateCheck = (arr: CarePlanForSelection[]) => arr.find((p) => p.id === "valid-older"); // 「期限切れを除外した」体の壊れた実装
  const real = selectCurrentPlanForReports(plans);
  const broken = withEndDateCheck(plans);
  n++;
  if (real?.id !== broken?.id) {
    console.log(`  OK  負のコントロール — 現実装(${real?.id})と「期限切れ除外版」(${broken?.id})が別の結果になることを確認 (テストが実際に end_date 未チェックを検出している)`);
  } else {
    ng++;
    console.log(`  NG  負のコントロール失敗 — 期限切れ除外の有無で結果が変わらない`);
  }
}

console.log("\n═══ 「今月未登録」警告の判定 (hasMonitoringInMonth) — H割当・モニタリング連鎖確認 ═══");
{
  eq("今月の日付があれば true (警告が消える)", hasMonitoringInMonth([{ monitoring_date: "2026-09-10" }], "2026-09"), true);
  eq("今月の日付が無ければ false (警告が出る)", hasMonitoringInMonth([{ monitoring_date: "2026-08-31" }], "2026-09"), false);
  eq("空配列は false", hasMonitoringInMonth([], "2026-09"), false);
  eq("monitoring_date=null は無視される", hasMonitoringInMonth([{ monitoring_date: null }], "2026-09"), false);
  eq("月初日ちょうど", hasMonitoringInMonth([{ monitoring_date: "2026-09-01" }], "2026-09"), true);
  eq("前月末日は含まない (境界)", hasMonitoringInMonth([{ monitoring_date: "2026-08-31" }, { monitoring_date: "2026-10-01" }], "2026-09"), false);
  eq("複数件中1件でも今月なら true", hasMonitoringInMonth([{ monitoring_date: "2026-01-01" }, { monitoring_date: "2026-09-20" }], "2026-09"), true);
}

console.log("\n═══ isExpired (案B: 期限切れ警告の判定) — 境界値 ═══");
{
  const TODAY = "2026-09-05";
  eq("前日 (end_date=昨日) → 期限切れ", isExpired("2026-09-04", TODAY), true);
  eq("当日 (end_date=今日) → 期限切れではない (その日いっぱい有効)", isExpired("2026-09-05", TODAY), false);
  eq("翌日 (end_date=明日) → 期限切れではない", isExpired("2026-09-06", TODAY), false);
  eq("end_date=null → 期限切れではない (期限なし)", isExpired(null, TODAY), false);
  eq("遠い過去 → 期限切れ", isExpired("2020-01-01", TODAY), true);
  eq("遠い未来 → 期限切れではない", isExpired("2030-01-01", TODAY), false);
}
{
  // 負のコントロール: 「当日を期限切れに含める」誤実装(<=)にすると当日ケースの結果が変わることを確認
  const TODAY = "2026-09-05";
  const buggyInclusive = (endDate: string | null, today: string) => endDate != null && endDate <= today;
  const real = isExpired("2026-09-05", TODAY);
  const buggy = buggyInclusive("2026-09-05", TODAY);
  n++;
  if (real !== buggy) {
    console.log(`  OK  負のコントロール — 現実装(当日=期限切れでない:${real})と「当日を含める」誤実装(${buggy})が別の結果 (境界値テストが機能している)`);
  } else {
    ng++;
    console.log(`  NG  負のコントロール失敗 — 当日の扱いで結果が変わらない`);
  }
}

console.log(`\n══ 検査 ${n} 件 / NG ${ng} 件 ══`);
if (ng > 0) process.exitCode = 1;
