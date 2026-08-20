// ============================================================================
// 他事業所が上限管理者の利用者について、管理結果を ほのぼのの伝送 (KJ / J121) から取り込む。
//
// ── なぜ伝送から取るのか ──────────────────────────────────────────────
//   上限額管理結果票は管理事業所から紙で届く。ほのぼのはそれを入力済みで、
//   6 月の請求にも反映されている。同じ値が J121 に載っているので、
//   紙を探すより伝送を読むほうが早くて確実。
//
//   ⚠ ただし **この項目だけは突合が循環する**。ほのぼのから取った値を
//     ほのぼのと突き合わせても一致して当然。ここは「移行のための転記」で
//     あって検証ではない。運用開始後は結果票を見て画面から入力する。
//
// ── J121 (レコード種別 01) の該当項目 ─────────────────────────────────
//   idx 7  受給者証番号
//   idx 16 上限額管理事業所番号   ← 空 = 上限管理なし
//   idx 17 管理結果 (1/2/3)
//   idx 18 管理結果額 (= 当事業所分の調整後 利用者負担額)
//
// ── 保存先の制約 ──────────────────────────────────────────────────────
//   shogai_jogen_kanri_results のキーは (client_id, target_month) で
//   **事業所の軸が無い**。1 利用者が当社の複数事業所を使っていて、
//   事業所ごとに管理結果額が違う場合は 1 行に収まらない。
//   その場合は取り込まず、画面から入力してもらうよう知らせる。
//
//   node migrations/import_jogen_kanri_from_densou.mjs            # DRY RUN
//   node migrations/import_jogen_kanri_from_densou.mjs --execute
//   MONTH=2026-06 で対象月を変更
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const MONTH = process.env.MONTH || "2026-06";
const YM = MONTH.replace("-", "");
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

/** CSV 1 行を素朴に分解 (項目内にカンマは入らない書式) */
const splitCsv = (line) => line.split(",").map((s) => s.replace(/^"|"$/g, "").trim());

/** 伝送データ/<拠点>/訪問介護/障害/<提供年月>/ほのぼのから… の KJ ファイルを集める */
function findKjFiles() {
  const base = path.join(KAIGO, "伝送データ");
  const out = [];
  for (const area of readdirSync(base)) {
    const dir = path.join(base, area, "訪問介護", "障害", YM);
    if (!existsSync(dir)) continue;
    for (const sub of readdirSync(dir)) {
      if (!sub.startsWith("ほのぼのから")) continue;
      const d = path.join(dir, sub);
      for (const f of readdirSync(d)) {
        if (/^KJ.*\.CSV$/i.test(f)) out.push({ area, file: path.join(d, f) });
      }
    }
  }
  return out;
}

async function main() {
  console.log(`=== 上限管理結果を伝送から取込 ${MONTH} ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===\n`);

  // 1) 伝送から (受給者証番号 → 拠点ごとの管理結果) を集める
  const found = new Map(); // bene -> { officeNumber, entries: [{area, result, amount}] }
  for (const { area, file } of findKjFiles()) {
    const txt = readFileSync(file, "latin1"); // バイト保持。数値項目しか見ないので十分
    for (const line of txt.split(/\r?\n/)) {
      if (!line.startsWith("2,")) continue;
      const c = splitCsv(line);
      if (c[2] !== "J121" || c[3] !== "01") continue;
      const bene = c[7];
      const kanriOffice = c[16];
      if (!bene || !kanriOffice) continue; // 管理事業所が空 = 上限管理なし
      const result = c[17] ? Number(c[17]) : null;
      const amount = c[18] === "" ? null : Number(c[18]);
      if (result == null) continue;
      if (!found.has(bene)) found.set(bene, { officeNumber: kanriOffice, entries: [] });
      found.get(bene).entries.push({ area, result, amount });
    }
  }
  console.log(`  伝送から ${found.size} 名分の管理結果を検出\n`);

  // 2) 受給者証番号 → client を引く
  const { data: certs, error } = await sb
    .from("shougai_certifications")
    .select("client_id, beneficiary_number, jogen_kanri_kubun, jogen_kanri_office_name, clients(name)");
  if (error) { console.error(`✗ 受給者証取得失敗: ${error.message}`); process.exit(1); }
  // ⚠ 受給者証番号で引くが、**同じ番号の client が複数居ることがある**。
  //   受給者証 PDF の取込で氏名欄にメモ行を拾った壊れたレコードが混ざっており
  //   (例: 1222909861 に「多田 一子」と「R2.11.2〜身体28時間に変更している。」)、
  //   先勝ちで拾うと壊れたほうに管理結果を保存してしまう。曖昧なら取り込まない。
  const byBene = new Map();
  for (const c of certs ?? []) {
    if (!c.beneficiary_number || !c.clients) continue;
    if (!byBene.has(c.beneficiary_number)) byBene.set(c.beneficiary_number, []);
    const arr = byBene.get(c.beneficiary_number);
    if (!arr.some((x) => x.client_id === c.client_id)) arr.push(c);
  }

  // 3) 既存の保存済みは上書きしない (画面で入れた値を潰さない)
  const { data: existing, error: e2 } = await sb
    .from("shogai_jogen_kanri_results")
    .select("client_id")
    .eq("target_month", MONTH);
  if (e2) { console.error(`✗ 既存取得失敗: ${e2.message}`); process.exit(1); }
  const already = new Set((existing ?? []).map((r) => r.client_id));

  const plan = [], skipped = [];
  for (const [bene, info] of found) {
    const cands = byBene.get(bene) ?? [];
    if (!cands.length) { skipped.push(`受給者証 ${bene}: 当方に該当利用者なし`); continue; }
    if (cands.length > 1) {
      skipped.push(
        `受給者証 ${bene}: 同じ番号の利用者が ${cands.length} 名 ` +
          `[${cands.map((c) => c.clients?.name ?? "?").join(" / ")}] — ` +
          `どれか壊れたレコードです。先に重複を解消してください`,
      );
      continue;
    }
    const cert = cands[0];
    const name = cert.clients?.name ?? "(名前不明)";
    if (already.has(cert.client_id)) { skipped.push(`${name}: 既に入力済み — 触らない`); continue; }
    if (cert.jogen_kanri_kubun === "自事業所") {
      // 自事業所管理は関係事業所の金額まで要るので画面の調整計算で作る
      skipped.push(`${name}: 自事業所管理 — 画面の「調整計算」で作成してください`);
      continue;
    }
    // 事業所ごとに管理結果額が違うと 1 行に収まらない (キーに事業所が無い)
    const results = [...new Set(info.entries.map((e) => e.result))];
    const amounts = [...new Set(info.entries.map((e) => e.amount))];
    if (results.length > 1 || amounts.length > 1) {
      skipped.push(
        `${name}: 拠点ごとに管理結果が違う (` +
          info.entries.map((e) => `${e.area}=区分${e.result}/${e.amount}円`).join(", ") +
          `) — 1 行に保存できないため画面から入力してください`,
      );
      continue;
    }
    plan.push({
      clientId: cert.client_id, name, bene,
      kanriResult: results[0], kanriResultAmount: amounts[0],
      officeName: cert.jogen_kanri_office_name ?? info.officeNumber,
      areas: info.entries.map((e) => e.area),
    });
  }

  for (const p of plan) {
    console.log(`  ${p.name.padEnd(12)} 区分${p.kanriResult}  当社分 ${String(p.kanriResultAmount ?? 0).padStart(6)}円  ` +
      `管理: ${p.officeName}  [${p.areas.join(" / ")}]`);
  }
  if (skipped.length) {
    console.log(`\n  -- 取り込まないもの ${skipped.length} 件 --`);
    for (const s of skipped) console.log(`     ${s}`);
  }
  console.log(`\n  取込対象 ${plan.length} 名`);

  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で保存します。"); return; }

  for (const p of plan) {
    const { error: uErr } = await sb.from("shogai_jogen_kanri_results").upsert(
      {
        client_id: p.clientId,
        target_month: MONTH,
        kanri_result: p.kanriResult,
        kanri_result_amount: p.kanriResultAmount,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "client_id,target_month" },
    );
    if (uErr) { console.error(`✗ 保存失敗 (${p.name}): ${uErr.message}`); process.exit(1); }
    console.log(`  ✓ ${p.name}`);
  }
  console.log(`\n✓ ${plan.length} 名を保存しました`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
