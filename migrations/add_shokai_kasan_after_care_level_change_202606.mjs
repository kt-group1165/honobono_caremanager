// ============================================================================
// 要支援 → 要介護 に変わった月 (2026-06) の訪問介護初回加算 (114001) を、ほのぼのが請求しているのに
// 当方の加算行 (kaigo_visit_addon_lines) に無い人だけ足す。
//
//   node migrations/add_shokai_kasan_after_care_level_change_202606.mjs            # DRY RUN
//   node migrations/add_shokai_kasan_after_care_level_change_202606.mjs --execute  # 本番
//
// ── なぜ ──────────────────────────────────────────────────────────────────
// fix_sougou_to_kaigo_after_care_level_change_202606.mjs で 7 回の訪問を総合事業 → 介護に直した。
// そのヘッダに「ほのぼのは 市川 博義 6/25 / 荻野 秀之 6/24 に初回加算を付けているが当方に無い」と書いたが、
// 2026-11-13 に照会したら ★ 荻野 秀之 は 2026-08-05 の加算取込 (import_meisai_addon_lines.mjs) で既に入っていた。
// 足りないのは 市川 博義 の 1 件だけ。
//
// ── 根拠 ───────────────────────────────────────────────────────────────────
// ほのぼの 提供票一覧 (サービス実績データ/全社/202606/訪問介護/提供票一覧_KSG0261.CSV) の 実績行:
//   市川 博義  ＫＴ姉崎ヘルパーステーション 1272400142 / 利用者番号 412000096 / 訪問介護初回加算 114001 / 25 日に 1 回 / 200 単位
//   (東城 宏三 には初回加算の行が無い = 付けない)
// 加算の算定要件 (サービス提供責任者の訪問・同行) は当方のデータでは確かめられない。
// 加算行の取込 (import_meisai_addon_lines.mjs) と同じく、算定の判断は事業所が入れた ほのぼのの実績を正とする。
//
// ── 書くもの ───────────────────────────────────────────────────────────────
//   kaigo_visit_addon_lines 1 行: office=ＫＴ姉崎 / client=市川 博義 / target_month=2026-06 / 114001 / count 1 /
//   system=介護 / santei_date=2026-06-25 / notes=[区分変更後の初回加算 2026-11-13]
// ── 安全装置 ───────────────────────────────────────────────────────────────
//   ・client / office が 1 件ずつに決まること、2026-06 に有効な介護の 114001 がマスタにあること
//   ・算定日 (6/25) に当方の介護の訪問 (区分変更是正の行) があること
//   ・同じキー (client, 月, office, 114001, 介護) の行が既にあれば書かない (二重計上しない)
//   ・提供票一覧 CSV で 実績・114001・その日 に 1 回あることを実行時にも確かめる
//   ・書いた後に読み直して 1 行であることを確かめる
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const env = Object.fromEntries(
  readFileSync(path.join(KAIGO, ".env.local"), "utf8").split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const MONTH = "2026-06";
const TARGETS = [
  { name: "市川 博義", officeNumber: "1272400142", userNumber: "412000096", date: "2026-06-25", code: "114001" },
];
const CSV = path.join(KAIGO, "サービス実績データ", "全社", "202606", "訪問介護", "提供票一覧_KSG0261.CSV");
const NOTE = "[区分変更後の初回加算 2026-11-13]";

async function main() {
  console.log(`=== 区分変更後の初回加算 (${MONTH}) ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);
  const problems = [];
  if (!existsSync(CSV)) { console.error(`✗ 提供票一覧 CSV が無い: ${CSV}`); process.exit(2); }
  const csv = new TextDecoder("shift_jis").decode(readFileSync(CSV)).split(/\r?\n/).slice(1)
    .map((l) => l.split(",").map((x) => x.replace(/^"|"$/g, "")));

  const { data: master, error: mErr } = await sb.from("kaigo_service_codes").select("service_code, units, valid_from, valid_until")
    .eq("system", "介護").eq("service_code", "114001").lte("valid_from", `${MONTH}-01`);
  if (mErr) throw new Error(mErr.message);
  const valid = (master ?? []).filter((m) => !m.valid_until || m.valid_until >= `${MONTH}-01`);
  if (valid.length !== 1) problems.push(`マスタ: 2026-06 に有効な介護の 114001 が ${valid.length} 件`);

  const plans = [];
  for (const t of TARGETS) {
    const label = `${t.name} ${t.date}`;
    const day = Number(t.date.slice(8, 10));
    const hit = csv.filter((c) => c[2] === t.officeNumber && c[4] === t.userNumber && c[50] === t.code && c[15] === "実績" && c[15 + day] && c[15 + day] !== "0");
    if (hit.length !== 1) { problems.push(`${label}: 提供票一覧の実績に 114001 (その日) が ${hit.length} 行`); continue; }

    const { data: offs, error: oErr } = await sb.from("offices").select("id, name, tenant_id").eq("business_number", t.officeNumber);
    if (oErr) throw new Error(oErr.message);
    if ((offs ?? []).length !== 1) { problems.push(`${label}: 事業所 ${t.officeNumber} が ${offs?.length ?? 0} 件`); continue; }
    const office = offs[0];
    const { data: cls, error: cErr } = await sb.from("clients").select("id, name").eq("name", t.name).is("deleted_at", null);
    if (cErr) throw new Error(cErr.message);
    // 同姓同名に備え、その事業所・その日に介護の訪問 (区分変更是正の行) がある人に絞る
    const ids = (cls ?? []).map((c) => c.id);
    const { data: visits, error: vErr } = await sb.from("kaigo_visit_schedule").select("id, user_id, system, notes")
      .eq("office_id", office.id).eq("visit_date", t.date).in("user_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
    if (vErr) throw new Error(vErr.message);
    const kaigoVisits = (visits ?? []).filter((v) => v.system === "介護" && String(v.notes ?? "").startsWith("[区分変更是正"));
    const who = [...new Set(kaigoVisits.map((v) => v.user_id))];
    if (who.length !== 1) { problems.push(`${label}: その日に介護 (区分変更是正) の訪問がある本人が ${who.length} 名`); continue; }
    const clientId = who[0];

    const { data: ex, error: eErr } = await sb.from("kaigo_visit_addon_lines").select("id, target_month, count, system")
      .eq("client_id", clientId).eq("office_id", office.id).eq("addon_code", t.code).eq("target_month", MONTH);
    if (eErr) throw new Error(eErr.message);
    if ((ex ?? []).length) { console.log(`  ${label}: 既に加算行がある (${ex.map((r) => `${r.system} ×${r.count}`).join(", ")}) → 書かない`); continue; }

    console.log(`  ${label}  ${office.name}  訪問介護初回加算 114001 ×1 (${valid[0]?.units ?? "?"} 単位)  ← 提供票一覧の実績に 1 回`);
    plans.push({ tenant_id: office.tenant_id ?? "kt-group", office_id: office.id, client_id: clientId, target_month: MONTH,
      addon_code: t.code, count: 1, system: "介護", santei_date: t.date, notes: NOTE });
  }

  if (problems.length) { console.error("\n✗ 止める:"); for (const p of problems) console.error(`  ${p}`); process.exit(2); }
  console.log(`\n書く 加算行 ${plans.length} 行`);
  if (!EXECUTE) { console.log("※ DRY RUN。--execute で書いて読み直す。"); return; }

  for (const p of plans) {
    const { error } = await sb.from("kaigo_visit_addon_lines").insert(p);
    if (error) { console.error(`✗ INSERT 失敗: ${error.message}`); process.exit(1); }
    const { data, error: rErr } = await sb.from("kaigo_visit_addon_lines").select("id")
      .eq("client_id", p.client_id).eq("office_id", p.office_id).eq("addon_code", p.addon_code).eq("target_month", p.target_month).eq("system", p.system);
    if (rErr || (data ?? []).length !== 1) { console.error(`✗ 検算失敗: ${rErr?.message ?? `${data?.length} 行`}`); process.exit(1); }
  }
  console.log(`完了: ${plans.length} 行 (読み直して 1 行ずつ確認)`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
