/**
 * 認定期限接近アラート (cert-expiry-alert.ts) の純関数部分の検証 (DB 不使用)
 *
 *   npx tsx scripts/cert-expiry-alert-verify.mts
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   段階判定 (expired/within30/within60) と更新申請済み除外のロジックは
 *   scanCertExpiry (DBループの中) に埋め込まれており、ハーネスから呼べな
 *   かった。★ 今回 resolveClientCertAlert として切り出した (挙動不変)。
 *   段階の境界を間違えると「気づく仕組み」自体が黙って機能しなくなる
 *   (アラートが出ない、または既に対応済みの利用者に出続ける)。
 *
 *   規則 (ファイル冒頭コメント通り):
 *     段階: end < 今日 → expired / 今日+30日以内 → within30 / +60日以内 → within60
 *     除外: 「申請中」の新しい行、または start が新しい「認定済み」行があれば
 *           アラートしない (更新済み/申請済み)
 */
import {
  resolveClientCertAlert,
  buildCertAlertMessage,
  isCertAlertNotification,
  CERT_ALERT_REF_TABLE,
  type CertExpiryAlert,
} from "@/lib/cert-expiry-alert";

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
};

type Row = {
  id: string;
  client_id: string;
  certification_status: string | null;
  certification_start_date: string | null;
  certification_end_date: string | null;
  care_level: string | null;
};
const row = (o: Partial<Row> & { id: string }): Row => ({
  client_id: "c1",
  certification_status: "認定済み",
  certification_start_date: null,
  certification_end_date: null,
  care_level: "要介護1",
  ...o,
});

// 基準日を 2026-06-15 に固定 (テストの再現性のため)
const todayIso = "2026-06-15";
const plus30 = "2026-07-15";
const plus60 = "2026-08-14";
const todayMid = new Date(2026, 5, 15).getTime();
const ctx = { todayIso, plus30, plus60, todayMid };

// ── 段階の境界 (expired / within30 / within60 / 対象外) ─────────────────
eq("★ end が今日の前日 → expired", resolveClientCertAlert([row({ id: "a", certification_end_date: "2026-06-14" })], ctx)?.stage, "expired");
eq("★ end が今日ちょうど → expired ではない (< today のみが expired)", resolveClientCertAlert([row({ id: "a", certification_end_date: "2026-06-15" })], ctx)?.stage, "within30");
eq("★ end が +30日ちょうど → within30 (境界含む)", resolveClientCertAlert([row({ id: "a", certification_end_date: "2026-07-15" })], ctx)?.stage, "within30");
eq("★ end が +31日 → within60 (境界の次)", resolveClientCertAlert([row({ id: "a", certification_end_date: "2026-07-16" })], ctx)?.stage, "within60");
eq("★ end が +60日ちょうど → within60 (境界含む)", resolveClientCertAlert([row({ id: "a", certification_end_date: "2026-08-14" })], ctx)?.stage, "within60");
eq("★ end が +61日 → 対象外 (null)", resolveClientCertAlert([row({ id: "a", certification_end_date: "2026-08-15" })], ctx), null);

// ── 対象外の条件 ─────────────────────────────────────────────────────────
eq("certification_end_date が未入力 (期限なし) は対象外", resolveClientCertAlert([row({ id: "a", certification_end_date: null })], ctx), null);
eq("certification_status が「認定済み」以外しかない (申請中のみ) は対象外", resolveClientCertAlert([row({ id: "a", certification_status: "申請中", certification_end_date: "2026-06-20" })], ctx), null);
eq("start が未来 (まだ始まっていない認定) は現在の認定にならず対象外", resolveClientCertAlert([row({ id: "a", certification_start_date: "2026-07-01", certification_end_date: "2026-06-20" })], ctx), null);
eq("start が今日ちょうどは「現在」に含まれる", resolveClientCertAlert([row({ id: "a", certification_start_date: "2026-06-15", certification_end_date: "2026-06-20" })], ctx)?.stage, "within30");
eq("行が空配列なら対象外", resolveClientCertAlert([], ctx), null);

// ── 更新申請済み / 更新決定済みの除外 ─────────────────────────────────────
{
  const current = row({ id: "cur", certification_start_date: "2026-01-01", certification_end_date: "2026-06-20" });
  eq("★ 申請中の新しい行 (start未入力) があれば除外", resolveClientCertAlert([current, row({ id: "new", certification_status: "申請中", certification_start_date: null })], ctx), null);
  eq("★ 申請中の新しい行 (start が現認定より後) があれば除外", resolveClientCertAlert([current, row({ id: "new", certification_status: "申請中", certification_start_date: "2026-06-01" })], ctx), null);
  eq("申請中でも start が現認定より前 (古い申請) なら除外しない", resolveClientCertAlert([current, row({ id: "old", certification_status: "申請中", certification_start_date: "2025-12-01" })], ctx)?.stage, "within30");
  eq("★ 認定済みで start が現認定より後 (更新決定済み) があれば除外", resolveClientCertAlert([current, row({ id: "new2", certification_status: "認定済み", certification_start_date: "2026-07-01" })], ctx), null);
  eq("認定済みで start が現認定より前 (過去の認定) なら除外しない", resolveClientCertAlert([current, row({ id: "old2", certification_status: "認定済み", certification_start_date: "2025-01-01" })], ctx)?.stage, "within30");
  eq("却下・取下げ等 (認定済みでも申請中でもないステータス) は除外条件にならない", resolveClientCertAlert([current, row({ id: "x", certification_status: "却下", certification_start_date: "2026-06-10" })], ctx)?.stage, "within30");
}

// ── 「現在の認定」の選択 (start DESC で最新を採る) ───────────────────────
{
  const older = row({ id: "older", certification_start_date: "2024-01-01", certification_end_date: "2025-12-31" }); // 既に期限切れの古い認定
  const newer = row({ id: "newer", certification_start_date: "2025-06-01", certification_end_date: "2026-06-20" }); // こちらが「現在」
  const resolved = resolveClientCertAlert([older, newer], ctx);
  eq("★ 複数行あれば start が最新の行を「現在の認定」として採る", resolved?.certId, "newer");
}

// ── daysLeft の計算 ──────────────────────────────────────────────────────
eq("daysLeft: +30日ちょうどなら30", resolveClientCertAlert([row({ id: "a", certification_end_date: "2026-07-15" })], ctx)?.daysLeft, 30);
eq("★ daysLeft: 期限切れは負の日数 (経過日数)", resolveClientCertAlert([row({ id: "a", certification_end_date: "2026-06-10" })], ctx)?.daysLeft, -5);

// ── buildCertAlertMessage ────────────────────────────────────────────────
{
  const alert: CertExpiryAlert = { clientId: "c1", clientName: "田中太郎", certId: "cert1", careLevel: "要介護2", certEndDate: "2026-06-20", stage: "expired", daysLeft: -5 };
  const msg = buildCertAlertMessage(alert, false);
  eq("expired: タイトルに満了日を含む", msg.title.includes("6/20"), true);
  eq("expired: 本文に「期限切れ」を含む", msg.body.includes("期限切れ"), true);
  eq("居宅介護支援以外は「ケアプラン見直し」を含まない", msg.body.includes("ケアプラン見直し"), false);

  const alertWithin: CertExpiryAlert = { ...alert, stage: "within30", daysLeft: 25 };
  const msgCM = buildCertAlertMessage(alertWithin, true);
  eq("★ isCareManagement=true は「ケアプラン見直し」を含む", msgCM.body.includes("ケアプラン見直し"), true);
  eq("within系: タイトルに残り日数を含む", msgCM.title.includes("残25日"), true);
}

// ── isCertAlertNotification ──────────────────────────────────────────────
eq("cert_expired + 正しいref_table + ref_idあり は true", isCertAlertNotification({ type: "cert_expired", ref_table: CERT_ALERT_REF_TABLE, ref_id: "x" }), true);
eq("★ ref_id が無ければ false (クリック遷移先が無いので)", isCertAlertNotification({ type: "cert_expired", ref_table: CERT_ALERT_REF_TABLE, ref_id: null }), false);
eq("★ ref_table が違えば false (他の通知種別と混同しない)", isCertAlertNotification({ type: "cert_expired", ref_table: "other_table", ref_id: "x" }), false);
eq("認定アラート以外の type は false", isCertAlertNotification({ type: "other_notification", ref_table: CERT_ALERT_REF_TABLE, ref_id: "x" }), false);

// ── 負のコントロール ─────────────────────────────────────────────────────
{
  // ① within30/60 の境界を < にする (= ちょうど30日後を除外してしまう) 壊れた実装
  const brokenStage = (end: string): string | null => {
    if (end < todayIso) return "expired";
    if (end < plus30) return "within30"; // ★ わざと < にする (正は <=)
    if (end < plus60) return "within60";
    return null;
  };
  const correct = resolveClientCertAlert([row({ id: "a", certification_end_date: "2026-07-15" })], ctx)?.stage;
  const broken = brokenStage("2026-07-15");
  const detected1 = correct !== broken;
  if (detected1) pass++; else fails.push("★ 負のコントロールが鳴らない: 境界(<=)の違いを検出できない");
  console.log(`  ${detected1 ? "✓" : "✗"} ★ 境界を<=から<にする(ちょうど30日後を見逃す)バグを検出できる (正=${correct} / 壊れた版=${broken})`);

  // ② 更新申請済み除外を実装しない壊れた実装 (既に対応済みの利用者にも出続ける)
  const current = row({ id: "cur", certification_start_date: "2026-01-01", certification_end_date: "2026-06-20" });
  const withRenewal = [current, row({ id: "new", certification_status: "申請中", certification_start_date: null })];
  const correctResolved = resolveClientCertAlert(withRenewal, ctx);
  // 壊れた版: 除外ロジックを持たないので単純に current だけで stage を出す
  const curEnd = current.certification_end_date!;
  const brokenResolved = curEnd < todayIso ? "expired" : curEnd <= plus30 ? "within30" : "within60";
  const detected2 = correctResolved === null && brokenResolved !== null;
  if (detected2) pass++; else fails.push("★ 負のコントロールが鳴らない: 更新申請済み除外の有無を検出できない");
  console.log(`  ${detected2 ? "✓" : "✗"} ★ 更新申請済み除外を忘れるバグを検出できる (正=${JSON.stringify(correctResolved)} / 壊れた版=${brokenResolved})`);
}

console.log(`\n認定期限接近アラート (純関数部分) の検証 — ${pass + fails.length} 件`);
if (fails.length === 0) {
  console.log(`PASS — ${pass} 件すべて一致 (負のコントロール込み)`);
} else {
  console.log(`★ FAIL ${fails.length} 件`);
  for (const f of fails) console.log(`   ${f}`);
  process.exitCode = 1;
}
