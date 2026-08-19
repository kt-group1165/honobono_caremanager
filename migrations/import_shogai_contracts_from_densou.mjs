// ============================================================================
// 障害の契約情報 (shogai_contracts) を ほのぼのの実伝送 (KJ) から起こす。
//
// ── 位置づけ: 移行時の初期データ投入 (1 回きり) ────────────────────────
//   契約支給量は「受給者証の決定支給量のうち**自事業所が契約した分**」で、
//   受給者証にも稼働データにも無い (受給者証PDF 858ページ全文に「契約」0 回)。
//   ほのぼのの入力画面 (利用者管理→受給者証→事業者記入欄) にしか無く、
//   全 17 拠点 476 名 718 件を手入力するのは非現実的なため伝送から起こす。
//
//   ⚠ **これは検証にはならない** (伝送から取ったものを同じ伝送と比べても一致して当然)。
//     照合レポートでは J121-05 と J121-02 項8 を「検証対象外 (伝送由来)」と扱うこと。
//     1 名だけ ほのぼのの画面と突き合わせて経路の正しさを確認すれば循環は切れる。
//   運用開始後は画面入力が正式な入力元になる。この取込は移行時のみ。
//
// ── 取る項目 (伝送 J121-05) ───────────────────────────────────────────
//   項7 決定サービスコード / 項8 契約支給量 (整数3+小数2) /
//   項9 契約開始年月日 / 項10 契約終了年月日 / 項11 事業者記入欄番号
//
//   SC_OFFICE_ID=<uuid> SC_KJ=<KJファイル> SC_LABEL=<拠点> \
//     node migrations/import_shogai_contracts_from_densou.mjs            # DRY RUN
//   … --execute で投入
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import iconv from "encoding-japanese";

const EXECUTE = process.argv.includes("--execute");
const OFFICE_ID = process.env.SC_OFFICE_ID;
const KJ = process.env.SC_KJ;
const LABEL = process.env.SC_LABEL || "";
const TENANT = "kt-group";
// ⚠ マーカーに月を入れない。同じ契約が複数月の伝送に出るため、月別マーカーだと
//   冪等削除が効かず UNIQUE(client_id, office_id, decision_code, start_date) で落ちる。
const MARK = `[伝送から契約取込${LABEL ? " " + LABEL.split(" ")[0] : ""}]`;
const KAIGO = fileURLToPath(new URL("../", import.meta.url));

if (!OFFICE_ID || !KJ) {
  console.error("✗ SC_OFFICE_ID と SC_KJ を指定してください");
  process.exit(1);
}

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

/** 通院等乗降介助だけ「回」。他は「時間」 */
const unitOf = (code) => (code === "115000" ? "回" : "時間");
const toDate = (s) => (/^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : null);
const fmt = (x100, unit) => {
  const w = Math.floor(x100 / 100), f = x100 % 100;
  return unit === "時間"
    ? `${w}時間${Math.round((f / 100) * 60)}分`
    : `${w}${f ? "." + String(f).padStart(2, "0") : ""}${unit}`;
};

async function main() {
  console.log(`=== 障害 契約情報を伝送から投入 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ${LABEL} ===\n`);

  const rows = iconv
    .convert(readFileSync(KJ), { to: "UNICODE", from: "SJIS", type: "string" })
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.split(",").map((s) => s.replace(/^"|"$/g, "")));

  // 受給者証番号 -> 契約行
  const byBene = new Map();
  for (const r of rows) {
    if (r[2] !== "J121" || r[3] !== "05") continue;
    const bene = r[7];
    const code = (r[8] ?? "").trim();
    const amt = Number(r[9] ?? 0);
    if (!/^\d{6}$/.test(code) || !(amt >= 0)) continue;
    if (!byBene.has(bene)) byBene.set(bene, []);
    byBene.get(bene).push({
      decision_code: code,
      amount_x100: amt,
      amount_unit: unitOf(code),
      start_date: toDate(r[10] ?? ""),
      end_date: toDate(r[11] ?? ""),
      entry_number: Number(r[12] ?? 1) || 1,
    });
  }
  console.log(`伝送の契約情報: ${byBene.size} 名 / ${[...byBene.values()].flat().length} 件`);
  if (!byBene.size) { console.log("対象なし。"); return; }

  // 受給者証番号 -> client_id
  const { data: asg, error: e1 } = await sb
    .from("client_office_assignments").select("client_id").eq("office_id", OFFICE_ID);
  if (e1) { console.error(`✗ ${e1.message}`); process.exit(1); }
  const ids = [...new Set(asg.map((r) => r.client_id))];
  const certs = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await sb
      .from("shougai_certifications")
      .select("client_id, beneficiary_number, clients(name)")
      .in("client_id", ids.slice(i, i + 100));
    if (error) { console.error(`✗ ${error.message}`); process.exit(1); }
    certs.push(...data);
  }
  const byNum = new Map(certs.filter((c) => c.beneficiary_number).map((c) => [c.beneficiary_number, c]));

  const payload = [];
  const unresolved = [];
  for (const [bene, lines] of byBene) {
    const c = byNum.get(bene);
    if (!c) { unresolved.push(bene); continue; }
    for (const l of lines) {
      if (!l.start_date) continue; // 契約開始日が無い行は入れない (必須項目)
      payload.push({
        tenant_id: TENANT, office_id: OFFICE_ID, client_id: c.client_id,
        ...l, reason: "新規契約", notes: MARK,
      });
    }
    console.log(
      `  ${(c.clients?.name ?? "").padEnd(12)} ` +
        lines.map((l) => `${l.decision_code} ${fmt(l.amount_x100, l.amount_unit)}`).join(" / "),
    );
  }
  if (unresolved.length) console.log(`\n⚠ 受給者証が無く紐付かない: ${unresolved.join(", ")}`);
  console.log(`\n投入対象: ${payload.length} 件`);
  if (!EXECUTE) { console.log("※ DRY RUN。--execute で投入します。"); return; }
  if (!payload.length) return;

  // ⚠ 削除してから入れ直す方式にしない。同じ事業所を 6月 → 7月 と続けて流すと
  //   7月の実行が 6月で入れた契約を消してしまう (契約は月ではなく期間で持つため
  //   「その月の伝送に出ていない = 存在しない」ではない)。upsert だけで冪等にする。
  //   取込分を丸ごと消したいときは notes='${MARK}' を手で DELETE すること。
  // 同じ契約が 6月・7月 両方の伝送に出るので upsert (キーは UNIQUE 索引と同じ)
  for (let i = 0; i < payload.length; i += 200) {
    const { error } = await sb
      .from("shogai_contracts")
      .upsert(payload.slice(i, i + 200), { onConflict: "client_id,office_id,decision_code,start_date" });
    if (error) { console.error(`✗ 投入失敗: ${error.message}`); process.exit(1); }
  }
  console.log(`✓ 完了: ${payload.length} 件`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
