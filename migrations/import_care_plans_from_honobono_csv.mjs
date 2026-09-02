// ============================================================================
// ほのぼの【ケアマネ】→ CSV から出した居宅サービス計画書を取り込む。
//
//   ケアプラン/全/CAREPLAN1.CSV  第1表 (13,940行/4,205名)
//     0 策定機関コード 1 事業所名 2 保険者番号 3 被保険者番号 4 登録年月日
//     5 修正区分 6 作成区分 7 作成日 8 総合的な援助の方針 9 利用者及び家族の意向
//     10 認定有効開始 11 認定有効終了 12 作成者
//   ケアプラン/全/KAIGO1_H31.CSV  第2表 (261,211行/8,243名。H31/1/1〜R8/8/31)
//     ※ 第2表は【ケアマネ】→ CSV → **計画書（2）A様式** から出す。
//        「計画書（2）」ではない。処理期間を狭めると人が落ちる:
//        2025/01〜 だけだと 4,233 名で、第1表にいる 1,562 名が第2表なしになった。
//     0 保険者番号 1 被保険者番号 2 登録年月日 3 作成日 4 表示順
//     5 解決すべき課題 6 長期目標 7 短期目標 8 サービス内容 10 サービス種別/担当者
//     14 サービス事業者名 16 頻度 18 期間 22-27 各期間の開始/終了
//
// ── なぜ要るか ────────────────────────────────────────────────────────
//   請求の一括生成は **status='active' のケアプランを持つ利用者だけ**を対象にする。
//   プランが無いと請求が作られず、そのまま請求漏れになる。
//   2026-06 時点で 40 名が該当 (船橋 4 名で 84,408 円ぶん落ちていた)。
//
// ── 方針 (2026-08-30 user 確定) ────────────────────────────────────────
//   1 人が 20 ヶ月ぶん複数回登録されている (平均 3.3 回) が、**最新の 1 件だけ**
//   取り込む。過去の改訂履歴は移さない。ただし対象月に有効なものを選ぶため、
//   「作成日 <= 対象月末」の中で最も新しいものを採る。
//
//   ⚠ 既にプランがある利用者は **触らない**。足りない人だけ足す。
//
//   node migrations/import_care_plans_from_honobono_csv.mjs             # DRY RUN
//   node migrations/import_care_plans_from_honobono_csv.mjs --execute
//   env: MONTH=2026-06
//   --with-services  第2表 (サービス内容) も入れる
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import iconv from "iconv-lite";

const EXECUTE = process.argv.includes("--execute");
const WITH_SERVICES = process.argv.includes("--with-services");
/** 第1表だけで作った既存プランに、同じ世代の第2表を後から流し込む */
const BACKFILL = process.argv.includes("--backfill-services");
const MONTH = process.env.MONTH || "2026-06";
const MONTH_END = new Date(Number(MONTH.slice(0, 4)), Number(MONTH.slice(5, 7)), 0)
  .toISOString().slice(0, 10);
const TENANT = "kt-group";
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
/**
 * 第2表の 課題・長期目標・短期目標・期間 の列。
 * care_plan_services_goals.sql を当てる前の DB では列が無いので、
 * hasGoalCols が false のときは何も足さない (取込自体は通る)。
 */
let hasGoalCols = false;
/**
 * care_manager_name (2026-09-02 追加): CSV の「作成者」氏名をそのまま保存する。
 * care_manager_number (公式ソース=居宅サービス計CSV) が引けない/未取込の間も、
 * 後から名前ベースで正しいケアマネ番号を追跡できるようにするための列。
 * 列が無い DB (migration未適用) では何も足さず取込自体は通す。
 */
let hasCmNameCol = false;
const goalCols = (s) => (!hasGoalCols ? {} : {
  needs: s.issue || null,
  long_term_goal: s.longGoal || null,
  long_term_start: s.longStart, long_term_end: s.longEnd,
  short_term_goal: s.shortGoal || null,
  short_term_start: s.shortStart, short_term_end: s.shortEnd,
  service_start: s.svcStart, service_end: s.svcEnd,
  display_order: Number.isFinite(s.order) ? s.order : null,
});

const env = loadEnv();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const splitCsv = (line) => {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
};
const readCsv = (rel) => {
  const text = iconv.decode(readFileSync(path.join(KAIGO, rel)), "Shift_JIS");
  const rows = text.split(/\r?\n/).filter((l) => l.trim()).map((l) => splitCsv(l).map((s) => s.trim()));
  return { head: rows[0], rows: rows.slice(1) };
};
const iso = (s) => {
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec((s ?? "").trim());
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
};
/** 「R 8/ 7/ 1～R 8/12/31」→ ["2026-07-01","2026-12-31"] */
const parseWareki = (s) => {
  const out = [];
  for (const m of (s ?? "").matchAll(/R\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/g)) {
    out.push(`${2018 + Number(m[1])}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`);
  }
  return out;
};

async function main() {
  console.log(`=== ケアプラン取込 ${MONTH} ${EXECUTE ? "【EXECUTE】" : "【DRY RUN】"}` +
    `${WITH_SERVICES ? " + 第2表" : ""} ===\n`);

  // 第2表の 課題・目標・期間 の列があるか (care_plan_services_goals.sql)
  {
    const probe = await sb.from("kaigo_care_plan_services").select("needs").limit(1);
    hasGoalCols = !probe.error;
    if (!hasGoalCols && !/needs/.test(probe.error.message)) {
      console.error(`✗ 第2表の照会に失敗: ${probe.error.message}`); process.exit(1);
    }
    console.log(hasGoalCols
      ? "  第2表: 課題・長期目標・短期目標・期間の列あり"
      : "  ⚠ 第2表に課題・目標の列が無いのでサービス行だけ入れます (care_plan_services_goals.sql 未適用)");
  }
  {
    const probe = await sb.from("kaigo_care_plans").select("care_manager_name").limit(1);
    hasCmNameCol = !probe.error;
    console.log(hasCmNameCol
      ? "  care_manager_name 列あり: CSVの作成者氏名を保存します"
      : "  ⚠ care_manager_name 列が無いので作成者氏名は保存しません (add_care_manager_name.sql 未適用)");
  }

  // ⚠ 第1表には **2 種類の書式**がある。列数で見分ける。
  //   13列版: 策定機関コード/事業所名/保険者/被保番/登録年月日/…/作成者
  //   23列版: 法人名/施設名/事業所名/**利用者名**/保険者/被保番/作成日/作成者/
  //           意向/審査会の意向/援助方針/**計画区分**/認定区分/初回作成日/…
  //   23列版のほうが情報が多い (利用者名・計画区分・審査会の意向)。
  //   計画区分 = 初回 / 初回紹介 なら **初回加算**が判定できる。
  const t1 = readCsv(existsSync(path.join(KAIGO, "ケアプラン/全/CAREPLAN1_R5.CSV"))
    ? "ケアプラン/全/CAREPLAN1_R5.CSV" : "ケアプラン/全/CAREPLAN1.CSV");
  const wide = t1.head.length >= 23;      // 23列版か
  const C = wide
    ? { office: 2, insurer: 4, insured: 5, made: 6, author: 7, ikou: 8, houshin: 10, kubun: 11, certFrom: 15, certTo: 16 }
    : { office: 1, insurer: 2, insured: 3, made: 7, author: 12, ikou: 9, houshin: 8, kubun: null, certFrom: 10, certTo: 11 };
  console.log(`  第1表は ${t1.head.length} 列版`);
  const t2 = readCsv(existsSync(path.join(KAIGO, "ケアプラン/全/KAIGO1_H31.CSV"))
    ? "ケアプラン/全/KAIGO1_H31.CSV" : "ケアプラン/全/KAIGO1.CSV");
  console.log(`  第1表 ${t1.rows.length} 行 / 第2表 ${t2.rows.length} 行`);

  // (保険者, 被保番) → 対象月に有効な最新の第1表
  // 対象月に使う計画の選び方:
  //   ① 対象月末までに作られたものの中で **最も新しい**もの (通常はこれ)
  //   ② ①が無い人だけ、対象月より後で **最も古い**もので補う
  // 単純に「今日まで」にすると、7・8 月に改訂された計画で 6 月の請求を作ってしまう。
  // ②が要るのは請求はあるのに計画書の登録が遅れた人 (小池美乃里 2026/07/17 /
  // 前嶋明 2026/07/30。どちらも 6 月に請求が立っている)。
  const latest = new Map();     // ① 対象月末まで
  const after = new Map();      // ② 対象月より後
  for (const r of t1.rows) {
    if (r.length <= C.certTo) continue;
    const key = `${r[C.insurer]}|${r[C.insured]}`;
    const made = iso(r[C.made]);
    if (!made) continue;
    const rec = { made, office: r[C.office], houshin: r[C.houshin], ikou: r[C.ikou],
      certFrom: iso(r[C.certFrom]), certTo: iso(r[C.certTo]), author: r[C.author],
      kubun: C.kubun == null ? null : r[C.kubun], late: made > MONTH_END };
    if (made <= MONTH_END) {
      const cur = latest.get(key);
      if (!cur || made > cur.made) latest.set(key, rec);
    } else {
      const cur = after.get(key);
      if (!cur || made < cur.made) after.set(key, rec);   // 後ろ側は最も古いもの
    }
  }
  let lateCount = 0;
  for (const [k, v] of after) if (!latest.has(k)) { latest.set(k, v); lateCount++; }
  if (lateCount) console.log(`  うち ${lateCount} 名は対象月より後の計画で補完 (計画書の登録が遅れた人)`);
  console.log(`  対象月に有効な第1表 ${latest.size} 名\n`);

  // 第2表を (保険者, 被保番, 作成日) で束ねる
  const services = new Map();
  for (const r of t2.rows) {
    if (r.length < 18) continue;
    const key = `${r[0]}|${r[1]}`;
    const made = iso(r[3]) ?? iso(r[2]);
    const l = latest.get(key);
    if (!l || made !== l.made) continue;              // 採用した世代の行だけ
    if (!services.has(key)) services.set(key, []);
    services.get(key).push({
      order: Number(r[4] || 0), issue: r[5], longGoal: r[6], shortGoal: r[7],
      content: r[8], kind: r[10], provider: r[14], freq: r[16], period: r[18],
      // 第2表は 課題 → 長期目標 → 短期目標 → サービス の入れ子。
      // 期間まで持たないと帳票のブロックが組めない (22-27 が各期間の開始/終了)
      longStart: iso(r[22]), longEnd: iso(r[23]),
      shortStart: iso(r[24]), shortEnd: iso(r[25]),
      svcStart: iso(r[26]), svcEnd: iso(r[27]),
    });
  }

  // 当方の利用者を (保険者, 被保番) で引く
  let ins = [], from = 0;
  for (;;) {
    const { data, error } = await sb.from("client_insurance_records")
      .select("client_id, insurer_number, insured_number").order("id").range(from, from + 999);
    if (error) { console.error(`✗ ${error.message}`); process.exit(1); }
    ins = ins.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  const clientByKey = new Map();
  for (const r of ins) {
    if (!r.insurer_number || !r.insured_number) continue;
    const k = `${r.insurer_number}|${r.insured_number}`;
    if (!clientByKey.has(k)) clientByKey.set(k, new Set());
    clientByKey.get(k).add(r.client_id);
  }

  // 既に active プランを持つ利用者
  let have = new Set(); from = 0;
  for (;;) {
    const { data, error } = await sb.from("kaigo_care_plans")
      .select("user_id").eq("status", "active").order("id").range(from, from + 999);
    if (error) { console.error(`✗ ${error.message}`); process.exit(1); }
    for (const r of data) have.add(r.user_id);
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`  当方: active プランを持つ利用者 ${have.size} 名\n`);

  // 2026-06 にレセプトがある利用者 = 取り込むべき対象
  let claimUsers = new Set(); from = 0;
  for (;;) {
    const { data, error } = await sb.from("kaigo_care_support_claims")
      .select("user_id").eq("billing_month", MONTH).order("id").range(from, from + 999);
    if (error) { console.error(`✗ ${error.message}`); process.exit(1); }
    for (const r of data) claimUsers.add(r.user_id);
    if (data.length < 1000) break;
    from += 1000;
  }

  const plans = [], problems = [];
  for (const [key, l] of latest) {
    const cids = clientByKey.get(key);
    if (!cids) continue;                               // 当方に居ない (他事業所の利用者等)
    if (cids.size > 1) { problems.push(`${key}: 当方の利用者が ${cids.size} 名で特定できない`); continue; }
    const cid = [...cids][0];
    if (have.has(cid)) continue;                       // 既にプランあり = 触らない
    if (!claimUsers.has(cid)) continue;                // 当月レセプトが無い人は対象外
    plans.push({ cid, key, l, svc: services.get(key) ?? [] });
  }

  for (const p of plans) {
    const { data } = await sb.from("clients").select("name").eq("id", p.cid).maybeSingle();
    p.name = data?.name ?? "?";
  }
  plans.sort((a, b) => a.l.office.localeCompare(b.l.office, "ja"));

  for (const p of plans) {
    console.log(`  ${p.name.padEnd(14)} ${p.l.office}  作成日 ${p.l.made}  サービス ${p.svc.length} 行`);
  }
  if (problems.length) {
    console.log(`\n  -- 取り込めないもの ${problems.length} 件 --`);
    for (const q of problems.slice(0, 10)) console.log(`     ${q}`);
  }
  console.log(`\n  新規プラン ${plans.length} 名 / サービス行 ${plans.reduce((s, p) => s + p.svc.length, 0)} 行`);

  // ── 既存プランへの第2表バックフィル ───────────────────────────────────
  //   第1表だけで作ったプランは中身が空 (サービスも目標も無い) なので、
  //   同じ世代の第2表を後から流し込む。既にサービス行がある人は触らない。
  let back = [];
  if (BACKFILL) {
    const keyByClient = new Map();
    for (const [k, set] of clientByKey) for (const cid of set) {
      if (set.size === 1) keyByClient.set(cid, k);
    }
    let existing = [], f2 = 0;
    for (;;) {
      const { data, error } = await sb.from("kaigo_care_plans")
        .select("id, user_id, long_term_goals, short_term_goals")
        .eq("status", "active").order("id").range(f2, f2 + 999);
      if (error) { console.error(`✗ ${error.message}`); process.exit(1); }
      existing = existing.concat(data);
      if (data.length < 1000) break;
      f2 += 1000;
    }
    let hasSvc = new Set(); f2 = 0;
    for (;;) {
      const { data, error } = await sb.from("kaigo_care_plan_services")
        .select("care_plan_id").order("id").range(f2, f2 + 999);
      if (error) { console.error(`✗ ${error.message}`); process.exit(1); }
      for (const r of data) hasSvc.add(r.care_plan_id);
      if (data.length < 1000) break;
      f2 += 1000;
    }
    for (const pl of existing) {
      if (hasSvc.has(pl.id)) continue;
      const k = keyByClient.get(pl.user_id);
      if (!k) continue;
      const svc = services.get(k);
      if (!svc || !svc.length) continue;
      back.push({ id: pl.id, key: k, svc, plan: pl });
    }
    console.log(`  既存プランへの第2表バックフィル ${back.length} 名 / ` +
      `${back.reduce((s, b) => s + b.svc.length, 0)} 行`);
  }

  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で保存します。"); return; }

  for (const p of plans) {
    const longs = [...new Set(p.svc.map((s) => s.longGoal).filter(Boolean))].join("\n");
    const shorts = [...new Set(p.svc.map((s) => s.shortGoal).filter(Boolean))].join("\n");
    const { data: made, error } = await sb.from("kaigo_care_plans").insert({
      tenant_id: TENANT, user_id: p.cid, plan_type: "居宅サービス計画", plan_number: 1,
      start_date: p.l.made, end_date: null, status: "active",
      long_term_goals: longs || null, short_term_goals: shorts || null,
      // ⚠ created_by は uuid 列 (members への FK)。CSV の作成者は氏名なので入らない。
      //   氏名は care_manager_name に保存する (care_manager_number が未確定でも追跡可能にするため)。
      ...(hasCmNameCol ? { care_manager_name: p.l.author || null } : {}),
    }).select("id").single();
    if (error) { console.error(`✗ ${p.name}: ${error.message}`); process.exit(1); }
    if (WITH_SERVICES && p.svc.length) {
      const rows = p.svc.sort((a, b) => a.order - b.order).map((s) => ({
        tenant_id: TENANT, care_plan_id: made.id,
        // service_type は NOT NULL。種別が空の行があるのでサービス内容で補う
        service_type: s.kind || s.content || "その他",
        service_content: s.content || s.kind || "（記載なし）",
        frequency: [s.freq, s.period].filter(Boolean).join(" ") || null,
        provider: s.provider || null,
        notes: s.issue ? `課題: ${s.issue}` : null,
        ...goalCols(s),
      }));
      const { error: e2 } = await sb.from("kaigo_care_plan_services").insert(rows);
      if (e2) { console.error(`✗ ${p.name} のサービス: ${e2.message}`); process.exit(1); }
    }
    console.log(`  ✓ ${p.name} (サービス ${WITH_SERVICES ? p.svc.length : 0} 行)`);
  }
  let bn = 0, brows = 0;
  for (const b of back) {
    const rows = b.svc.slice().sort((a, c) => a.order - c.order).map((s) => ({
      tenant_id: TENANT, care_plan_id: b.id,
      service_type: s.kind || s.content || "その他",
      service_content: s.content || s.kind || "（記載なし）",
      frequency: [s.freq, s.period].filter(Boolean).join(" ") || null,
      provider: s.provider || null,
      notes: s.issue ? `課題: ${s.issue}` : null,
      ...goalCols(s),
    }));
    const { error } = await sb.from("kaigo_care_plan_services").insert(rows);
    if (error) { console.error(`✗ ${b.key} のサービス: ${error.message}`); process.exit(1); }
    // 目標が空なら第2表から埋める
    const longs = [...new Set(b.svc.map((s) => s.longGoal).filter(Boolean))].join("\n");
    const shorts = [...new Set(b.svc.map((s) => s.shortGoal).filter(Boolean))].join("\n");
    const patch = {};
    if (!b.plan.long_term_goals && longs) patch.long_term_goals = longs;
    if (!b.plan.short_term_goals && shorts) patch.short_term_goals = shorts;
    if (Object.keys(patch).length) {
      const { error: e2 } = await sb.from("kaigo_care_plans").update(patch).eq("id", b.id);
      if (e2) { console.error(`✗ ${b.key} の目標: ${e2.message}`); process.exit(1); }
    }
    bn++; brows += rows.length;
    if (bn % 200 === 0) console.log(`  … ${bn}/${back.length}`);
  }

  console.log(`\n✓ ${plans.length} 名のケアプランを作成しました` +
    (BACKFILL ? ` / 既存 ${bn} 名に第2表 ${brows} 行を追加しました` : ""));
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
