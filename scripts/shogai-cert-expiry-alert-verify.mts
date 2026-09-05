/**
 * 障害受給者証の期限接近アラート (shogai-cert-expiry-alert.ts) の
 * 純関数部分の検証 (DB 不使用)
 *
 *   npx tsx scripts/shogai-cert-expiry-alert-verify.mts
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   ファイル冒頭コメント: cert-expiry-alert.ts (介護保険版) は
 *   client_insurance_records しか見ておらず「障害受給者証にはアラートが
 *   1つも無かった」。実測 134名が期限切れなのに構造的に検知していなかった
 *   (2026-09-03 発見)。切れたまま請求すると返戻になる。
 *
 *   介護保険版との違い: shougai_certifications には certification_status
 *   列が無いため、「より新しい証があるか」だけで更新済みを判定する
 *   (介護保険版の「申請中の行があれば除外」は使えない)。
 *
 *   段階判定・除外ロジックは scanShogaiCertExpiry (DBループの中) に埋め
 *   込まれておりハーネスから呼べなかったため、
 *   resolveClientShogaiCertAlert として切り出した (挙動不変)。
 */
import {
  resolveClientShogaiCertAlert,
  buildShogaiCertAlertMessage,
  isShogaiCertAlertNotification,
  SHOGAI_CERT_ALERT_REF_TABLE,
  type ShogaiCertAlert,
} from "@/lib/shogai-cert-expiry-alert";

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
};

type Row = {
  id: string;
  client_id: string;
  certification_start_date: string | null;
  certification_end_date: string | null;
  support_level: string | null;
  beneficiary_number: string | null;
};
const row = (o: Partial<Row> & { id: string }): Row => ({
  client_id: "c1",
  certification_start_date: null,
  certification_end_date: null,
  support_level: "区分4",
  beneficiary_number: "1234567890",
  ...o,
});

const todayIso = "2026-06-15";
const plus30 = "2026-07-15";
const plus60 = "2026-08-14";
const todayMid = new Date(2026, 5, 15).getTime();
const ctx = { todayIso, plus30, plus60, todayMid };

// ── 段階の境界 (介護保険版と同じ境界規則) ────────────────────────────────
eq("★ end が今日の前日 → expired", resolveClientShogaiCertAlert([row({ id: "a", certification_end_date: "2026-06-14" })], ctx)?.stage, "expired");
eq("★ end が今日ちょうど → expired ではない", resolveClientShogaiCertAlert([row({ id: "a", certification_end_date: "2026-06-15" })], ctx)?.stage, "within30");
eq("★ end が+30日ちょうど → within30 (境界含む)", resolveClientShogaiCertAlert([row({ id: "a", certification_end_date: "2026-07-15" })], ctx)?.stage, "within30");
eq("★ end が+31日 → within60", resolveClientShogaiCertAlert([row({ id: "a", certification_end_date: "2026-07-16" })], ctx)?.stage, "within60");
eq("★ end が+60日ちょうど → within60 (境界含む)", resolveClientShogaiCertAlert([row({ id: "a", certification_end_date: "2026-08-14" })], ctx)?.stage, "within60");
eq("★ end が+61日 → 対象外", resolveClientShogaiCertAlert([row({ id: "a", certification_end_date: "2026-08-15" })], ctx), null);

// ── 対象外の条件 ─────────────────────────────────────────────────────────
eq("certification_end_date 未入力は対象外", resolveClientShogaiCertAlert([row({ id: "a", certification_end_date: null })], ctx), null);
eq("start が未来 (まだ始まっていない証) は現在の証にならず対象外", resolveClientShogaiCertAlert([row({ id: "a", certification_start_date: "2026-07-01", certification_end_date: "2026-06-20" })], ctx), null);
eq("空配列は対象外", resolveClientShogaiCertAlert([], ctx), null);

// ── ★ 更新済み除外 (status列が無いのでstartの新旧だけで判定) ─────────────
{
  const current = row({ id: "cur", certification_start_date: "2026-01-01", certification_end_date: "2026-06-20" });
  eq("★ start が現在の証より新しい行があれば除外 (status列に依らない)", resolveClientShogaiCertAlert([current, row({ id: "new", certification_start_date: "2026-06-01" })], ctx), null);
  eq("start が現在の証より古い行があっても除外しない", resolveClientShogaiCertAlert([current, row({ id: "old", certification_start_date: "2025-01-01" })], ctx)?.stage, "within30");
  eq("★ 介護保険版と違い certification_status の区別が無い (新しければ無条件に除外)", resolveClientShogaiCertAlert([current, row({ id: "new2", certification_start_date: "2026-06-10" })], ctx), null);
}

// ── 「現在の証」の選択 ───────────────────────────────────────────────────
{
  const older = row({ id: "older", certification_start_date: "2024-01-01", certification_end_date: "2025-12-31" });
  const newer = row({ id: "newer", certification_start_date: "2025-06-01", certification_end_date: "2026-06-20" });
  eq("複数行あれば start が最新の行を「現在の証」として採る", resolveClientShogaiCertAlert([older, newer], ctx)?.certId, "newer");
}

// ── daysLeft ─────────────────────────────────────────────────────────────
eq("daysLeft: +30日ちょうどなら30", resolveClientShogaiCertAlert([row({ id: "a", certification_end_date: "2026-07-15" })], ctx)?.daysLeft, 30);
eq("★ daysLeft: 期限切れは負の日数", resolveClientShogaiCertAlert([row({ id: "a", certification_end_date: "2026-06-10" })], ctx)?.daysLeft, -5);

// ── buildShogaiCertAlertMessage ──────────────────────────────────────────
{
  const alert: ShogaiCertAlert = { clientId: "c1", clientName: "山田花子", certId: "cert1", supportLevel: "区分5", beneficiaryNumber: "9999999999", certEndDate: "2026-06-20", stage: "expired", daysLeft: -5 };
  const msg = buildShogaiCertAlertMessage(alert);
  eq("expired: 本文に「期限切れ」を含む", msg.body.includes("期限切れ"), true);
  eq("★ 本文に返戻の注意喚起を含む (介護保険版には無い文言)", msg.body.includes("返戻"), true);
  const within = buildShogaiCertAlertMessage({ ...alert, stage: "within30", daysLeft: 25 });
  eq("within系: タイトルに残り日数を含む", within.title.includes("残25日"), true);
}

// ── isShogaiCertAlertNotification ────────────────────────────────────────
eq("shogai_cert_expired + 正しいref_table + ref_idあり は true", isShogaiCertAlertNotification({ type: "shogai_cert_expired", ref_table: SHOGAI_CERT_ALERT_REF_TABLE, ref_id: "x" }), true);
eq("★ ref_table が介護保険版 (client_insurance_records) だと false (混同しない)", isShogaiCertAlertNotification({ type: "shogai_cert_expired", ref_table: "client_insurance_records", ref_id: "x" }), false);
eq("ref_id 無しは false", isShogaiCertAlertNotification({ type: "shogai_cert_expired", ref_table: SHOGAI_CERT_ALERT_REF_TABLE, ref_id: null }), false);
eq("介護保険版のtype (cert_expired) は false (プレフィックスが違う)", isShogaiCertAlertNotification({ type: "cert_expired", ref_table: SHOGAI_CERT_ALERT_REF_TABLE, ref_id: "x" }), false);

// ── 負のコントロール ─────────────────────────────────────────────────────
{
  // ① 更新済み除外を実装しない壊れた実装 (返戻確定なのにアラートが出続ける懸念の逆: 更新後も出続ける)
  const current = row({ id: "cur", certification_start_date: "2026-01-01", certification_end_date: "2026-06-20" });
  const withNewer = [current, row({ id: "new", certification_start_date: "2026-06-01" })];
  const correct = resolveClientShogaiCertAlert(withNewer, ctx);
  const curEnd = current.certification_end_date!;
  const broken = curEnd < todayIso ? "expired" : curEnd <= plus30 ? "within30" : "within60"; // 除外ロジック無し
  const detected1 = correct === null && broken !== null;
  if (detected1) pass++; else fails.push("★ 負のコントロールが鳴らない: 更新済み除外の有無を検出できない");
  console.log(`  ${detected1 ? "✓" : "✗"} ★ 更新済み除外を忘れるバグを検出できる (正=${JSON.stringify(correct)} / 壊れた版=${broken})`);

  // ② 介護保険版と障害版の ref_table 定数を取り違える壊れた実装
  const brokenCheck = (n: { type: string; ref_table: string | null; ref_id: string | null }) =>
    n.ref_table === "client_insurance_records"; // ★ 介護保険版の定数を誤って使う
  const notif = { type: "shogai_cert_expired", ref_table: SHOGAI_CERT_ALERT_REF_TABLE, ref_id: "x" };
  const correct2 = isShogaiCertAlertNotification(notif);
  const broken2 = brokenCheck(notif);
  const detected2 = correct2 !== broken2;
  if (detected2) pass++; else fails.push("★ 負のコントロールが鳴らない: ref_table定数の取り違えを検出できない");
  console.log(`  ${detected2 ? "✓" : "✗"} ★ ref_table定数を介護保険版と取り違えるバグを検出できる (正=${correct2} / 壊れた版=${broken2})`);
}

console.log(`\n障害受給者証の期限接近アラート (純関数部分) の検証 — ${pass + fails.length} 件`);
if (fails.length === 0) {
  console.log(`PASS — ${pass} 件すべて一致 (負のコントロール込み)`);
} else {
  console.log(`★ FAIL ${fails.length} 件`);
  for (const f of fails) console.log(`   ${f}`);
  process.exitCode = 1;
}
