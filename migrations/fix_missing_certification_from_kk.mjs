// ============================================================================
// 伝送 KK (7131) には請求されているのに client_insurance_records が0件の利用者に、
// KK 自身が持っている認定情報 (要介護度・認定期間・保険者) を投入する。
//
//   node migrations/fix_missing_certification_from_kk.mjs            # DRY RUN (既定)
//   node migrations/fix_missing_certification_from_kk.mjs --execute  # 本番 INSERT
//
// ── なぜ要るか (2026-09-05 H割当「型L まるごと欠落」調査で発見) ──────────────
//   介護保険 7131 突合 (kaigo-densou-diff.mts) の「ほのみ」(=ほのぼのにはあるが
//   当方に無い) 3名は、client / client_office_assignments は★正しく存在するのに
//   client_insurance_records が★0件だった。認定が一度も投入されていないため
//   aggregateMonthlyVisitSeikyu が対象月の有効認定を引けず、実績があっても
//   レセプトに出ない (集計の入口で弾かれる)。
//
// ── 何を根拠に入れるか ──────────────────────────────────────────────────
//   ほのぼの自身が 7131 基本レコード (項14 生年月日 / 項16 要介護度コード /
//   項19-20 認定有効期間 / 項7 保険者番号) に書いている値をそのまま使う。
//   推測ではなく、ほのぼのの請求データそのもの (fix_missing_office_assignment_
//   from_billing_list.mjs と同じ「ほのぼのが書いている = 確定情報」という考え方)。
//
// ⚠ 対象は下記 3 名のみ (型L調査で個別に生年月日突合まで済ませたもの)。
//   汎用スキャナではない — 突合していない利用者を勝手に拾わないこと。
//   要介護度コード→表記は build.ts の CARE_LEVEL_CODE の逆引き (21〜25=要介護1〜5)。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const env = Object.fromEntries(
  readFileSync(fileURLToPath(new URL("../.env.local", import.meta.url)), "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const CARE_LEVEL_OF = { "21": "要介護1", "22": "要介護2", "23": "要介護3", "24": "要介護4", "25": "要介護5" };

// 各フィールドの出どころ (ファイル・レコード種別・シリアル番号・項番) を明示する。
// 値は該当行を直接 grep して目視転記したもの (自動抽出ではない)。
const TARGETS = [
  {
    name: "清水 日出男", client_id: "bb7931da-3c9a-4d0b-bf9d-1618ad6f36aa",
    insurer_number: "121046", insurer_name: "千葉市若葉区", insured_number: "1003418405",
    birth_date: "1969-04-11", care_level_code: "25",
    certification_start_date: "2023-05-01", certification_end_date: "2027-04-30",
    source_file: "伝送データ/おゆみ野/訪問介護/介護/202606/ほのぼのから/KK260803.CSV",
    source_record: "レコード種別2 シリアル195 (様式7131 項01)",
    source_line: '2,195,"7131",01,202606,1270501180,00121046,"1003418405",,,,,,,19690411,1,25,,20230501,20270430,1,1270500281,...',
    note: "型L調査(2026-09-05)。★障害側の別件請求漏れ(¥523,298)と同一人物・別問題。",
  },
  {
    name: "川島 新治", client_id: "9b0ede7a-57e8-46e8-8baf-24b88aeda322",
    insurer_number: "121012", insurer_name: "千葉市中央区", insured_number: "1004149827",
    birth_date: "1972-06-24", care_level_code: "25",
    certification_start_date: "2023-05-01", certification_end_date: "2027-04-30",
    source_file: "伝送データ/おゆみ野/訪問介護/介護/202606/ほのぼのから/KK260803.CSV",
    source_record: "レコード種別2 シリアル153 (様式7131 項01)",
    source_line: '2,153,"7131",01,202606,1270501180,00121012,"1004149827",,,,,,,19720624,1,25,,20230501,20270430,1,1270500281,...',
    note: "型L調査(2026-09-05)。",
  },
  {
    name: "中井 光子", client_id: "e8f18c01-930b-4486-af7c-f75a3a1a4c26",
    insurer_number: "121038", insurer_name: "千葉市稲毛区", insured_number: "1001804556",
    birth_date: "1940-09-23", care_level_code: "22",
    certification_start_date: "2026-01-09", certification_end_date: "2026-07-31",
    source_file: "伝送データ/さつきが丘/訪問介護/介護/202606/ほのぼのから/KK260803.CSV",
    source_record: "レコード種別2 シリアル260 (様式7131 項01)",
    source_line: '2,260,"7131",01,202606,1270203191,00121038,"1001804556",,,,,,,19400923,2,22,,20260109,20260731,1,1270301060,...',
    note: "型L調査(2026-09-05)。SESSION_START既知案件(制度未設定の実績10件)の再確認。",
  },
];
// 項番の対応 (7131 様式第二 基本情報レコード。上記CSVの列位置、0始まり):
//   列6=項7 保険者番号(8桁0埋め) / 列7=項8 被保険者番号 / 列14=項14 生年月日(YYYYMMDD)
//   列15=項15 性別 / 列16=項16 要介護状態区分コード / 列18-19=項19-20 認定有効期間(自-至)

console.log(`=== 認定バックフィル (KK由来) ${EXECUTE ? "【本番 EXECUTE — 絶対に自動実行しないこと】" : "【DRY RUN】"} ===\n`);

for (const t of TARGETS) {
  console.log(`── ${t.name} ──────────────────────────────────────────`);
  console.log(`  出どころ: ${t.source_file}`);
  console.log(`           ${t.source_record}`);
  console.log(`           ${t.source_line}`);
  console.log(`  転記値  : 保険者=${t.insurer_name}(${t.insurer_number}) / 被保険者番号=${t.insured_number} / 生年月日=${t.birth_date}`);
  console.log(`           要介護度コード${t.care_level_code}→${CARE_LEVEL_OF[t.care_level_code]} / 認定有効期間 ${t.certification_start_date}〜${t.certification_end_date}`);

  // 二重投入防止 ①: 同一 (insurer_number, insured_number) の行が (client問わず) 既に無いか
  const { data: byInsurance, error: e1 } = await sb
    .from("client_insurance_records")
    .select("id, client_id")
    .eq("insurer_number", t.insurer_number)
    .eq("insured_number", t.insured_number);
  if (e1) throw new Error(`既存確認失敗①(${t.name}): ${e1.message}`);
  // 二重投入防止 ②: 同一 client_id に (保険者問わず) 認定行が本当に0件か
  //   ⚠ H指摘: KKは送信時点の写しなので、その後の認定更新が別の(保険者,被保番)で
  //   既に入っている可能性がある。client_id単位でも確認する。
  const { data: byClient, error: e2 } = await sb
    .from("client_insurance_records")
    .select("id, insurer_number, insured_number, care_level, certification_start_date, certification_end_date")
    .eq("client_id", t.client_id);
  if (e2) throw new Error(`既存確認失敗②(${t.name}): ${e2.message}`);

  if (byInsurance.length > 0) {
    console.log(`  スキップ: (保険者,被保番)一致の行が既に${byInsurance.length}件存在 (二重投入防止①)`);
    continue;
  }
  if (byClient.length > 0) {
    console.log(`  ★要確認・投入せず: このclient_idに★別の(保険者,被保番)で認定が${byClient.length}件既に存在します`);
    console.log(`    ${JSON.stringify(byClient)}`);
    console.log(`    KK由来の値と食い違う可能性があるため、このscriptでは自動投入しない (二重投入防止②)`);
    continue;
  }
  console.log(`  確認: (保険者,被保番)一致0件・client_id全体でも認定0件 (2026-09-05再確認)`);

  const payload = {
    tenant_id: "kt-group",
    client_id: t.client_id,
    effective_date: t.certification_start_date,
    insured_number: t.insured_number,
    insurer_number: t.insurer_number,
    insurer_name: t.insurer_name,
    care_level: CARE_LEVEL_OF[t.care_level_code],
    certification_start_date: t.certification_start_date,
    certification_end_date: t.certification_end_date,
    certification_status: "認定済み",
    record_status: "認定済み",
    copay_rate: "1",
    notes: `[認定バックフィル 2026-09-05] ${t.source_file} ${t.source_record} 由来。${t.note}`,
  };
  console.log(`  → INSERT予定: ${JSON.stringify(payload)}`);

  if (EXECUTE) {
    const { error } = await sb.from("client_insurance_records").insert(payload);
    if (error) {
      console.error(`    ✗ INSERT失敗: ${error.message}`);
      continue;
    }
    console.log("    ✓ INSERT完了");
  }
  console.log("");
}

console.log(`${EXECUTE ? "本番投入しました。" : "※ DRY RUN のため INSERT していません。--execute で本番投入 (user承認後のみ)。"}`);
console.log("⚠ 投入後は取込を回し直す必要はない (認定を足しただけでは実績は増えない。");
console.log("  既存のkaigo_visit_scheduleの実績が今回の認定期間内であれば、次回の集計から拾われる)。");
console.log("⚠ 清水日出男は障害側で¥523,298の既知の請求漏れを持つ同一人物。介護の認定投入が");
console.log("  障害側の集計・突合結果に影響しないか、投入の前後でshogai-densou-diff等を必ず比較すること。");
