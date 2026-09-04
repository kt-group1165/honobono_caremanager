/**
 * _sample_data.mjs の自己テスト。
 * ★ 「入れる前に消せることを確認する」(SAMPLE_DATA_PROTOCOL 4章) を実際にやる。
 *   1) 撤去 (0件のはず)  2) 1名投入  3) 引けることを確認  4) 撤去  5) 0件を確認
 * node migrations/_sample_data_selftest.mjs            # DRY RUN
 * node migrations/_sample_data_selftest.mjs --execute
 */
import { sb, MONTH, sampleClient, sampleInsurance,
         sampleAssignment, insertRows, deleteByTag, assertSafeMonth, LIMIT_UNITS } from "./_sample_data.mjs";

const EXEC = process.argv.includes("--execute");
const TAG = "h";
assertSafeMonth(MONTH);
console.log(`対象月 ${MONTH} / タグ ${TAG} / ${EXEC ? "★ 本番実行" : "DRY RUN"}\n`);

console.log("── 1) 事前撤去 ──");
await deleteByTag(TAG, { dryRun: !EXEC });

console.log("\n── 2) 実在する事業所を1つ引く (offices は変更しない) ──");
const { data: offs, error: oe } = await sb.from("offices")
  .select("id,name,business_number").not("business_number", "is", null).limit(1);
if (oe) throw new Error(`offices 取得失敗: ${oe.message}`);
if (!offs?.length) throw new Error("business_number を持つ office が無い");
console.log(`  ${offs[0].name} (${offs[0].business_number})`);

console.log("\n── 3) 投入 ──");
const c = sampleClient({ tag: TAG, seq: 1, careLevel: "要介護3", copayIdx: 1 });
console.log(`  user_number=${c.user_number} name=${c.name} care_level=${c.care_level} copay=${c.copay_rate}`);
const [cid] = await insertRows("clients", [c], { dryRun: !EXEC });
if (EXEC) {
  await insertRows("client_insurance_records", [sampleInsurance(cid, { careLevel: "要介護3", copayIdx: 1 })], { dryRun: false });
  await insertRows("client_office_assignments", [sampleAssignment(cid, offs[0].id)], { dryRun: false });
}

console.log("\n── 4) 引けることを確認 ──");
if (EXEC) {
  const { data: got, error: ge } = await sb.from("clients")
    .select("id,user_number,name,care_level,client_insurance_records(service_limit_amount)")
    .eq("id", cid).single();
  if (ge) throw new Error(`確認失敗: ${ge.message}`);
  const lim = got.client_insurance_records?.[0]?.service_limit_amount;
  const want = LIMIT_UNITS["要介護3"];
  console.log(`  ${got.user_number} ${got.name} ${got.care_level} 限度額=${lim} (告示値 ${want}) ${lim === want ? "✅" : "★ 不一致"}`);
  if (lim !== want) throw new Error("限度額が告示値と一致しない");
} else console.log("  [DRY] スキップ");

console.log("\n── 5) 撤去 ──");
await deleteByTag(TAG, { dryRun: !EXEC });
console.log(`\n${EXEC ? "✅ 往復が成立。共通基盤は使える" : "DRY RUN 完了。--execute で実行"}`);
