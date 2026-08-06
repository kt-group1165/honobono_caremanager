// ============================================================================
// 障害の受給者証に **特別地域加算フラグ (flag_special_area)** を立てる。
//
// ── なぜ要るか ────────────────────────────────────────────────────────
//   特別地域加算は「**利用者の居住地**が中山間地域等に該当する」場合に付く。
//   事業所単位ではなく**利用者単位**なので、受給者証側のフラグで持つ設計になっている
//   (aggregate.ts 3.8 が cert.flag_special_area=true の人だけに算定する)。
//   いすみは 48 名全員 false だったため 1 件も算定されず、J121 が 35 名中 2 名しか
//   一致しなかった。
//
// ── 根拠 ──────────────────────────────────────────────────────────────
//   **伝送 (KJ) に特地加算コード (1x6015) が出ている受給者**だけ true にする。
//   ⚠ 伝送を取込元にしないのが原則だが、これは「加算の有無」という**設定値**であり
//     実績ではない。受給者証 PDF に特別地域の記載欄が無く他に出所が無いため、
//     ほのぼのの請求実態から起こす。**金額は伝送から取らない** (率はマスタの 15%)。
//   いすみ 6 月: 35 名中 32 名に算定 (3 名は非該当 = 居住地が対象外)。
//
//   SP_OFFICE_ID=<uuid> SP_KJ=<KJファイルへのパス> \
//     node migrations/set_shogai_special_area_flag.mjs            # DRY RUN
//   … --execute で更新
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import iconv from "encoding-japanese";

const EXECUTE = process.argv.includes("--execute");
const OFFICE_ID = process.env.SP_OFFICE_ID || "4015f747-4f75-4769-a1f2-dca3db6a24fc"; // いすみ
const KJ = process.env.SP_KJ || "伝送データ/いすみ/訪問介護/障害/202606/ほのぼのから/KJ260802.CSV";

function loadEnv() {
  const txt = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}
const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function main() {
  console.log(`=== 障害 特別地域加算フラグ ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  const rows = iconv
    .convert(readFileSync(KJ), { to: "UNICODE", from: "SJIS", type: "string" })
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.split(",").map((s) => s.replace(/"/g, "")));

  const withTokuchi = new Set();
  const allRecipients = new Set();
  for (const r of rows) {
    if (r[2] !== "J121") continue;
    if (r[3] === "01") allRecipients.add(r[7]);
    if (r[3] === "03" && /^1\d6015$/.test(r[8] ?? "")) withTokuchi.add(r[7]);
  }
  console.log(`伝送の受給者 ${allRecipients.size} 名 / 特地加算あり ${withTokuchi.size} 名`);
  const off = [...allRecipients].filter((u) => !withTokuchi.has(u));
  if (off.length) console.log(`  特地なし (居住地が対象外): ${off.join(", ")}`);

  const { data: asg, error: e1 } = await sb
    .from("client_office_assignments").select("client_id").eq("office_id", OFFICE_ID);
  if (e1) throw new Error(e1.message);
  const ids = [...new Set(asg.map((r) => r.client_id))];

  const certs = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await sb
      .from("shougai_certifications")
      .select("id, client_id, beneficiary_number, flag_special_area, clients(name)")
      .in("client_id", ids.slice(i, i + 100));
    if (error) throw new Error(error.message);
    certs.push(...data);
  }

  const on = certs.filter((c) => withTokuchi.has(c.beneficiary_number) && !c.flag_special_area);
  const off2 = certs.filter((c) => !withTokuchi.has(c.beneficiary_number) && c.flag_special_area);
  console.log(`\n受給者証 ${certs.length} 件 / 立てる ${on.length} / 下ろす ${off2.length}`);
  for (const c of on.slice(0, 40)) console.log(`  ON  ${c.beneficiary_number} ${c.clients?.name ?? ""}`);
  for (const c of off2) console.log(`  OFF ${c.beneficiary_number} ${c.clients?.name ?? ""}`);

  if (!on.length && !off2.length) { console.log("\n変更なし。"); return; }
  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で更新します。"); return; }

  for (const [list, val] of [[on, true], [off2, false]]) {
    for (let i = 0; i < list.length; i += 100) {
      const { error } = await sb
        .from("shougai_certifications")
        .update({ flag_special_area: val })
        .in("id", list.slice(i, i + 100).map((c) => c.id));
      if (error) { console.error(`✗ 更新失敗: ${error.message}`); process.exit(1); }
    }
  }
  console.log(`✓ 完了: ON ${on.length} / OFF ${off2.length}`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
