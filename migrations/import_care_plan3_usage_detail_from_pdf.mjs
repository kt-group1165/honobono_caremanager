// ============================================================================
// 「計画書一括印刷（利用者単位）」PDF (第1表→第2表→週間計画→利用票→別表 を
// 1ファイルに束ねたもの) から 第3表(週間計画) と 第7表(別表) を取り込む。
//
//   node migrations/import_care_plan3_usage_detail_from_pdf.mjs --pdf "<path>" [--pdf "<path2>" ...]   # DRY RUN
//   node migrations/import_care_plan3_usage_detail_from_pdf.mjs --pdf "<path>" --execute
//
// ⚠ 2026-09-14 時点: 第7表(service-usage-detail)の**数値列(単位数・金額等)は
//   未実装**。理由は _parse_careplan_bundle_pdf.mjs の冒頭コメント参照
//   (1サンプルでは合計行との自己検算が取れず、列境界を確信を持って決められ
//   なかった)。このscriptは第7表について事業所名・事業所番号・サービス内容・
//   サービスコードの4列だけを提示し、**--execute でも service-usage-detail
//   への書込は行わない** (要確認が解消するまで意図的に止めてある)。
//   第3表(care-plan-3)の週間スケジュールは書込可能 (表示用テキストのため
//   金額に影響しない。実データ2件で座標を検証済み)。
//
// ── 利用者の特定 ────────────────────────────────────────────────────────
//   束ねPDF内の利用票(第6表)ページに印字された (保険者番号,被保険者番号) で
//   引き当てる (import_riyouhyou_service_usage.mjs と同じ _client_resolve.mjs
//   を共有)。週間計画・別表ページには番号が印字されないため、**同じファイル内
//   の利用票ページで特定した人物と同一**という前提を置く (H指示)。
//   氏名も weekly/riyouhyou 両ページから拾い、_name_normalize.mjs で正規化して
//   一致しなければ警告して skip する (別人の取り違え防止)。
//
// ── 対象月の決め方 (要確認事項への回答) ──────────────────────────────────
//   週間計画ページの「令和 年 月分」欄が**空欄のことがある** (H実例: 秋葉法昌)。
//   このときは**同じPDF内の別表ページ**に印字された提供年月
//   ("令和 8年 6月　0000375402　秋葉 法昌 様" のような行) で埋める。
//   別表ページも読めなければ (束ね方が崩れている等) 要確認として skip する。
//
// ── 重複防止 ────────────────────────────────────────────────────────────
//   (user_id, report_type, report_month) で既存があれば skip する
//   (--force で上書き。import_riyouhyou_service_usage.mjs 相当の「人が入力済み
//   なら触らない」判定は、この2帳票にはまだ実データが無いため未実装。
//   運用開始後に必要なら同じ hasAnyMark 相当を足す)。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractPages } from "./_pdf_words.mjs";
import { resolveClients } from "./_client_resolve.mjs";
import { classifyPage, extractWeeklySchedule, extractBetsuhyouRows } from "./_parse_careplan_bundle_pdf.mjs";
import { extractGrid, pickIdentity } from "./_riyouhyou_grid.mjs";
import { normName } from "./_name_normalize.mjs";

const EXECUTE = process.argv.includes("--execute");
const FORCE = process.argv.includes("--force");
const PDF_PATHS = process.argv.flatMap((a, i, arr) => (a === "--pdf" ? [arr[i + 1]] : []));
const KAIGO = fileURLToPath(new URL("../", import.meta.url));
const MARKER = "care-plan-bundle-pdf";

if (!PDF_PATHS.length) {
  console.error("--pdf <path> を最低1つ指定する (複数可)");
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

const CARE_PLAN3_HOUR_KEYS = ["h00", "h02", "h04", "h06", "h08", "h10", "h12", "h14", "h16", "h18", "h20", "h22"];

/** 束ねPDF 1件を読んで {weekly, riyouhyou, betsuhyou} のページ内容を返す */
function parseBundle(pdfPath) {
  const { texts, words } = extractPages(pdfPath);
  const out = { weekly: null, riyouhyouIdentity: null, riyouhyouGrid: null, betsuhyouRows: null, betsuhyouMonth: null, betsuhyouName: null, pages: [] };
  for (let i = 0; i < texts.length; i++) {
    const kind = classifyPage(texts[i]);
    out.pages.push(kind);
    if (kind === "weekly") out.weekly = extractWeeklySchedule(words[i]);
    if (kind === "riyouhyou") {
      out.riyouhyouIdentity = pickIdentity(words[i]);
      out.riyouhyouGrid = extractGrid(words[i]);
    }
    if (kind === "betsuhyou") {
      out.betsuhyouRows = extractBetsuhyouRows(words[i]);
      // 別表ヘッダー「令和 8年 6月   0000375402   秋葉 法昌 様」から提供年月と氏名を拾う
      // (週間計画の対象月欄が空欄のときのフォールバック用)
      const m = /令和[\s　]*(\d+)[\s　]*年[\s　]*(\d+)[\s　]*月/.exec(texts[i]);
      if (m) out.betsuhyouMonth = `${2018 + Number(m[1])}-${String(Number(m[2])).padStart(2, "0")}`;
      const nm = /様/.exec(texts[i]);
      if (nm) {
        const before = texts[i].slice(0, nm.index).trimEnd();
        const lastLine = before.split("\n").filter((l) => l.trim()).pop();
        if (lastLine) out.betsuhyouName = lastLine.trim();
      }
    }
  }
  return out;
}

function buildSchedulePayload(weekly) {
  const schedule = {};
  for (const k of CARE_PLAN3_HOUR_KEYS) schedule[k] = { ...(weekly.schedule?.[k] ?? {}) };
  return {
    schedule,
    care_level: weekly.careLevel ?? null,
    user_name: weekly.userName ?? null,
    creation_date: weekly.creationDate ?? null,
    daily_routine: weekly.dailyRoutine ?? [],
    irregular_services: weekly.irregularServices ?? null,
    _import_source: { kind: MARKER },
  };
}

async function main() {
  console.log("=== 計画書一括印刷PDF → 第3表(care-plan-3)・第7表(service-usage-detail) 取込 ===");
  console.log(EXECUTE ? "*** 本番実行 (第3表のみ書込。第7表は数値列未実装のため書込しない) ***" : "*** DRY RUN ***");
  console.log("");

  const parsed = PDF_PATHS.map((p) => ({ path: p, ...parseBundle(p) }));

  // ── 利用者を引き当てる (利用票ページの (保険者,被保険者) で) ────────────
  const people = new Map();
  for (const b of parsed) {
    if (!b.riyouhyouIdentity?.insurer || !b.riyouhyouIdentity?.insured) {
      console.log(`✗ ${path.basename(b.path)}: 利用票ページの保険者番号/被保険者番号が読めない (ページ構成: ${b.pages.join(",")})`);
      continue;
    }
    const nameKey = normName(b.riyouhyouIdentity.name ?? "");
    people.set(b.path, { insurer: b.riyouhyouIdentity.insurer, insured: b.riyouhyouIdentity.insured, nameKey });
  }
  const { byPair, nameById } = await resolveClients(sb, people, { normalizeName: normName });

  let ok = 0, unresolved = 0, nameMismatch = 0, care3Written = 0, skipped = 0;
  for (const b of parsed) {
    const base = path.basename(b.path);
    console.log(`\n── ${base}  (ページ構成: ${b.pages.join(" / ")})`);

    const p = people.get(b.path);
    if (!p) { unresolved++; continue; }
    const ids = byPair.get(`${p.insurer}|${p.insured}`);
    if (!ids || ids.size !== 1) {
      console.log(`  ✗ 引き当て失敗 (保険者${p.insurer} 被保番${p.insured} → 該当 ${ids?.size ?? 0} 件)`);
      unresolved++;
      continue;
    }
    const clientId = [...ids][0];
    const dbName = nameById.get(clientId)?.name ?? "";
    if (dbName && normName(dbName) !== p.nameKey) {
      console.log(`  ⚠ 氏名不一致: PDF「${b.riyouhyouIdentity.name}」 vs 当方「${dbName}」→ skip`);
      nameMismatch++;
      continue;
    }
    console.log(`  → ${dbName || b.riyouhyouIdentity.name} (client_id=${clientId})`);
    ok++;

    // ── 対象月: 週間計画の欄が空なら別表ページの提供年月で埋める ──────────
    let targetMonth = b.weekly?.targetMonth ?? null;
    if (!targetMonth && b.betsuhyouMonth) {
      targetMonth = b.betsuhyouMonth;
      console.log(`  ℹ 週間計画の「令和 年 月分」が空欄のため、別表ページの提供年月で補完: ${targetMonth}`);
    }
    if (!targetMonth) {
      console.log("  ✗ 対象月が週間計画・別表のどちらからも読めない → skip (要確認)");
      skipped++;
      continue;
    }

    // ── 第3表 (care-plan-3) ──────────────────────────────────────────
    if (!b.weekly?.schedule) {
      console.log(`  ✗ 週間計画ページの解析に失敗 (warn: ${JSON.stringify(b.weekly?.warn ?? ["ページ自体が見つからない"])})`);
    } else {
      const filled = Object.entries(b.weekly.schedule).filter(([, days]) => Object.keys(days).length > 0);
      console.log(`  第3表: ${filled.length}時間帯に予定あり / 対象月=${targetMonth}`);
      for (const [hk, days] of filled) console.log(`    ${hk}: ${JSON.stringify(days)}`);
      if (b.weekly.irregularServices) console.log(`    週単位以外のサービス: ${b.weekly.irregularServices}`);

      const { data: existing } = await sb
        .from("kaigo_report_documents")
        .select("id")
        .eq("user_id", clientId)
        .eq("report_type", "care-plan-3")
        .eq("report_month", targetMonth)
        .maybeSingle();
      if (existing && !FORCE) {
        console.log(`  skip (既存 care-plan-3 ${targetMonth} あり。--force で上書き)`);
        skipped++;
      } else {
        const content = buildSchedulePayload(b.weekly);
        if (!EXECUTE) {
          console.log(`  ${existing ? "UPDATE" : "INSERT"} 予定 (care-plan-3, ${targetMonth})`);
          care3Written++;
        } else {
          const title = `週間サービス計画表（第3表）　${targetMonth.replace("-", "年")}月分`;
          if (existing) {
            const { error } = await sb.from("kaigo_report_documents").update({ content, updated_at: new Date().toISOString() }).eq("id", existing.id);
            if (error) console.error(`  ✗ UPDATE失敗: ${error.message}`);
            else { console.log("  UPDATE 完了"); care3Written++; }
          } else {
            const { error } = await sb.from("kaigo_report_documents").insert({
              user_id: clientId, report_type: "care-plan-3", title, report_month: targetMonth,
              content, status: "draft", tenant_id: "kt-group",
            });
            if (error) console.error(`  ✗ INSERT失敗: ${error.message}`);
            else { console.log("  INSERT 完了"); care3Written++; }
          }
        }
      }
    }

    // ── 第7表 (service-usage-detail) — 提示のみ。書込しない ─────────────
    if (!b.betsuhyouRows) {
      console.log("  第7表: 別表ページが見つからない");
    } else {
      console.log(`  第7表: ${b.betsuhyouRows.length}行 (事業所名・事業所番号・サービス内容・サービスコードのみ抽出。単位数等は未実装 → 書込しない)`);
      for (const r of b.betsuhyouRows) {
        console.log(`    ${r.service_code}  ${r.service_content}  ${r.provider_name}(${r.provider_number ?? "番号不明"})`);
      }
    }
  }

  console.log("\n=== まとめ ===");
  console.log(`  PDF                    ${parsed.length} 本`);
  console.log(`  利用者引き当て成功     ${ok} 件`);
  console.log(`  引き当て失敗           ${unresolved} 件`);
  console.log(`  氏名不一致でskip       ${nameMismatch} 件`);
  console.log(`  対象月不明でskip       ${skipped} 件`);
  console.log(`  第3表 ${EXECUTE ? "書込完了" : "書込予定"}       ${care3Written} 件`);
  console.log("  第7表: 数値列(単位数・費用総額・給付率等)は未実装のため今回は書込対象外 (要H判断)");
}

main().catch((e) => { console.error(e); process.exit(1); });
