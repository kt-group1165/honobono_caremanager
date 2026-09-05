/**
 * 訪問介護 (介護保険) のサンプルデータ — 担当 K / マーカー `ZK###` `[sample-k]`
 *
 * SAMPLE_DATA_PROTOCOL.md の取り決めに従う。対象月は **2026-12** 固定。
 *
 *   node migrations/seed_sample_houmon_kaigo_k.mjs            # DRY RUN (既定)
 *   node migrations/seed_sample_houmon_kaigo_k.mjs --delete   # ★ 撤去 (先に確認すること)
 *   node migrations/seed_sample_houmon_kaigo_k.mjs --execute  # 投入
 *
 * ── 何を確かめるためのデータか ────────────────────────────────────────────
 *   段1 算定・単位数: 下の EXPECTED は **告示の基本単位から手で組んだ独立の期待値**。
 *                     マスタを引いて作っていないので、マスタが誤っていれば差が出る
 *                     (VERIFICATION_RULES 3-2: 現状維持を成功指標にしない)。
 *   段2 伝送様式:     この集計から 7111/7131 を生成して項番・桁・恒等式を見る。
 *
 * ── ★ 踏むと分かるように書いてある罠 ─────────────────────────────────────
 *   ① 身体９系は **所要時間で単位数が変わる可変コード**。マスタの 1124 は
 *      240〜269分の **基準値**にすぎない。集計は service_type (名前) しか見ず
 *      時刻を見ないので、**270分以上の訪問はすべて過少**になる。
 *      実測 (2026-09-03): ほのぼのは 289分 で 1206単位 (基準+82) を請求している。
 *      → ZK006 がこれを踏む。期待値は「現行実装が返すはずの 1124」ではなく
 *        **所要時間から導いた 1288** を書いてある。**差が出るのが正しい。**
 *   ② 身体９系 168 コードのうち **162 コードは単位数 0**。使うと 0 円になる。
 *      推測で埋めると誤請求になるため保留されている (SESSION_START の記載が正しい)。
 *   ③ `clients.copay_rate` は "10"/"20"/"30"、`client_insurance_records.copay_rate` は
 *      "1"/"2"/"3" で **同名だが単位が違う**。集計が読むのは認定側。
 *      _sample_data.mjs の COPAY がこれを吸収しているので、直接書かないこと。
 */
import {
  sb, MONTH, MONTH_START, TENANT, TAGS, marker, noteMarker, userNumber,
  sampleClient, sampleInsurance, sampleAssignment, insertRows, deleteByTag, assertSafeMonth,
  LIMIT_UNITS,
} from "./_sample_data.mjs";

const TAG = TAGS.k;
const DELETE = process.argv.includes("--delete");
const EXECUTE = process.argv.includes("--execute");
const DRY = !EXECUTE && !DELETE;
assertSafeMonth(MONTH);

/** 投入先の実在事業所 (offices は 1 バイトも変更しない) */
const OFFICE_BN = "1270501180"; // Ｈａｎａヘルパーステーションおゆみ野

/**
 * ★ 独立の期待値。告示の基本単位から手で組んだもの。**マスタを引いていない。**
 *   夜間 ×1.25 / 深夜 ×1.50 / 2人 ×2 は告示の割増率。端数は円未満切り捨て前の単位で持つ。
 */
const UNITS = {
  "身体介護１": 244,
  "身体介護１・夜": 305,          // 244 × 1.25
  "身体介護１・深": 366,          // 244 × 1.50
  "身体介護１・２人": 488,        // 244 × 2
  "身体介護２": 387,
  "身体介護３": 567,
  "身体介護４": 649,              // 567 + 82
  "身体１生活１": 309,            // 244 + 65
  "身体２生活２": 517,            // 387 + 130
  "通院等乗降介助": 97,
  // ★ 身体９生活１: 240〜269分=1124 / 270〜299分=1206 / 300〜329分=1288
  //   下の ZK006 は 315分 なので **1288 が正**。マスタの固定値 1124 とは 164 ずれる
  "身体９生活１": 1288,
};

/** 利用者ごとのバリエーション。回数は月内の実施回数 */
const PLAN = [
  {
    seq: 1, careLevel: "要介護1", copayIdx: 0, note: "限度額内・基本パターン",
    visits: [["身体介護１", 10], ["身体１生活１", 4]],
  },
  {
    seq: 2, careLevel: "要介護2", copayIdx: 1, note: "2割負担・生活援助あり",
    visits: [["身体介護２", 12], ["身体２生活２", 6]],
  },
  {
    seq: 3, careLevel: "要介護3", copayIdx: 2, note: "3割負担・限度額を超える量",
    visits: [["身体介護３", 40], ["身体介護４", 12]],
  },
  {
    seq: 4, careLevel: "要介護5", copayIdx: 0, note: "夜間・深夜・2人派遣",
    visits: [["身体介護１・夜", 8], ["身体介護１・深", 4], ["身体介護１・２人", 6]],
  },
  {
    seq: 5, careLevel: "要介護1", copayIdx: 0, note: "通院等乗降介助",
    visits: [["通院等乗降介助", 8], ["身体介護１", 4]],
  },
  {
    seq: 6, careLevel: "要介護4", copayIdx: 0, note: "★ 身体９系 (所要時間可変コード) を踏む",
    visits: [["身体９生活１", 1]],
    // 09:00-14:15 = 315分。基準 1124 ではなく 1288 が正しいはず
    times: [["09:00", "14:15"]],
  },
];

const expectedUnits = (p) => p.visits.reduce((s, [name, n]) => s + UNITS[name] * n, 0);

function printPlan() {
  console.log(`\n段1 の期待値 (★ マスタを引かずに告示の基本単位から手で組んだもの)`);
  for (const p of PLAN) {
    const un = userNumber(TAG, p.seq);
    const total = expectedUnits(p);
    const limit = LIMIT_UNITS[p.careLevel];
    const over = Math.max(0, total - limit);
    console.log(`  ${un} ${p.careLevel} ${["1割","2割","3割"][p.copayIdx]}  ${p.note}`);
    for (const [name, n] of p.visits)
      console.log(`      ${name.padEnd(16)} ${UNITS[name]}単位 × ${n}回 = ${UNITS[name] * n}`);
    console.log(`      合計 ${total} 単位 / 限度額 ${limit} → ${over > 0 ? `★ 超過 ${over} 単位 (全額自費)` : "限度内"}`);
  }
}

/** 月内に visits を日付へ散らす。2026-12-01 から 1 日 1 件ずつ */
function buildShifts(clientId, p) {
  const rows = [];
  let day = 1;
  for (const [name, n] of p.visits) {
    for (let i = 0; i < n; i++) {
      const [st, en] = p.times?.[0] ?? ["09:00", "10:00"];
      rows.push({
        tenant_id: TENANT,
        user_id: clientId,
        staff_id: null, // nullable。実測 40,381 行中 3,226 行が null
        visit_date: `${MONTH}-${String(day).padStart(2, "0")}`,
        start_time: `${st}:00`,
        end_time: `${en}:00`,
        service_type: name,
        status: "completed",
        system: "介護",
        notes: `サンプル ${noteMarker(TAG)}`,
      });
      day = day >= 28 ? 1 : day + 1;
    }
  }
  return rows;
}

async function main() {
  console.log(`=== 訪問介護 サンプル (担当 ${TAG} / 対象月 ${MONTH}) ${DELETE ? "【撤去】" : EXECUTE ? "【投入】" : "【DRY RUN】"} ===`);

  if (DELETE) {
    // ★ clients を消す前にシフトを消す。
    // ⚠ kaigo_visit_schedule の外部キーは client_id ではなく **user_id**。
    //   client_id で消そうとすると途中で落ちてサンプルが残る (C が実際に踏んだ)。
    await deleteByTag(TAG, {
      dryRun: false,
      extraTables: [{ table: "kaigo_visit_schedule", key: "user_id" }],
    });
    return;
  }

  const { data: offs, error: oe } = await sb
    .from("offices").select("id, name").eq("business_number", OFFICE_BN).limit(1);
  if (oe) throw new Error(`事業所の取得に失敗: ${oe.message}`);
  if (!offs?.length) throw new Error(`事業所番号 ${OFFICE_BN} が見つかりません`);
  const office = offs[0];
  console.log(`投入先: ${office.name} (${OFFICE_BN})`);

  printPlan();

  // 既に入っていないか (二重投入の防止)
  const { data: exist, error: ee } = await sb
    .from("clients").select("id").like("user_number", `Z${TAG.toUpperCase()}%`);
  if (ee) throw new Error(`既存確認に失敗: ${ee.message}`);
  if (exist?.length) {
    console.log(`\n⚠ 既に ${exist.length} 名入っています。--delete で撤去してから投入してください。`);
    return;
  }

  console.log(`\n${DRY ? "[DRY] " : ""}投入:`);
  let shiftTotal = 0;
  for (const p of PLAN) {
    const client = sampleClient({ tag: TAG, seq: p.seq, careLevel: p.careLevel, copayIdx: p.copayIdx });
    client.name = `訪問介護サンプル${p.seq} ${marker(TAG)}`;
    const [clientId] = await insertRows("clients", [client], { dryRun: DRY });
    // ⚠ 集計は被保険者番号を **client_insurance_records 側** から読む
    //   (aggregate.ts:1978 `cert?.insured_number`)。_sample_data.mjs の
    //   sampleInsurance は insured_number を入れないので、ここで補う。
    //   入れないと buildKokuhoDensou が「被保険者番号が未登録」で伝送から除外し、
    //   段2 が 1 行も検証できない (実際に踏んだ)。
    // ⚠ 2026-09-05 是正: tag+seq (または insuredNumber) を渡さないと sampleInsurance が
    //   即 throw する (_sample_data.mjs 2026-09-03 是正で追加された安全チェック)。
    //   extra.insured_number は throw の後に評価されるため単独では効かない。
    await insertRows("client_insurance_records",
      [sampleInsurance(clientId, {
        careLevel: p.careLevel, copayIdx: p.copayIdx, tag: TAG, seq: p.seq,
        extra: { insured_number: client.insured_number },
      })], { dryRun: DRY });
    await insertRows("client_office_assignments",
      [sampleAssignment(clientId, office.id)], { dryRun: DRY });
    const shifts = buildShifts(clientId, p);
    await insertRows("kaigo_visit_schedule", shifts, { dryRun: DRY });
    shiftTotal += shifts.length;
    console.log(`  ${userNumber(TAG, p.seq)} ${p.careLevel} — シフト ${shifts.length} 件`);
  }
  console.log(`\n利用者 ${PLAN.length} 名 / シフト ${shiftTotal} 件`);

  if (DRY) { console.log("\n※ DRY RUN。--execute で投入します。先に --delete が動くことを確認すること。"); return; }

  // ★ 投入後に件数を実際に数えて verify する (SAMPLE_DATA_PROTOCOL 4章)
  const { data: cs, error: ce } = await sb
    .from("clients").select("id").like("user_number", `Z${TAG.toUpperCase()}%`);
  if (ce) throw new Error(`確認クエリ失敗: ${ce.message}`);
  const ids = (cs ?? []).map((c) => c.id);
  const { count, error: se } = await sb
    .from("kaigo_visit_schedule").select("*", { count: "exact", head: true })
    .in("user_id", ids).gte("visit_date", MONTH_START);
  if (se) throw new Error(`確認クエリ失敗: ${se.message}`);
  console.log(`✅ 投入確認: clients ${ids.length} 名 / シフト ${count} 件`);
  if (ids.length !== PLAN.length || count !== shiftTotal)
    throw new Error(`件数が合いません (期待 ${PLAN.length}名/${shiftTotal}件)`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
