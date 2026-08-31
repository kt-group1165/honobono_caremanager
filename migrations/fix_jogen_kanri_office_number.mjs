// ============================================================================
// 障害の上限額管理事業所番号を点検・是正する
//
// 2026-09-01。`MONTH=2026-07 npm run check:densou` の
// 「上限管理が他事業所なのに 事業所番号 が未設定 — 15 件」を追ったら 2 つ出てきた。
//
//   node migrations/fix_jogen_kanri_office_number.mjs             # DRY RUN (既定・書込なし)
//   node migrations/fix_jogen_kanri_office_number.mjs --execute   # 自事業所ぶんだけ是正
//
// ── ① 自事業所の 17 件のうち 16 件に **介護保険の事業所番号**が入っている ──
//   例) Hanaヘルパーステーション高品（身障）→ 1270402116
//       これは高品の *介護* 番号。障害は 1210102263。
//
//   ⚠ **伝送は壊れていない。**`lib/shogai-densou/build.ts` は 区分='自事業所' のとき
//     この列を使わず、送信元事業所の障害番号 (office) を項15 に入れている。
//     壊れるのは画面表示だけ (受給者証編集・請求一覧に誤った番号が併記される)。
//     とはいえ「正しい番号が入っている」と誤解させるので直す。
//
//   是正は **2 つの材料が一致したものだけ**:
//     ① jogen_kanri_office_name が自社事業所の名称と一致する
//     ② jogen_kanri_office_number が **その事業所の介護番号** と一致する
//   両方そろったときだけ、その事業所の障害番号へ差し替える。片方だけなら触らない。
//
// ── ② 他事業所の 24 件は **全件が番号未設定** ──
//   こちらは伝送の項15 が空になり **返戻**する。自動では埋めない:
//     ・他社 20 件 … 番号の出どころが無い (障害福祉サービス事業所のマスタを持っていない)。
//                    上限額管理結果票 / 受給者証の記載から人が入力する。
//     ・自社 4 件 … 名称は一致するが、児童発達支援など **別番号の事業所**の
//                    可能性があるので提案だけして書き換えない。
//   → 一覧を出すだけ。これは人が判断すること。
//
//   ⚠ 名称が途中で切れている行がある (受給者証 PDF は 17 文字程度で切れる)。
//     「株式会社　コネクト　ドット３６」「…ドット３６５誉」「…ドット３６５誉田」は
//     同じ事業所。番号を入れるときはまとめて入れること。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXECUTE = process.argv.includes("--execute");
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

const PAGE = 1000;
async function fetchAll(table, select) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from(table).select(select).order("id").range(from, from + PAGE - 1);
    if (error) throw new Error(`${table} の取得に失敗: ${error.message}`);
    out.push(...(data ?? []));
    if ((data ?? []).length < PAGE) return out;
  }
}

/** 表記ゆれを吸収する。全半角・空白・記号・ヘルパーステーションの略記 */
function norm(s) {
  return String(s ?? "")
    .normalize("NFKC")
    .replace(/[\s()[\]{}・,、。]/g, "")
    .replace(/ﾍﾙﾊﾟｰｽﾃｰｼｮﾝ|ヘルパーステーション/g, "HS")
    .replace(/Hana|Ｈana|ＨａｎａHS?/gi, "ハナ");
}

async function main() {
  console.log(`=== 上限額管理事業所番号の点検 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  const [offices, certs, clients] = await Promise.all([
    fetchAll("offices", "id, name, business_number, shogai_business_number"),
    fetchAll(
      "shougai_certifications",
      "id, client_id, jogen_kanri_kubun, jogen_kanri_office_name, jogen_kanri_office_number",
    ),
    fetchAll("clients", "id, name"),
  ]);
  const nameOf = new Map(clients.map((c) => [c.id, c.name]));
  const ours = offices.filter((o) => o.shogai_business_number);
  const byKaigoNumber = new Map(ours.filter((o) => o.business_number).map((o) => [o.business_number, o]));

  // ── ① 自事業所: 介護番号が入っているものを障害番号へ ──
  const own = certs.filter((c) => (c.jogen_kanri_kubun ?? "").trim() === "自事業所");
  const fixes = [];
  const ownOther = [];
  for (const c of own) {
    const num = (c.jogen_kanri_office_number ?? "").trim();
    if (!num) continue;
    if (ours.some((o) => o.shogai_business_number === num)) continue; // 既に障害番号 = 正しい
    const office = byKaigoNumber.get(num); // 材料② 番号がその事業所の介護番号
    const nm = norm(c.jogen_kanri_office_name);
    const nameHit = office && nm && (nm.includes(norm(office.name)) || norm(office.name).includes(nm)); // 材料①
    if (office && nameHit) {
      fixes.push({ cert: c, office });
    } else {
      ownOther.push({ cert: c, num, office });
    }
  }

  console.log(`── ① 自事業所 ${own.length} 件 ──`);
  console.log(`   介護番号が入っていて **名称も一致** → 障害番号へ差し替える  ${fixes.length} 件`);
  for (const f of fixes) {
    console.log(
      `     ${nameOf.get(f.cert.client_id) ?? "?"}  ${f.cert.jogen_kanri_office_number} → ` +
        `${f.office.shogai_business_number}  (${f.office.name})`,
    );
  }
  if (ownOther.length > 0) {
    console.log(`   材料がそろわないので触らない  ${ownOther.length} 件`);
    for (const o of ownOther) {
      console.log(`     ${nameOf.get(o.cert.client_id) ?? "?"}  ${o.num}  ${o.cert.jogen_kanri_office_name ?? ""}`);
    }
  }
  console.log(`   ⚠ 伝送 (項15) は 区分='自事業所' のとき送信元事業所の障害番号を使うので、`);
  console.log(`     この列の誤りは **伝送には出ていない**。直すのは画面表示のため。`);

  // ── ② 他事業所: 番号未設定の一覧 (自動では埋めない) ──
  const oth = certs.filter(
    (c) => (c.jogen_kanri_kubun ?? "").trim() === "他事業所" && !(c.jogen_kanri_office_number ?? "").trim(),
  );
  console.log(`\n── ② 他事業所で番号が未設定 ${oth.length} 件 (伝送の項15 が空 = 返戻) ──`);
  const mine = [];
  const external = [];
  for (const c of oth) {
    const nm = norm(c.jogen_kanri_office_name);
    const hit = ours.find((o) => nm && (nm.includes(norm(o.name)) || norm(o.name).includes(nm)));
    (hit ? mine : external).push({ c, hit });
  }
  console.log(`\n   ★自社の事業所らしいもの ${mine.length} 件 — **提案のみ。児童発達支援など別番号の`);
  console.log(`     事業所の可能性があるので、確認してから画面で入力してください**`);
  for (const m of mine) {
    console.log(
      `     ${String(nameOf.get(m.c.client_id) ?? "?").padEnd(12)}  ${m.c.jogen_kanri_office_name}\n` +
        `        → 候補 ${m.hit.shogai_business_number} (${m.hit.name})`,
    );
  }
  console.log(`\n   他社 ${external.length} 件 — 上限額管理結果票 / 受給者証の記載から入力するしかない`);
  const seen = new Map();
  for (const e of external) {
    const key = (e.c.jogen_kanri_office_name ?? "").trim();
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(nameOf.get(e.c.client_id) ?? "?");
  }
  for (const [office, users] of seen) {
    console.log(`     ${office || "(名称も空)"}  — ${users.join(" / ")}`);
  }

  if (!EXECUTE) {
    console.log(`\n※ DRY RUN。--execute で ① の ${fixes.length} 件だけ更新します (② は触りません)。`);
    return;
  }
  if (fixes.length === 0) {
    console.log("\n更新するものはありません。");
    return;
  }
  let n = 0;
  for (const f of fixes) {
    const { error } = await sb
      .from("shougai_certifications")
      .update({ jogen_kanri_office_number: f.office.shogai_business_number })
      .eq("id", f.cert.id);
    if (error) {
      console.error(`✗ 更新失敗 (${n} 件済) id=${f.cert.id}: ${error.message}`);
      process.exit(1);
    }
    n += 1;
  }
  console.log(`\n✓ ${n} 件を障害の事業所番号に直しました。`);
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
