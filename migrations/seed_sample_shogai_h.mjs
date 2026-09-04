/**
 * サンプル: 障害 — ★ 実データに 1 件も無い値だけを狙って作る
 *
 *   node migrations/seed_sample_shogai_h.mjs              DRY RUN
 *   node migrations/seed_sample_shogai_h.mjs --execute    投入
 *   node migrations/delete_sample_shogai_h.mjs --execute  撤去
 *
 * ── なぜこの 3 つか (2026-09-04 実測。★ 全部 実データ 0 件) ──────────────
 *   seiho_flag        true が ★ 0 / 575     → 生保の負担 0 円 経路が一度も通っていない
 *   kanri_result      2 が ★ 0 (1 が 8 / 3 が 5)
 *                       区分2 = 他事業所が管理し ★ 当方の利用者負担は 0 円
 *                       間違うと ★ 過大請求。しかも実データで一度も通っていない
 *   self_payment_limit ちょうど上限に張り付く額 → 上限が効くかの境界
 *
 * ⚠ 対象月は MONTH (2026-12) 固定。★ 2026-06 / 2026-07 には 1 行も入れない。
 * ⚠ offices は 1 バイトも変更しない。
 */
import {
  MONTH, MONTH_START, TENANT, marker, noteMarker, userNumber,
  sampleClient, sampleAssignment, insertRows, assertSafeMonth,
} from "./_sample_data.mjs";

const TAG = "h";
const EXECUTE = process.argv.includes("--execute");
assertSafeMonth(MONTH);

/** ＫＴ姉崎ヘルパーステーション (障害事業所番号 1210600019) */
const OFFICE_ID = "e7c3c270-3310-4e83-9d6a-79761070a2c3";

/** 障害マスタで引ける名前。実データに出るものだけを使う (2026-09-04 実測) */
const SERVICE = "身体日１．０";

/**
 * ★ 3 ケース。どれも実データに 1 件も無い組合せ。
 *   期待値は ★ 実装の出力ではなく、規則から手で置く:
 *     生保          → 利用者負担 0 円 / 給付費 = 総費用
 *     上限 0 (非課税) → 同上
 *     管理結果 区分2  → 他事業所が管理。★ 当方の利用者負担は 0 円
 *     上限 4,600 で 1割がそれを超える → 負担は 4,600 で頭打ち
 */
const CASES = [
  { seq: 901, label: "生保 (seiho_flag=true)", seiho: true, limit: 0, kubun: "なし", kanri: null, days: 8 },
  { seq: 902, label: "★ 上限管理=他事業所 / 管理結果 区分2", seiho: false, limit: 37200, kubun: "他事業所", kanri: 2, days: 8 },
  { seq: 903, label: "上限 4,600 で 1割が超える", seiho: false, limit: 4600, kubun: "なし", kanri: null, days: 8 },
];

async function main() {
  console.log(`=== 障害サンプル ${EXECUTE ? "【本番 EXECUTE】" : "【DRY RUN】"} 月=${MONTH} tag=${TAG} ===\n`);
  console.log(`事業所 ${OFFICE_ID} / サービス ${SERVICE}\n`);

  const clients = CASES.map((c) => sampleClient({ tag: TAG, seq: c.seq, careLevel: "要介護2" }));
  // ⚠ ★ insertRows が返すのは **id の配列** (行オブジェクトではない)。
  //   送った順と同じ並びなので index で対応させる。
  //   row.user_number で引こうとして ★ client_id が null になり NOT NULL 違反で落ちた (実際に踏んだ)。
  const insertedIds = await insertRows("clients", clients, { dryRun: !EXECUTE });
  if (EXECUTE && insertedIds.length !== CASES.length) {
    throw new Error(`clients: ${CASES.length} 件送って ${insertedIds.length} 件しか返らない`);
  }
  const idOf = new Map();
  CASES.forEach((c, i) => {
    const id = EXECUTE ? insertedIds[i] : `(dry-run:${c.seq})`;
    if (EXECUTE && !id) throw new Error(`clients: ${userNumber(TAG, c.seq)} の id が取れません`);
    idOf.set(userNumber(TAG, c.seq), id);
  });

  const certs = [], assigns = [], sched = [], kanri = [];
  for (const c of CASES) {
    const cid = idOf.get(userNumber(TAG, c.seq));
    certs.push({
      tenant_id: TENANT, client_id: cid,
      support_level: "区分3",
      certification_start_date: "2026-04-01", certification_end_date: "2027-03-31",
      beneficiary_number: `9${TAG}${String(c.seq).padStart(7, "0")}`.slice(0, 10),
      // ★ 市町村番号は mod10 の検証数字つき。千葉市 (障害) = 121004
      insurer_municipality: "121004",
      self_payment_limit: c.limit,
      seiho_flag: c.seiho,
      jogen_kanri_kubun: c.kubun,
      // ⚠ 他事業所のときは事業所番号が要る (空だと項15 が空で伝送され返戻)
      jogen_kanri_office_number: c.kubun === "他事業所" ? "1210600019" : null,
      jogen_kanri_office_name: c.kubun === "他事業所" ? `サンプル管理事業所 ${marker(TAG)}` : null,
      notes: noteMarker(TAG),
    });
    assigns.push(sampleAssignment(cid, OFFICE_ID));
    for (let d = 1; d <= c.days; d++) {
      sched.push({
        tenant_id: TENANT, user_id: cid, office_id: OFFICE_ID,
        visit_date: `${MONTH}-${String(d).padStart(2, "0")}`,
        start_time: "10:00", end_time: "11:00",
        service_type: SERVICE, status: "completed", system: "障害", billable: true,
        notes: noteMarker(TAG),
      });
    }
    if (c.kanri != null) {
      kanri.push({
        tenant_id: TENANT, client_id: cid, office_id: OFFICE_ID,
        target_month: MONTH, kanri_result: c.kanri,
        // 区分2 = 他事業所で上限に達している → ★ 当方の負担は 0
        kanri_result_amount: 0,
        notes: noteMarker(TAG),
      });
    }
  }

  await insertRows("shougai_certifications", certs, { dryRun: !EXECUTE });
  await insertRows("client_office_assignments", assigns, { dryRun: !EXECUTE });
  await insertRows("kaigo_visit_schedule", sched, { dryRun: !EXECUTE });
  if (kanri.length) await insertRows("shogai_jogen_kanri_results", kanri, { dryRun: !EXECUTE });

  console.log(`\n--- ケース ---`);
  for (const c of CASES) console.log(`  ${userNumber(TAG, c.seq)}  ${c.label}  (実績 ${c.days} 日)`);
  console.log(`\n${EXECUTE ? "投入しました" : "DRY RUN です。--execute で投入します"}`);
  console.log(`月初 ${MONTH_START} / マーカー ${marker(TAG)} ・ ${noteMarker(TAG)}`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
