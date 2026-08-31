// ============================================================================
// 要介護度と **区分支給限度基準額** が対応していない認定を直す。
//
//   node migrations/fix_service_limit_amount.mjs             # DRY RUN
//   node migrations/fix_service_limit_amount.mjs --execute
//
// ── 何が起きているか ────────────────────────────────────────────────────
//   認定レコードの service_limit_amount が、その人の要介護度の額になっていない。
//   2026-08-31 時点、**2026-06 以降にかかる認定 5,377 件のうち 94 件**が該当:
//
//     志村 道子   要介護4 なのに 27048 (要介護3の額)
//     夏井 うめ   要介護5 なのに 30938 (要介護4の額)
//     平田 月美   要支援1 なのに 27048 (要介護3の額)
//
//   限度額は **限度額超過の判定**と利用票の表示に直結する。ずれていると
//   超過していないのに超過と出たり、その逆になる。
//
//   出どころは主に `[認定履歴取込 2026-08-04]`。同じ (利用者, 保険者, 被保番,
//   認定開始日) に 5〜6 行が入っていて、限度額だけが全区分ぶんばらばらだった。
//   認定の世代をまたいで行が対応していないとみられる。
//
// ── 直すもの / 直さないもの ────────────────────────────────────────────
//   直す   … **2019-10-01 以降に始まった認定**で、額が要介護度と合わないもの。
//            区分支給限度基準額は 2019-10 (消費税改定) 以降 据え置きなので、
//            それ以降の認定に旧額や別区分の額が入っていれば誤り。
//   直さない… 2019-10 より前に始まった認定。例えば 2017-05 開始の 要支援2 が
//            10473 なのは **当時は正しい**。今の額で上書きすると履歴が壊れる。
//   直さない… 2026-06 より前に終わっている認定 (もう使わない)
//
//   ⚠ 「額が現行額かどうか」で分けると誤る。松村 娃都子 (要介護2 / 2026-06-01 開始)
//     に 36065 (要介護5 の旧額) が入っていた例がある。**期間で分ける**こと。
//
//   ⚠ 要介護度のほうを疑わない理由: 要介護度は基本コードの判定に使われ、
//     居宅の伝送突合が 15/15 事業所で一致している。要介護度は信用してよい。
//
//   変更前の値は migrations/_service_limit_amount_backup.json に残す。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const BACKUP = path.join(KAIGO, "migrations/_service_limit_amount_backup.json");
/** この月以降にかかる認定だけを対象にする */
const FROM = process.env.FROM || "2026-06-01";

const env = {};
for (const l of readFileSync(path.join(KAIGO, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

/**
 * 現行の区分支給限度基準額 (単位/月)。
 * ⚠ 既存 script (import_meisai_step1_clients.mjs) と同じ値。
 *   2026-06 に有効な認定 990 件で全区分一致を実データ確認済み。
 */
const STD = {
  "要支援1": 5032, "要支援2": 10531,
  "要介護1": 16765, "要介護2": 19705, "要介護3": 27048, "要介護4": 30938, "要介護5": 36217,
};
const CURRENT = new Set(Object.values(STD));
const TIER_OF = Object.fromEntries(Object.entries(STD).map(([k, v]) => [v, k]));

async function fetchAll(build) {
  const out = [];
  // ⚠ order 無しで range を回すと行が重複・欠落する
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().order("id").range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  console.log(`=== 要介護度と区分支給限度基準額の不一致を直す ${EXECUTE ? "【本番】" : "【DRY RUN】"} ===`);
  console.log(`   対象: ${FROM} 以降にかかる認定\n`);

  const certs = await fetchAll(() => sb.from("client_insurance_records")
    .select("id, client_id, care_level, service_limit_amount, certification_start_date, certification_end_date, notes"));
  const clients = new Map((await fetchAll(() => sb.from("clients").select("id, name"))).map((c) => [c.id, c.name]));

  const live = certs.filter((r) => !r.certification_end_date || r.certification_end_date >= FROM);
  const bad = live.filter((r) =>
    r.care_level && r.service_limit_amount != null && STD[r.care_level] &&
    Number(r.service_limit_amount) !== STD[r.care_level]);

  // ⚠ 「現行額かどうか」で分けてはいけない。**認定期間で分ける**。
  //   現行の区分支給限度基準額は 2019-10 (消費税改定) 以降 据え置き。
  //   それ以降に始まった認定なら、旧額が入っていること自体が誤り。
  //   実際 松村 娃都子 (要介護2 / 2026-06-01 開始) に 36065 = 要介護5 の旧額 が
  //   入っていた。「旧額だから触らない」と分けると、これを見逃す。
  const CURRENT_SINCE = "2019-10-01";
  const fixable = bad.filter((r) => (r.certification_start_date ?? "9999") >= CURRENT_SINCE);
  const oldAmount = bad.filter((r) => (r.certification_start_date ?? "9999") < CURRENT_SINCE);

  console.log(`${FROM} 以降にかかる認定 ${live.length} 件 / 不一致 ${bad.length} 件`);
  console.log(`   直す (2019-10 以降の認定)   ${fixable.length} 件`);
  console.log(`   昔の改定額 (直さない)   ${oldAmount.length} 件\n`);

  console.log("― 直すもの ―");
  for (const r of fixable.slice(0, 30)) {
    console.log(`   ${String(clients.get(r.client_id)).padEnd(12)} ${r.care_level}  ${r.service_limit_amount} (=${TIER_OF[Number(r.service_limit_amount)] ?? "旧額"}) → ${STD[r.care_level]}` +
      `  ${r.certification_start_date}〜${r.certification_end_date}`);
  }
  if (fixable.length > 30) console.log(`   … 他 ${fixable.length - 30} 件`);

  if (oldAmount.length) {
    console.log("\n― 昔の改定額なので触らないもの ―");
    for (const r of oldAmount.slice(0, 10)) {
      console.log(`   ${String(clients.get(r.client_id)).padEnd(12)} ${r.care_level}  ${r.service_limit_amount}  ${r.certification_start_date}〜${r.certification_end_date}`);
    }
    if (oldAmount.length > 10) console.log(`   … 他 ${oldAmount.length - 10} 件`);
    console.log("   ※ 当時は正しい額。今の額で上書きすると履歴が壊れる。");
  }

  if (!EXECUTE) { console.log("\n(--execute で反映)"); return; }

  const backup = fixable.map((r) => ({
    id: r.id, client: clients.get(r.client_id), care_level: r.care_level,
    before: r.service_limit_amount, after: STD[r.care_level],
    period: `${r.certification_start_date}〜${r.certification_end_date}`, notes: r.notes,
  }));
  let ok = 0, ng = 0;
  for (const r of fixable) {
    const { error } = await sb.from("client_insurance_records")
      .update({ service_limit_amount: STD[r.care_level] }).eq("id", r.id);
    if (error) { console.error(`✗ ${clients.get(r.client_id)}: ${error.message}`); ng++; continue; }
    ok++;
  }
  writeFileSync(BACKUP, JSON.stringify(backup, null, 2), "utf8");
  console.log(`\n直した ${ok} 件 / 失敗 ${ng} 件`);
  console.log(`変更前の値を ${path.basename(BACKUP)} に保存しました`);
}

main().catch((e) => { console.error(e); process.exit(1); });
