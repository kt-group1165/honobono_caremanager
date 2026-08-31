// ============================================================================
// 「(氏名未取得 保険者-被保番)」で作った利用者を、実在の利用者に統合する
//
// ── 何が起きていたか ────────────────────────────────────────────────────
//   ほのぼのが請求しているのに **こちらが受け取った利用者マスタ CSV のどれにも
//   載っていない**人が 3 名いた。居宅レセプトの事業所合計を合わせるため
//   import_kyotaku_claims_from_kk.mjs --create-nameless で仮の氏名で作ってあった。
//
//   2026-08-31 に ほのぼの NEXT の利用者管理を **【複数事業所適用中】**にして
//   被保険者番号で検索したら 3 名とも特定できた。
//   (事業所グループ切替 → 「(グループ選択無し)」で全事業所 7,902 名になる)
//
//   ところが 2 名は **当方に既に居た**。被保険者番号が違っていたので
//   伝送から引けなかっただけだった。
//
//     豊田 浩行  当方 122192|1111115556   正 122192|1000039777
//     元吉 敏枝  当方 122184|0001957987   正 122184|0001957087  ← 7087/7987 の入れ違い
//
//   その結果 **2026-06 のレセプトが 2 枚**になっていた (実在側と仮の氏名側)。
//   ⚠ 伝送突合は (保険者, 被保番) で当方を引くので、番号が違う実在側は
//     集計に入らず **二重計上に気づけない**。
//
// ── 何をするか ──────────────────────────────────────────────────────────
//   実在の利用者が居る → 認定の被保番を正しい値に直し、レセプト・割当を移して
//                        仮の利用者を消す
//   実在の利用者が居ない → 仮の利用者を改名して番号・生年月日・住所を入れる
//
//   node migrations/fix_nameless_kyotaku_clients.mjs             # DRY RUN
//   node migrations/fix_nameless_kyotaku_clients.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const TENANT = "kt-group";
const env = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

/** ほのぼの NEXT 利用者管理で被保険者番号から特定した値 (2026-08-31) */
const PEOPLE = [
  {
    insurer: "122192", insured: "1000039777",
    name: "豊田 浩行", furigana: "トヨタ ヒロユキ", user_number: "411000372",
    birth_date: "1936-03-30", gender: "男",
    postal_code: "290-0266", address: "千葉県市原市海保762番地の3", phone: "0436-36-4062",
    office: "ＫＴ在宅サポートセンター", care_manager: "畑中 敬子",
  },
  {
    insurer: "122184", insured: "0001957087",
    name: "元吉 敏枝", furigana: "モトヨシ トシエ", user_number: "424000348",
    birth_date: "1935-12-17", gender: "女",
    postal_code: null, address: "千葉県勝浦市中里143-2", phone: "0470-76-0304",
    office: "リンクス居宅介護支援事業所いすみ", care_manager: "増田 富江",
  },
  {
    insurer: "122382", insured: "0000357968",
    name: "西野 昇", furigana: "ニシノ ノボル", user_number: "424000366",
    birth_date: "1935-11-28", gender: "男",
    postal_code: "298-0002", address: "千葉県いすみ市日在1225番地", phone: null,
    office: "リンクス居宅介護支援事業所いすみ", care_manager: "清水 友里加",
  },
];

async function main() {
  console.log(`=== 氏名未取得の利用者を実在の利用者に統合 ${EXECUTE ? "【本番】" : "【DRY RUN】"} ===\n`);

  const plan = [];
  for (const p of PEOPLE) {
    // 仮の利用者 (被保番で引く)
    const { data: ir, error } = await sb.from("client_insurance_records")
      .select("id, client_id").eq("insurer_number", p.insurer).eq("insured_number", p.insured);
    if (error) { console.error(`✗ ${p.name}: ${error.message}`); process.exit(1); }
    const ids = [...new Set((ir ?? []).map((r) => r.client_id))];
    if (ids.length !== 1) { console.error(`✗ ${p.insurer}|${p.insured}: 当方の利用者が ${ids.length} 名`); process.exit(1); }
    const { data: tmp } = await sb.from("clients").select("id, name, user_number").eq("id", ids[0]).single();
    if (!/氏名未取得/.test(tmp?.name ?? "")) { console.log(`  = ${p.insurer}|${p.insured} は既に「${tmp?.name}」— 触らない`); continue; }

    // 実在の利用者 (ほのぼのの利用者番号で引く)
    const { data: real } = await sb.from("clients")
      .select("id, name, user_number, birth_date").eq("tenant_id", TENANT)
      .eq("user_number", p.user_number).neq("id", tmp.id);
    plan.push({ p, tmp, real: (real ?? [])[0] ?? null });
  }
  if (!plan.length) { console.log("  直す人はいません"); return; }

  for (const q of plan) {
    console.log(`\n  ${q.tmp.name}`);
    if (q.real) {
      const { data: rir } = await sb.from("client_insurance_records")
        .select("id, insurer_number, insured_number").eq("client_id", q.real.id);
      const { data: tcl } = await sb.from("kaigo_care_support_claims")
        .select("id, billing_month, total_amount").eq("user_id", q.tmp.id);
      const { data: rcl } = await sb.from("kaigo_care_support_claims")
        .select("id, billing_month, insurer_number, total_amount").eq("user_id", q.real.id);
      q.rir = rir ?? []; q.tcl = tcl ?? []; q.rcl = rcl ?? [];
      console.log(`    → 実在の「${q.real.name}」(${q.real.user_number}) に統合`);
      console.log(`       実在側の認定: ${q.rir.map((r) => `${r.insurer_number}|${r.insured_number}`).join(" / ")}`);
      console.log(`       ⚠ 正しい被保番は ${q.p.insured} — 直す`);
      console.log(`       仮のレセプト: ${q.tcl.map((c) => `${c.billing_month} ${Number(c.total_amount).toLocaleString()}円`).join(" / ")}`);
      console.log(`       実在のレセプト: ${q.rcl.map((c) => `${c.billing_month} ${Number(c.total_amount).toLocaleString()}円`).join(" / ") || "なし"}`);
      const dup = q.rcl.filter((c) => q.tcl.some((t) => t.billing_month === c.billing_month));
      if (dup.length) console.log(`       ⚠ ${dup.map((c) => c.billing_month).join(",")} が二重 — 実在側を消して仮のほうを残す`);
    } else {
      console.log(`    → 実在の利用者は居ないので改名する: ${q.p.name} (${q.p.user_number})`);
    }
  }

  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で保存します。"); return; }

  for (const q of plan) {
    if (!q.real) {
      const { error } = await sb.from("clients").update({
        name: q.p.name, furigana: q.p.furigana, user_number: q.p.user_number,
        birth_date: q.p.birth_date, gender: q.p.gender,
        address: q.p.address, phone: q.p.phone, postal_code: q.p.postal_code,
      }).eq("id", q.tmp.id);
      if (error) { console.error(`✗ ${q.p.name}: ${error.message}`); process.exit(1); }
      console.log(`  ✓ ${q.p.name} を改名`);
      continue;
    }

    // ① 実在側の認定の被保番を正す (伝送から引けるようにする)
    const wrong = q.rir.filter((r) => r.insurer_number === q.p.insurer && r.insured_number !== q.p.insured);
    for (const r of wrong) {
      const { error } = await sb.from("client_insurance_records")
        .update({ insured_number: q.p.insured }).eq("id", r.id);
      if (error) { console.error(`✗ 認定の是正に失敗: ${error.message}`); process.exit(1); }
      console.log(`  ✓ ${q.real.name} の被保番 ${r.insured_number} → ${q.p.insured}`);
    }

    // ② 実在側にある重複レセプトを消す (仮のほうが伝送どおりの内訳を持っている)
    for (const c of q.rcl) {
      if (!q.tcl.some((t) => t.billing_month === c.billing_month)) continue;
      const { error } = await sb.from("kaigo_care_support_claims").delete().eq("id", c.id);
      if (error) { console.error(`✗ 重複レセプトの削除に失敗: ${error.message}`); process.exit(1); }
      console.log(`  ✓ ${q.real.name} の重複レセプト ${c.billing_month} を削除`);
    }

    // ③ 仮のレセプトを実在側へ移す
    for (const c of q.tcl) {
      const { error } = await sb.from("kaigo_care_support_claims")
        .update({ user_id: q.real.id }).eq("id", c.id);
      if (error) { console.error(`✗ レセプトの移動に失敗: ${error.message}`); process.exit(1); }
    }
    console.log(`  ✓ レセプト ${q.tcl.length} 件を ${q.real.name} へ移動`);

    // ④ 仮の利用者にぶら下がる認定・割当を消してから本体を消す
    for (const t of ["client_insurance_records", "client_office_assignments"]) {
      const { error } = await sb.from(t).delete().eq("client_id", q.tmp.id);
      if (error) { console.error(`✗ ${t} の削除に失敗: ${error.message}`); process.exit(1); }
    }
    const { error: eD } = await sb.from("clients").delete().eq("id", q.tmp.id);
    if (eD) { console.error(`✗ 仮の利用者の削除に失敗: ${eD.message} (他の表から参照されている)`); process.exit(1); }
    console.log(`  ✓ ${q.tmp.name} を削除`);
  }
  console.log(`\n✓ ${plan.length} 名を整理しました`);
}

main();
