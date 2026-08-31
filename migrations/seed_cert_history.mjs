/**
 * 認定履歴 seed — サンプル利用者の client_insurance_records に「過去方向の」更新履歴を追加する。
 *
 * 対象:
 *   client_memos.body LIKE '%[fake テスト用%' でマークされた fake 利用者のみ
 *   (= seed_fake_kyotaku_clients.mjs の A/B/C/D/E/X 50 名 + seed_fake_houmonkaigo_clients.mjs の OY 10 名)。
 *   実利用者は client_memos にこのマーカーが無いので対象外 (安全側)。
 *
 * 方針 (請求計算を変えない):
 *   - 各利用者の最新認定 (anchor) を起点に、**過去に** 前認定を 1〜2 件 INSERT するだけ。
 *     既存認定の期間は原則いじらない。
 *   - 3 人に 1 人 (idx % 3 === 0) は「区分変更」パターン:
 *       前認定 (anchor 開始の 2 年前〜前日) + 区分変更前の認定 (anchor 開始〜変更日前日, 要介護度±1)
 *       を INSERT し、anchor の certification_start_date を変更日に UPDATE。
 *     ※ anchor の start を動かすため、[元 start, 変更日) に実績
 *       (kaigo_report_documents service-usage の report_month / kaigo_visit_records の visit_date)
 *       が 1 件でもある場合は 区分変更を諦めて通常パターンに fallback する。
 *   - 追加行の notes には '[fake テスト用-cert-history]' マーカー (後で一括削除可能)。
 *   - UPDATE する anchor 行は実行前に migrations/_backup_cert_history_updates_<yyyymmdd>.json に snapshot。
 *
 * 再実行安全:
 *   notes LIKE '%[fake テスト用-cert-history]%' の行が既にある利用者は skip。
 *
 * Usage:
 *   node migrations/seed_cert_history.mjs              # DRY RUN (計画表示のみ)
 *   node migrations/seed_cert_history.mjs --execute    # 本番実行 (+ 件数確認)
 *
 * 削除する場合:
 *   DELETE FROM client_insurance_records WHERE notes LIKE '%[fake テスト用-cert-history]%';
 *   (区分変更で動かした anchor start は backup JSON から復元)
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── env 読み取り (kaigo-app .env.local → calendar-app .env.local fallback) ──
function loadEnvFile(path) {
  try {
    const env = readFileSync(path, "utf8");
    const vars = {};
    for (const line of env.split("\n")) {
      const m = line.match(/^([^=]+)=(.+)$/);
      if (m) vars[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return vars;
  } catch {
    return {};
  }
}
const envKaigo = loadEnvFile(join(__dirname, "..", ".env.local"));
const envCal = loadEnvFile(join(__dirname, "..", "..", "calendar-app", ".env.local"));
const SB_URL =
  envKaigo.NEXT_PUBLIC_SUPABASE_URL ||
  envCal.NEXT_PUBLIC_SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY =
  envKaigo.SUPABASE_SERVICE_ROLE_KEY ||
  envCal.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  console.error("❌ SUPABASE URL / SERVICE_ROLE_KEY が読めません (.env.local 確認)");
  process.exit(1);
}
const sb = createClient(SB_URL, SB_KEY);

const EXECUTE = process.argv.includes("--execute");
const FAKE_CLIENT_MARKER = "[fake テスト用"; // 前方一致 (kyotaku / houmon 両方に合致)
const CERT_HISTORY_MARKER = "[fake テスト用-cert-history]";

// ── date helpers (YYYY-MM-DD 文字列ベース、TZ 安全) ──
function addYears(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return `${String(y + n).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}
function addMonthsFirstDay(dateStr, n) {
  const [y, m] = dateStr.split("-").map(Number);
  const total = (y * 12 + (m - 1)) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-01`;
}
function monthOf(dateStr) {
  return dateStr.slice(0, 7); // YYYY-MM
}
/** [from, to) の月リスト (YYYY-MM) */
function monthsBetween(fromDate, toDateExclusive) {
  const out = [];
  let cur = `${monthOf(fromDate)}-01`;
  while (cur < toDateExclusive) {
    out.push(monthOf(cur));
    cur = addMonthsFirstDay(cur, 1);
  }
  return out;
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ── 要介護度 ±1 ──
const LEVELS = ["要支援1", "要支援2", "要介護1", "要介護2", "要介護3", "要介護4", "要介護5"];
function shiftLevel(level) {
  const i = LEVELS.indexOf(level);
  if (i < 0) return null; // 申請中/事業対象者 等は区分変更対象にしない
  if (i > 0) return LEVELS[i - 1]; // 原則 1 段軽い方 (= 区分変更で重度化した体)
  return LEVELS[i + 1]; // 要支援1 だけは +1
}

// ── page-loop fetch helper ({ error } 必ず check) ──
async function fetchAll(table, buildQuery) {
  const PAGE = 1000;
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await buildQuery(sb.from(table)).order("id").order("id").range(from, from + PAGE - 1);
    if (error) {
      console.error(`❌ ${table} fetch failed:`, error.message);
      process.exit(1);
    }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

async function main() {
  console.log(EXECUTE ? "=== EXECUTE MODE ===" : "=== DRY RUN (--execute で本番実行) ===");
  const today = todayStr();

  // 1) fake 利用者の client_id 抽出 (client_memos マーカー経由)
  const memoRows = await fetchAll("client_memos", (q) =>
    q.select("client_id, body").like("body", `%${FAKE_CLIENT_MARKER}%`),
  );
  const fakeIds = [...new Set(memoRows.map((r) => r.client_id))];
  console.log(`fake マーカー付き利用者: ${fakeIds.length} 名`);
  if (fakeIds.length === 0) {
    console.log("対象なし。終了。");
    return;
  }

  // 2) clients 情報 (表示用 + user_number で順序を固定)
  const clients = await fetchAll("clients", (q) =>
    q.select("id, user_number, name").in("id", fakeIds).order("user_number"),
  );
  const clientById = new Map(clients.map((c) => [c.id, c]));

  // 3) 既存認定 (全件) — anchor 抽出 + 既 seed 判定
  const certs = await fetchAll("client_insurance_records", (q) =>
    q
      .select(
        "id, tenant_id, client_id, care_level, certification_start_date, certification_end_date, certification_status, insured_number, insurer_number, care_office_id, benefit_rate, notes",
      )
      .in("client_id", fakeIds)
      .order("client_id")
      .order("certification_start_date", { ascending: false }),
  );
  const certsByClient = new Map();
  for (const c of certs) {
    if (!certsByClient.has(c.client_id)) certsByClient.set(c.client_id, []);
    certsByClient.get(c.client_id).push(c);
  }

  // 4) 実績月 (区分変更の安全判定用):
  //    kaigo_report_documents (service-usage の report_month) + kaigo_visit_records (visit_date の月)
  const usageDocs = await fetchAll("kaigo_report_documents", (q) =>
    q
      .select("user_id, report_month")
      .in("user_id", fakeIds)
      .eq("report_type", "service-usage"),
  );
  const visitRecs = await fetchAll("kaigo_visit_records", (q) =>
    q.select("user_id, visit_date").in("user_id", fakeIds),
  );
  const jissekiMonths = new Map(); // client_id -> Set<YYYY-MM>
  const addMonth = (id, ym) => {
    if (!ym) return;
    if (!jissekiMonths.has(id)) jissekiMonths.set(id, new Set());
    jissekiMonths.get(id).add(ym);
  };
  for (const d of usageDocs) addMonth(d.user_id, d.report_month?.slice(0, 7));
  for (const v of visitRecs) addMonth(v.user_id, v.visit_date?.slice(0, 7));

  // 5) 計画作成
  const inserts = [];
  const updates = []; // { id, before: {...}, after: {...}, label }
  const skips = [];
  let idx = 0;

  // clients の user_number 順 (deterministic) で処理
  const orderedIds = clients.map((c) => c.id);

  for (const clientId of orderedIds) {
    const cl = clientById.get(clientId);
    const label = `${cl?.user_number ?? "?"} ${cl?.name ?? clientId}`;
    const list = certsByClient.get(clientId) ?? [];

    if (list.length === 0) {
      skips.push(`${label}: 認定情報なし → skip`);
      continue;
    }
    if (list.some((c) => (c.notes ?? "").includes(CERT_HISTORY_MARKER))) {
      skips.push(`${label}: cert-history seed 済み → skip`);
      continue;
    }
    const anchor = list[0]; // certification_start_date 降順の先頭 = 最新認定
    if (!anchor.certification_start_date || !anchor.certification_end_date) {
      skips.push(`${label}: anchor の期間が不完全 → skip`);
      continue;
    }
    if (anchor.care_level === "申請中" || !anchor.care_level) {
      skips.push(`${label}: anchor が申請中/介護度なし → skip`);
      continue;
    }

    const myIdx = idx++;
    const origStart = anchor.certification_start_date;

    const basePayload = {
      tenant_id: anchor.tenant_id ?? "kt-group",
      client_id: clientId,
      insured_number: anchor.insured_number,
      insurer_number: anchor.insurer_number,
      care_office_id: anchor.care_office_id,
      benefit_rate: anchor.benefit_rate,
      certification_status: "認定済み",
      record_status: "認定済み",
    };

    // 前認定 (anchor 開始の 2 年前〜前日) — 全対象に共通で 1 件
    const prev1 = {
      ...basePayload,
      care_level: anchor.care_level,
      certification_start_date: addYears(origStart, -2),
      certification_end_date: addDays(origStart, -1),
      effective_date: addYears(origStart, -2),
      notes: `${CERT_HISTORY_MARKER} 前認定 (更新前の履歴)`,
    };

    // 3 人に 1 人: 区分変更パターン (実績のない月に限定)
    let kubunOk = false;
    if (myIdx % 3 === 0) {
      const shifted = shiftLevel(anchor.care_level);
      // 変更日候補: 元 start + 6 ヶ月 → だめなら +3 ヶ月 (月初)
      for (const plus of [6, 3]) {
        const changeDate = addMonthsFirstDay(origStart, plus);
        if (changeDate >= today) continue; // 未来の変更日は不可
        if (changeDate >= anchor.certification_end_date) continue;
        const affected = monthsBetween(origStart, changeDate); // [元start, 変更日) の月
        const jisseki = jissekiMonths.get(clientId) ?? new Set();
        if (affected.some((m) => jisseki.has(m))) continue; // 実績のある月に触れる → 不可
        if (!shifted) continue;
        // 区分変更前の認定 (元 start〜変更日前日, ±1)
        inserts.push({
          label,
          kind: `区分変更前認定 (${shifted})`,
          payload: {
            ...basePayload,
            care_level: shifted,
            certification_start_date: origStart,
            certification_end_date: addDays(changeDate, -1),
            effective_date: origStart,
            notes: `${CERT_HISTORY_MARKER} 区分変更前の認定 (${shifted}→${anchor.care_level} を ${changeDate} 区分変更)`,
          },
        });
        // anchor の start を変更日に UPDATE
        updates.push({
          id: anchor.id,
          label,
          before: {
            certification_start_date: anchor.certification_start_date,
            notes: anchor.notes,
          },
          after: { certification_start_date: changeDate },
        });
        kubunOk = true;
        break;
      }
      if (!kubunOk) {
        skips.push(`${label}: 区分変更は実績月と衝突 → 通常パターンに fallback`);
      }
    }

    // 前認定 1 件は全員に (区分変更成立者も含む)
    inserts.push({ label, kind: `前認定 (${prev1.care_level})`, payload: prev1 });

    // 区分変更しない人の半分 (myIdx % 2 === 1) はさらにもう 1 件古い認定を追加 (計 2 件)
    if (!kubunOk && myIdx % 2 === 1) {
      inserts.push({
        label,
        kind: `前々認定 (${anchor.care_level})`,
        payload: {
          ...basePayload,
          care_level: anchor.care_level,
          certification_start_date: addYears(origStart, -4),
          certification_end_date: addDays(addYears(origStart, -2), -1),
          effective_date: addYears(origStart, -4),
          notes: `${CERT_HISTORY_MARKER} 前々認定 (更新前の履歴)`,
        },
      });
    }
  }

  // 6) 計画表示
  console.log("\n── 計画 ──────────────────────────────");
  for (const ins of inserts) {
    console.log(
      `  INSERT ${ins.label}: ${ins.kind} ${ins.payload.certification_start_date}〜${ins.payload.certification_end_date}`,
    );
  }
  for (const up of updates) {
    console.log(
      `  UPDATE ${up.label}: anchor start ${up.before.certification_start_date} → ${up.after.certification_start_date} (区分変更)`,
    );
  }
  if (skips.length) {
    console.log("\n── skip / fallback ──");
    for (const s of skips) console.log(`  ${s}`);
  }
  console.log(
    `\n合計: INSERT ${inserts.length} 件 / UPDATE ${updates.length} 件 / skip ${skips.length} 件`,
  );

  if (!EXECUTE) {
    console.log("\nDRY RUN のため書き込みなし。--execute で本番実行。");
    return;
  }

  // 7) 本番実行
  // 7-1) UPDATE 対象の backup snapshot
  if (updates.length > 0) {
    const stamp = today.replaceAll("-", "");
    const backupPath = join(__dirname, `_backup_cert_history_updates_${stamp}.json`);
    writeFileSync(backupPath, JSON.stringify(updates, null, 2), "utf8");
    console.log(`\nbackup 保存: ${backupPath}`);
  }

  // 7-2) INSERT (chunk 100)
  let inserted = 0;
  for (let i = 0; i < inserts.length; i += 100) {
    const chunk = inserts.slice(i, i + 100).map((x) => x.payload);
    const { error } = await sb.from("client_insurance_records").insert(chunk);
    if (error) {
      console.error(`❌ INSERT failed (offset ${i}):`, error.message);
      process.exit(1);
    }
    inserted += chunk.length;
  }
  console.log(`INSERT 完了: ${inserted} 件`);

  // 7-3) UPDATE (区分変更の anchor start 移動)
  for (const up of updates) {
    const { error } = await sb
      .from("client_insurance_records")
      .update({
        certification_start_date: up.after.certification_start_date,
        notes: `${up.before.notes ?? ""} [cert-history: start ${up.before.certification_start_date}→${up.after.certification_start_date} 区分変更]`.trim(),
      })
      .eq("id", up.id);
    if (error) {
      console.error(`❌ UPDATE failed (${up.label}):`, error.message);
      process.exit(1);
    }
  }
  console.log(`UPDATE 完了: ${updates.length} 件`);

  // 7-4) 件数確認 (実際に入ったか verify)
  const { count, error: cntErr } = await sb
    .from("client_insurance_records")
    .select("id", { count: "exact", head: true })
    .like("notes", `%${CERT_HISTORY_MARKER}%`);
  if (cntErr) {
    console.error("❌ 件数確認 failed:", cntErr.message);
    process.exit(1);
  }
  console.log(`\n✅ 確認: notes LIKE '%${CERT_HISTORY_MARKER}%' = ${count} 件 (期待 ${inserts.length} 件)`);
  if (count !== inserts.length) {
    console.warn("⚠️ 期待件数と不一致 (過去実行分が残っている可能性)。内容を確認してください。");
  }
}

main().catch((e) => {
  console.error("❌ unexpected error:", e);
  process.exit(1);
});
