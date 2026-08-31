// ============================================================================
// 実績 (kaigo_visit_schedule) から 週間パターン (kaigo_visit_patterns) を起こす
//
// 2026-09-01。
//   kaigo_visit_patterns が 1 件しか無く、シフト画面の「予定生成」が使えなかった。
//   一方で 2026-06 の実績は 36,722 件あり、曜日・時刻・サービス種別・担当者が
//   そろっている。**予定の元データは実績側にある**ので、そこから起こす。
//
//   node migrations/extract_visit_patterns_from_jisseki.mjs             # DRY RUN
//   node migrations/extract_visit_patterns_from_jisseki.mjs --execute   # 本番 INSERT
//   MONTH=2026-06 node migrations/extract_visit_patterns_from_jisseki.mjs
//
// 【何に効くか】
//   1. シフトの予定生成 (shift-management-content.tsx が kaigo_visit_patterns を読む)
//   2. 訪問介護計画書の週間サービス (weekly_services) — 同じ抽出結果を使う
//
// 【安定枠だけを採る】
//   「その利用者にその曜日が何日あったか」を分母にして、6 割以上の日に出ている枠だけ
//   パターンにする。月の途中で開始・終了した利用者でも正しく判定できる。
//   隔週や不定期の枠は **採らない**。
//
//   閾値 0.6 は好みではなく **実測で決めた**。生成したパターンを 2026-06 に展開して
//   実績と突き合わせた結果 (verify_visit_patterns_vs_jisseki.mjs):
//
//     RATIO  パターン  空振り(消す)   実績カバー   手作業の合計
//     0.5     7,635    16.7% (5,519)   84.4%      10,608   ※重複 1 件
//     0.6     6,813    12.9% (3,835)   79.3%      10,568   ← 最小・重複 0
//     0.7     6,370    10.6% (2,932)   75.9%      10,782
//     0.8     5,511     8.3% (2,013)   68.0%      12,443
//     1.0     5,137     7.4% (1,640)   63.4%      13,567
//
//   「消す作業 + 手で足す作業」の合計が最小になるのが 0.6。RATIO 環境変数で変えられる。
//
// 【これは予定そのものではない】
//   ここで入れるのは *パターン* で、実際の予定はシフト画面で月を選んで生成し、
//   人が見てから確定する。空振り 12.9% はその画面で消える。
//
// 【担当者 (staff_id)】
//   その枠に最も多く入っている職員が 6 割以上を占めるときだけ入れる。
//   割れているときは null (＝シフト画面で割り当てる)。
//   ⚠ 2 人派遣 (staff_id_2 / staff_id_3) はパターン表に列が無いので落ちる。
//     notes に「2人派遣あり」と残す。
//
// 【マーカー】
//   pattern_name に "<対象月> 実績" を入れる。後から一括削除できるようにするため。
//   既に手で作られたパターンがある利用者は **触らない** (上書き事故を避ける)。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXECUTE = process.argv.includes("--execute");
const MONTH = process.env.MONTH || "2026-06";
const TENANT = "kt-group";
/** 安定と見なす出現率。0.6 = その曜日の 6 割以上の日に出ている */
const STABLE_RATIO = Number(process.env.RATIO ?? "0.6");
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
/** ⚠ order を付けないとページ境界で行が抜ける (Postgres は無指定の行順を保証しない) */
async function fetchAll(table, select, tweak) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    let q = sb.from(table).select(select).order("id").range(from, from + PAGE - 1);
    if (tweak) q = tweak(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table} の取得に失敗: ${error.message}`);
    out.push(...(data ?? []));
    if ((data ?? []).length < PAGE) return out;
  }
}

const hhmm = (v) => String(v ?? "").slice(0, 5);

/**
 * 同じ (利用者, 日, 開始, 終了) に複数行あるものを 1 枠にまとめるための代表サービス名。
 *
 * 実測 (2026-06 / 複数行 1,054 組):
 *   ・重訪 270 組 — 1 回の訪問が **段ごとに 1 行**。14:00-18:00 が 10 行になる。
 *     そのまま予定にすると同じ時間に 10 件並ぶ。段は請求時に時刻から引ける
 *     (lib/shogai-seikyu/code-from-time.ts) ので、予定側は段を持たない。
 *   ・2人派遣 776 組 — 基本行 + 「・２人」行 の 2 行で、職員が別々。
 *     予定は 1 枠。2 人目は notes に残してシフト画面で割り当てる。
 *   ・増分行 6 組 — 「家事夜増２．０」等。基本行のほうを採る。
 */
function representativeService(counts) {
  const all = [...counts.entries()];
  // 「・２人」行は 2 人目の行なので、基本行があるならそちらを採る
  const base = all.filter(([k]) => !/[・･]\s*[２2]人/.test(k));
  const pool = base.length > 0 ? base : all;
  // 増分行 (…増…) も基本行があるならそちらを採る
  const noZou = pool.filter(([k]) => !/増/.test(k));
  const pool2 = noZou.length > 0 ? noZou : pool;

  const juho = pool2.filter(([k]) => k.startsWith("重訪"));
  if (juho.length > 1) {
    // 段が複数 → 段を持たない名前にする。「重訪Ⅱ日中８．０」→「重訪Ⅱ」
    const m = /^(重訪[ⅠⅡⅢIVX]*)/.exec(juho[0][0]);
    if (m) return m[1];
  }
  // 出現回数が最大のものを代表にする
  return pool2.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
}
const monthStart = `${MONTH}-01`;
const monthEnd = (() => {
  const [y, m] = MONTH.split("-").map(Number);
  // m は 1〜12 なので Date.UTC(y, m, 1) がそのまま翌月 1 日
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
})();

const DOW_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

async function main() {
  console.log(`=== 実績→週間パターン 抽出 ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"} ===`);
  console.log(`    対象月 ${MONTH}  (${monthStart} 以上 ${monthEnd} 未満)\n`);

  const [rows, existing] = await Promise.all([
    fetchAll(
      "kaigo_visit_schedule",
      "id, user_id, office_id, visit_date, start_time, end_time, service_type, system, staff_id, staff_id_2, staff_id_3",
      (q) => q.gte("visit_date", monthStart).lt("visit_date", monthEnd).eq("status", "completed"),
    ),
    fetchAll("kaigo_visit_patterns", "id, user_id, pattern_name"),
  ]);
  console.log(`  実績 ${rows.length} 件 / 既存パターン ${existing.length} 件`);

  const skipUsers = new Set(existing.map((p) => p.user_id));

  // ── 1. (利用者, 曜日) ごとに「実績のあった日」を数える = 安定判定の分母 ──
  const dowDays = new Map();
  for (const r of rows) {
    if (!r.visit_date || !r.start_time) continue;
    const dow = new Date(`${r.visit_date}T00:00:00Z`).getUTCDay(); // 0=日〜6=土
    const k = `${r.user_id}|${dow}`;
    if (!dowDays.has(k)) dowDays.set(k, new Set());
    dowDays.get(k).add(r.visit_date);
  }

  // ── 2. 枠ごとに出現日を数える ──
  //   ⚠ キーに service_type を **入れない**。重訪は 1 訪問が段ごとに複数行、
  //     2 人派遣は基本行 + 「・２人」行 に分かれているため、サービス名で切ると
  //     同じ時間帯の予定が複数生成される。時間で束ねて代表名を選ぶ。
  const slots = new Map();
  for (const r of rows) {
    if (!r.visit_date || !r.start_time) continue;
    const dow = new Date(`${r.visit_date}T00:00:00Z`).getUTCDay();
    const key = [r.user_id, dow, hhmm(r.start_time), hhmm(r.end_time), r.system ?? ""].join("|");
    let s = slots.get(key);
    if (!s) {
      s = {
        user_id: r.user_id,
        dow,
        start: hhmm(r.start_time),
        end: hhmm(r.end_time),
        system: r.system ?? null,
        dates: new Set(),
        services: new Map(),
        staffByDate: new Map(),
        multiDates: new Set(),
      };
      slots.set(key, s);
    }
    s.dates.add(r.visit_date);
    const svc = r.service_type ?? "";
    s.services.set(svc, (s.services.get(svc) ?? 0) + 1);
    // 担当者は「日ごとに誰が来たか」で数える (段が 10 行あっても 1 票)
    if (r.staff_id) {
      if (!s.staffByDate.has(r.visit_date)) s.staffByDate.set(r.visit_date, new Set());
      s.staffByDate.get(r.visit_date).add(r.staff_id);
    }
    if (r.staff_id_2 || r.staff_id_3 || /[・･]\s*[２2]人/.test(svc)) s.multiDates.add(r.visit_date);
  }
  console.log(`  枠の総数 ${slots.size} (同じ時間帯の複数行は 1 枠に束ねた後)`);

  // ── 3. 安定した枠だけ採る ──
  const payloads = [];
  let dropUnstable = 0;
  let dropExisting = 0;
  let collapsed = 0;
  let multiCount = 0;
  const bySystem = {};

  for (const s of slots.values()) {
    if (skipUsers.has(s.user_id)) {
      dropExisting += 1;
      continue;
    }
    const denom = dowDays.get(`${s.user_id}|${s.dow}`)?.size ?? 0;
    if (denom === 0) continue;
    if (s.dates.size < Math.max(2, denom * STABLE_RATIO)) {
      dropUnstable += 1;
      continue;
    }

    // 担当者は「その枠に来た日数」の 6 割以上を占める職員だけ。割れているなら null
    const staffDays = new Map();
    for (const ids of s.staffByDate.values()) {
      for (const id of ids) staffDays.set(id, (staffDays.get(id) ?? 0) + 1);
    }
    let staffId = null;
    let top = 0;
    for (const [id, n] of staffDays) {
      if (n > top) {
        top = n;
        staffId = id;
      }
    }
    if (top < s.dates.size * STABLE_RATIO) staffId = null;

    const label = s.system ?? "(未設定)";
    bySystem[label] = (bySystem[label] ?? 0) + 1;

    const notes = [];
    if (s.multiDates.size > 0) {
      notes.push(`2人派遣あり (${s.multiDates.size}日)。2人目はシフト画面で割り当てる`);
      multiCount += 1;
    }
    if (s.services.size > 1) {
      notes.push(`実績のサービス名: ${[...s.services.keys()].join(" / ")}`);
      collapsed += 1;
    }

    payloads.push({
      tenant_id: TENANT,
      user_id: s.user_id,
      pattern_name: `${MONTH} 実績`, // ← 一括削除できるようにマーカーを兼ねる
      day_of_week: s.dow,
      start_time: `${s.start}:00`,
      end_time: `${s.end}:00`,
      service_type: representativeService(s.services),
      system: s.system,
      staff_id: staffId,
      notes: notes.length > 0 ? notes.join(" / ") : null,
    });
  }

  const users = new Set(payloads.map((p) => p.user_id));
  console.log(`\n  ★生成するパターン                ${payloads.length} 件 / 利用者 ${users.size} 名`);
  console.log(`   skip: 不安定な枠 (隔週・不定期)  ${dropUnstable}`);
  console.log(`   skip: 既にパターンがある利用者    ${dropExisting}`);
  console.log(`   担当者が入る                      ${payloads.filter((p) => p.staff_id).length}`);
  console.log(`   制度別: ${JSON.stringify(bySystem)}`);
  console.log(`   複数行を 1 枠に束ねた             ${collapsed}  (重訪の段 / 「・２人」行)`);
  console.log(`   2人派遣を含む枠                   ${multiCount}`);

  if (payloads.length > 0) {
    console.log(`\n  サンプル:`);
    for (const p of payloads.slice(0, 6)) {
      console.log(
        `    ${p.user_id.slice(0, 8)}… ${DOW_LABELS[p.day_of_week]} ` +
          `${p.start_time.slice(0, 5)}-${p.end_time.slice(0, 5)}  ${p.service_type}  ` +
          `[${p.system}]${p.staff_id ? " 担当あり" : ""}`,
      );
    }
  }

  if (!EXECUTE) {
    console.log("\n※ DRY RUN。--execute で INSERT します。");
    console.log(`※ 取り消しは kaigo_visit_patterns の pattern_name = "${MONTH} 実績" を DELETE`);
    return;
  }

  let done = 0;
  for (let i = 0; i < payloads.length; i += 500) {
    const chunk = payloads.slice(i, i + 500);
    const { error } = await sb.from("kaigo_visit_patterns").insert(chunk);
    if (error) {
      console.error(`✗ INSERT 失敗 (${done} 件済): ${error.message}`);
      process.exit(1);
    }
    done += chunk.length;
    console.log(`  ... ${done}/${payloads.length}`);
  }
  console.log(`\n✓ 週間パターンを ${done} 件 生成しました (利用者 ${users.size} 名)。`);
  console.log(`  シフト画面の「予定生成」から使えます。`);
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
