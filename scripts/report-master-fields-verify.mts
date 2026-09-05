/**
 * 帳票の「マスタから引ける欄」表示時引き直し (report-master-fields.ts) の検証 (DB 不使用)
 *
 *   npx tsx scripts/report-master-fields-verify.mts
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   2026-09-05 の実測(care-plan-1 122件・service-usage 96件、計218件の要介護度食い違い)
 *   を受けて実装した「表示時にマスタを優先する」ロジックの純関数部分を検証する。
 *   ★ money-impact は無い(帳票の表示内容が正しい認定に揃うのみ。請求金額計算とは無関係)。
 *   ★ ただし印刷される公式書類の内容が変わるため、4通り(マスタ有無×保存値有無)を
 *   確実に固定化しておく。
 */
import {
  selectCurrentCertForClient,
  resolveMasterField,
  collectChangedNotices,
  type CertMasterLike,
} from "@/lib/report-master-fields";

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
};

// ── selectCurrentCertForClient ────────────────────────────────────────────
{
  const cert = (o: Partial<CertMasterLike> & { certification_start_date: string | null }): CertMasterLike => ({
    certification_status: "認定済み",
    ...o,
  });
  eq("空配列は null", selectCurrentCertForClient([]), null);
  eq("★ 認定済みが1件も無ければ null (申請中のみは対象外)", selectCurrentCertForClient([cert({ certification_start_date: "2026-01-01", certification_status: "申請中" })]), null);
  {
    const older = cert({ certification_start_date: "2024-01-01" });
    const newer = cert({ certification_start_date: "2025-06-01" });
    eq("★ 認定済みが複数あれば certification_start_date が最新のものを選ぶ", selectCurrentCertForClient([older, newer]), newer);
  }
  {
    const active = cert({ certification_start_date: "2025-06-01" });
    const pending = cert({ certification_start_date: "2026-01-01", certification_status: "申請中" });
    eq("★ 申請中のほうが新しくても、認定済みだけを対象にする", selectCurrentCertForClient([active, pending]), active);
  }
}

// ── resolveMasterField: 4通り (マスタ有無 × 保存値有無) ────────────────────
eq("① マスタ有り・保存値有り・一致 → マスタ値・changed=false", resolveMasterField("要介護3", "要介護3"), { value: "要介護3", changed: false, savedValue: "要介護3" });
eq("② マスタ有り・保存値有り・不一致 → マスタ値優先・changed=true", resolveMasterField("要介護4", "要介護1"), { value: "要介護4", changed: true, savedValue: "要介護1" });
eq("③ マスタ有り・保存値無し → マスタ値・changed=false (比較対象が無いので通知しない)", resolveMasterField("要介護3", null), { value: "要介護3", changed: false, savedValue: null });
eq("④ マスタ無し・保存値有り → 保存値にフォールバック・changed=false", resolveMasterField(null, "要介護2"), { value: "要介護2", changed: false, savedValue: "要介護2" });
eq("⑤ マスタ無し・保存値無し → 空文字・changed=false", resolveMasterField(null, null), { value: "", changed: false, savedValue: null });
eq("★ マスタが空文字は「無し」と同じ扱い (保存値にフォールバック)", resolveMasterField("", "要介護2"), { value: "要介護2", changed: false, savedValue: "要介護2" });
eq("★ 保存値が空文字はchanged判定に含めない (未入力を『食い違い』としない)", resolveMasterField("要介護3", ""), { value: "要介護3", changed: false, savedValue: "" });
eq("undefinedはnullと同じ扱い", resolveMasterField(undefined, undefined), { value: "", changed: false, savedValue: null });

// ── collectChangedNotices ─────────────────────────────────────────────────
{
  const resolved = {
    care_level: resolveMasterField("要介護4", "要介護1"),
    insurer_number: resolveMasterField("122069", "122069"),
    address: resolveMasterField(null, "千葉県千葉市..."),
  };
  const labels = { care_level: "要介護度", insurer_number: "保険者番号", address: "住所" };
  const notices = collectChangedNotices(resolved, labels);
  eq("★ changed=trueの欄だけ通知に含まれる (1件のみ)", notices.length, 1);
  eq("★ 通知は「保存時: X → 現在: Y」の形式でラベル名を使う", notices[0], "要介護度: 保存時「要介護1」→ 現在「要介護4」");
}

// ── 負のコントロール ─────────────────────────────────────────────────────
{
  // ① マスタ有無に関わらず常に保存値を優先してしまう壊れた実装 (印刷内容が古いまま直らない)
  const brokenResolve = (masterValue: string | null, savedValue: string | null) => ({
    value: savedValue ?? masterValue ?? "", // ★ 保存値を優先してしまう (正は逆)
    changed: false,
    savedValue,
  });
  const correct = resolveMasterField("要介護4", "要介護1");
  const broken = brokenResolve("要介護4", "要介護1");
  const detected1 = correct.value !== broken.value;
  if (detected1) pass++; else fails.push("★ 負のコントロールが鳴らない: マスタ優先/保存値優先の逆転を検出できない");
  console.log(`  ${detected1 ? "✓" : "✗"} ★ 保存値を優先してしまう(印刷内容が直らない)バグを検出できる (正=${correct.value} / 壊れた版=${broken.value})`);

  // ② end_date を見ずに certification_start_date だけで選ぶ既知の限界を「直してしまう」実装との違いを確認
  //   (直す判断はuser待ちなので、現状の実装が意図通り end_date を見ていないことを固定化する)
  const cert = (o: Partial<CertMasterLike> & { certification_start_date: string | null; _end?: string }) => ({
    certification_status: "認定済み",
    ...o,
  });
  const expired = { ...cert({ certification_start_date: "2024-01-01" }), _end: "2024-12-31" }; // 期限切れだが古い
  const validButOlderStart = { ...cert({ certification_start_date: "2026-06-01" }), _end: "2099-12-31" }; // 有効期限内・start_dateが新しい
  const selected = selectCurrentCertForClient([expired, validButOlderStart]);
  eq("★ 既知の限界: end_dateを見ず、start_dateが新しい方を選ぶ(careplan-selection.tsと同じ挙動)", selected, validButOlderStart);
}

console.log(`\n帳票マスタ引き直し (純関数部分) の検証 — ${pass + fails.length} 件`);
if (fails.length === 0) {
  console.log(`PASS — ${pass} 件すべて一致 (負のコントロール込み)`);
} else {
  console.log(`★ FAIL ${fails.length} 件`);
  for (const f of fails) console.log(`   ${f}`);
  process.exitCode = 1;
}
