// ============================================================================
// 「計画書一括印刷（利用者単位）」PDF (第1表→第2表→週間計画→利用票→別表 を
// 1ファイルに束ねたもの) から 第3表(週間計画) と 第7表(別表) を取り込む。
//
//   node migrations/import_care_plan3_usage_detail_from_pdf.mjs --pdf "<path>" [--pdf "<path2>" ...]   # DRY RUN
//   node migrations/import_care_plan3_usage_detail_from_pdf.mjs --pdf "<path>" --execute
//
// ── 第7表(service-usage-detail)の数値列 (2026-09-14 解決) ────────────────
//   残り5本の実PDFで列境界と金額の出方 (行直接 / 「◯◯合計」行からの按分) が
//   確定した。詳細は _parse_careplan_bundle_pdf.mjs の extractBetsuhyouRows
//   冒頭コメント参照。自己検算 (合計行の費用総額と行ごとの計算値の合計の差)
//   で不一致が出た場合は warn に積んで出力する。
//   ⚠ 区分支給限度基準を超える単位数は実データ6本すべてで 0 だったため
//   未対応 (over_limit_units は常に0で出す)。限度超過がある利用者では
//   金額がずれる可能性があるので、書込前に必ず warn 欄が空であることを確認。
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
  const out = {
    weekly: null, riyouhyouIdentity: null, riyouhyouGrid: null,
    betsuhyouItems: null, betsuhyouWarn: [], betsuhyouMonth: null, betsuhyouName: null,
    betsuhyouLimitAmount: null, pages: [],
  };
  for (let i = 0; i < texts.length; i++) {
    const kind = classifyPage(texts[i]);
    out.pages.push(kind);
    if (kind === "weekly") out.weekly = extractWeeklySchedule(words[i]);
    if (kind === "riyouhyou") {
      out.riyouhyouIdentity = pickIdentity(words[i]);
      out.riyouhyouGrid = extractGrid(words[i]);
    }
    if (kind === "betsuhyou") {
      const { items, warn } = extractBetsuhyouRows(words[i]);
      out.betsuhyouItems = items;
      out.betsuhyouWarn = warn;
      // 「区分支給限度基準額(単位)」の直後に出る数字 (要介護度から機械的に決まる値。
      // _riyouhyou_pdf.mjs の LIMIT_TO_CARE_LEVEL と同じ値だが、印字を直接読むほうが
      // 要介護度の読み取り誤りに影響されず確実)
      // ⚠ ラベル「区分支給限度基準額(単位)」の**右**に値が出る (実測で左と誤認して
      //   一度 null になった。値は同じ行のラベルの右、次の「合計」ラベルより手前)
      const limitLabel = words[i].find((w) => w.t.includes("区分支給限度基準額"));
      if (limitLabel) {
        const near = words[i].find((w) => Math.abs(w.y - limitLabel.y) <= 3
          && w.x > limitLabel.x && w.x < limitLabel.x + 200 && /^\d{4,6}$/.test(w.t));
        if (near) out.betsuhyouLimitAmount = Number(near.t);
      }
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

/** ⚠ キー名は EditFormCarePlan3 (reports-content.tsx) が読む名前と完全に一致させること。
 * 旧版はここが daily_routine/irregular_services になっていて、画面 (daily_activities/
 * other_services を読む) には反映されない不具合があった (2026-09-14 に発見・是正)。
 * prev があれば人の入力を残す (schedule 以外の欄は prev 優先、無ければ抽出値)。 */
function buildSchedulePayload(prev, weekly) {
  const schedule = {};
  for (const k of CARE_PLAN3_HOUR_KEYS) schedule[k] = { ...(prev?.schedule?.[k] ?? {}), ...(weekly.schedule?.[k] ?? {}) };
  return {
    ...(prev ?? {}),
    schedule,
    care_level: prev?.care_level || weekly.careLevel || "",
    user_name: prev?.user_name || weekly.userName || "",
    creation_date: prev?.creation_date || weekly.creationDate || "",
    daily_activities: prev?.daily_activities || (weekly.dailyRoutine ?? []).join("\n"),
    other_services: prev?.other_services || weekly.irregularServices || "",
    _import_source: { kind: MARKER },
  };
}

/** ⚠ こちらも EditFormUsageDetail が読むキー名 (items/short_stay_days/limit_management等)
 * に合わせる。items は prev があっても抽出結果で置き換える (行の追加・削除が主目的の
 * 帳票で、prev の空スケルトン行を残す理由が無いため)。他のヘッダー欄は prev 優先。 */
function buildDetailPayload(prev, b, month) {
  return {
    ...(prev ?? {}),
    items: b.betsuhyouItems ?? prev?.items ?? [],
    user_name: prev?.user_name || b.riyouhyouIdentity?.name || b.betsuhyouName || "",
    care_level: prev?.care_level || b.weekly?.careLevel || "",
    limit_amount: prev?.limit_amount || b.betsuhyouLimitAmount || "",
    limit_period: prev?.limit_period || "",
    creation_date: prev?.creation_date || b.weekly?.creationDate || "",
    insured_number: prev?.insured_number || b.riyouhyouIdentity?.insured || "",
    insurer_number: prev?.insurer_number || b.riyouhyouIdentity?.insurer || "",
    short_stay_days: prev?.short_stay_days ?? { prev: 0, current: 0, total: 0 },
    limit_management: prev?.limit_management ?? [],
    _import_source: { kind: MARKER, month },
  };
}

async function main() {
  console.log("=== 計画書一括印刷PDF → 第3表(care-plan-3)・第7表(service-usage-detail) 取込 ===");
  console.log(EXECUTE ? "*** 本番実行 ***" : "*** DRY RUN ***");
  console.log("");

  const parsed = PDF_PATHS.map((p) => ({ path: p, ...parseBundle(p) }));

  // ── 利用者を引き当てる (利用票ページの (保険者,被保険者) で) ────────────
  const people = new Map();
  const noIdentity = [];
  for (const b of parsed) {
    if (!b.riyouhyouIdentity?.insurer || !b.riyouhyouIdentity?.insured) {
      noIdentity.push(b);
      continue;
    }
    const nameKey = normName(b.riyouhyouIdentity.name ?? "");
    people.set(b.path, { insurer: b.riyouhyouIdentity.insurer, insured: b.riyouhyouIdentity.insured, nameKey });
  }
  const { byPair, nameById } = await resolveClients(sb, people, { normalizeName: normName });

  // 番号が全く読めない (利用票ページ自体が無い) ファイルは、週間計画の氏名だけで
  // ★参考情報として★ 1名に絞れるか見る。書込には使わない (氏名だけの引き当ては
  // 別人衝突のリスクがあるため。memory feedback_name_based_lookup_collision_risk)。
  for (const b of noIdentity) {
    const base = path.basename(b.path);
    const nm = b.weekly?.userName ?? null;
    if (!nm) {
      console.log(`✗ ${base}: 利用票ページが無く、週間計画にも氏名が読めない (ページ構成: ${b.pages.join(",")}) → 完全に要確認`);
      continue;
    }
    const key = normName(nm);
    const { data: cand } = await sb.from("clients").select("id, name").is("deleted_at", null);
    const hit = (cand ?? []).filter((c) => normName(c.name) === key);
    if (hit.length === 1) {
      console.log(`⚠ ${base}: 利用票ページが無い (ページ構成: ${b.pages.join(",")})。週間計画の氏名「${nm}」で当方に1名だけヒット: ${hit[0].name} (id=${hit[0].id}) — ★氏名のみの参考情報。番号での確認が取れるまで書込対象外`);
    } else {
      console.log(`✗ ${base}: 利用票ページが無い (ページ構成: ${b.pages.join(",")})。週間計画の氏名「${nm}」は当方で ${hit.length} 名に該当 → 要確認`);
    }
  }

  let ok = 0, unresolved = noIdentity.length, nameMismatch = 0, care3Written = 0, detailWritten = 0, skipped = 0;
  for (const b of parsed) {
    if (noIdentity.includes(b)) continue;
    const base = path.basename(b.path);
    console.log(`\n── ${base}  (ページ構成: ${b.pages.join(" / ")})`);

    const p = people.get(b.path);
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

      const { data: existingCp3 } = await sb
        .from("kaigo_report_documents")
        .select("id, content")
        .eq("user_id", clientId)
        .eq("report_type", "care-plan-3")
        .eq("report_month", targetMonth)
        .maybeSingle();
      if (existingCp3 && !FORCE) {
        console.log(`  skip (既存 care-plan-3 ${targetMonth} あり。--force で上書き)`);
        skipped++;
      } else {
        const content = buildSchedulePayload(FORCE ? existingCp3?.content : null, b.weekly);
        if (!EXECUTE) {
          console.log(`  ${existingCp3 ? "UPDATE" : "INSERT"} 予定 (care-plan-3, ${targetMonth})`);
          care3Written++;
        } else {
          const title = `週間サービス計画表（第3表）　${targetMonth.replace("-", "年")}月分`;
          if (existingCp3) {
            const { error } = await sb.from("kaigo_report_documents").update({ content, updated_at: new Date().toISOString() }).eq("id", existingCp3.id);
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

    // ── 第7表 (service-usage-detail) ────────────────────────────────
    if (!b.betsuhyouItems) {
      console.log("  第7表: 別表ページが見つからない");
    } else {
      console.log(`  第7表: ${b.betsuhyouItems.length}行`);
      for (const it of b.betsuhyouItems) {
        const tag = it._money_source === "direct" ? "" : it._money_source === "group-total" ? " (合計行から按分)" : " ⚠既定値のまま(要確認)";
        console.log(`    ${it.service_code}  ${it.service_content}  ${it.provider_name}(${it.provider_number || "番号不明"})  単位${it.units}×${it.count}回=${it.service_units}  単価${it.unit_price} 給付率${it.benefit_rate}% 総額${it.total_cost} 保険請求${it.insurance_claim} 負担${it.user_copay}${tag}`);
      }
      if (b.betsuhyouWarn.length) {
        console.log("  ⚠ 自己検算の注意:");
        for (const w of b.betsuhyouWarn) console.log(`    ⚠ ${w}`);
      }

      const { data: existingDetail } = await sb
        .from("kaigo_report_documents")
        .select("id, content")
        .eq("user_id", clientId)
        .eq("report_type", "service-usage-detail")
        .eq("report_month", targetMonth)
        .maybeSingle();
      if (existingDetail && !FORCE) {
        console.log(`  skip (既存 service-usage-detail ${targetMonth} あり。--force で上書き)`);
        skipped++;
      } else {
        const content = buildDetailPayload(FORCE ? existingDetail?.content : null, b, targetMonth);
        if (!EXECUTE) {
          console.log(`  ${existingDetail ? "UPDATE" : "INSERT"} 予定 (service-usage-detail, ${targetMonth})`);
          detailWritten++;
        } else {
          const title = `サービス利用票別表（第7表）　${targetMonth.replace("-", "年")}月分`;
          if (existingDetail) {
            const { error } = await sb.from("kaigo_report_documents").update({ content, updated_at: new Date().toISOString() }).eq("id", existingDetail.id);
            if (error) console.error(`  ✗ UPDATE失敗: ${error.message}`);
            else { console.log("  UPDATE 完了"); detailWritten++; }
          } else {
            const { error } = await sb.from("kaigo_report_documents").insert({
              user_id: clientId, report_type: "service-usage-detail", title, report_month: targetMonth,
              content, status: "draft", tenant_id: "kt-group",
            });
            if (error) console.error(`  ✗ INSERT失敗: ${error.message}`);
            else { console.log("  INSERT 完了"); detailWritten++; }
          }
        }
      }
    }
  }

  console.log("\n=== まとめ ===");
  console.log(`  PDF                    ${parsed.length} 本`);
  console.log(`  利用者引き当て成功     ${ok} 件`);
  console.log(`  引き当て失敗           ${unresolved} 件 (うち利用票ページ自体が無い: ${noIdentity.length} 件)`);
  console.log(`  氏名不一致でskip       ${nameMismatch} 件`);
  console.log(`  対象月不明でskip       ${skipped} 件`);
  console.log(`  第3表 ${EXECUTE ? "書込完了" : "書込予定"}       ${care3Written} 件`);
  console.log(`  第7表 ${EXECUTE ? "書込完了" : "書込予定"}       ${detailWritten} 件`);
}

main().catch((e) => { console.error(e); process.exit(1); });
