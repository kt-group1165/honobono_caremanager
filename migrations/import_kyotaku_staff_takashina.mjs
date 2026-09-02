// ============================================================================
// 高品居宅(Ｈａｎａ居宅支援センター高品)の職員マスタを
// 利用者データ/高品/staff_kyotaku.json から members/member_offices へ投入。
//
//   node migrations/import_kyotaku_staff_takashina.mjs            # DRY RUN
//   node migrations/import_kyotaku_staff_takashina.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const TENANT = "kt-group";
const OFFICE_ID = "18dab72e-0445-49f1-a8fc-44637f9fd676"; // Hana居宅支援センター高品
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
function loadEnv() {
  const t = readFileSync(path.join(KAIGO, ".env.local"), "utf8");
  const e = {};
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return e;
}
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
// members.gender の CHECK制約は "男性"/"女性"。staff_kyotaku.json は "男"/"女"表記。
const GENDER_MAP = { "男": "男性", "女": "女性" };

async function main() {
  console.log(`=== 高品居宅 職員マスタ投入 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);
  const src = JSON.parse(readFileSync(path.join(KAIGO, "利用者データ/高品/staff_kyotaku.json"), "utf8"));

  for (const s of src.staff) {
    const { data: existing } = await sb.from("members").select("id,name,role,hire_date,internal_number")
      .eq("name", s.name);

    let action, memberId, note = "";
    if (existing && existing.length) {
      // ⚠ 同姓同名は誤爆しうる (feedback_name_based_lookup_collision_risk.md)。
      //   生年月日を members 側が持たないため裏取りできない。
      //   雇用日(hire_date_note の和暦換算)が既存の hire_date と近ければ強い傍証、
      //   無関係な事業所にしか居なければ要確認として新規作成せずスキップする。
      const { data: officesOf } = await sb.from("member_offices").select("office_id,offices(name)").eq("member_id", existing[0].id);
      const officeNames = (officesOf || []).map((o) => o.offices?.name).join(",");
      note = `⚠ 同姓同名が既存(id=${existing[0].id.slice(0, 8)}, 所属=${officeNames || "無し"}, hire_date=${existing[0].hire_date}) — 裏取り(生年月日)ができないため自動リンクしない。要人手確認`;
      action = "skip-ambiguous";
    } else {
      action = "create";
    }

    console.log(`- ${s.name}(${s.employee_number}) 役割=${s.primary_role} → ${action}${note ? "\n  " + note : ""}`);

    if (!EXECUTE || action !== "create") continue;

    const { data: mRow, error: mErr } = await sb.from("members").insert({
      tenant_id: TENANT,
      name: s.name,
      furigana: s.kana || null,
      gender: GENDER_MAP[s.gender] ?? null,
      role: s.primary_role || null,
      qualifications: s.qualifications || null,
      phone: s.phone || s.mobile || null,
      status: "active",
    }).select("id").single();
    if (mErr) { console.error(`  ✗ members insert失敗: ${mErr.message}`); continue; }
    memberId = mRow.id;
    const { error: moErr } = await sb.from("member_offices").insert({
      member_id: memberId, office_id: OFFICE_ID, is_primary: true,
    });
    if (moErr) console.error(`  ✗ member_offices insert失敗: ${moErr.message}`);
    else console.log(`  ✓ 作成: member_id=${memberId}`);
  }

  if (!EXECUTE) console.log("\n※ DRY RUN。--execute で「create」のみ投入(同姓同名ありは投入せずスキップ、要人手確認)。");
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
