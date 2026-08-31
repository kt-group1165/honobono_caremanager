/**
 * 帳票の「様式に印字欄があるのに中身が空」を数える常設チェック。
 *
 * ══ なぜ要るか ═══════════════════════════════════════════════════════════════
 *   同じ形の事故が 2 回起きた。
 *     ・利用票 (第6表)  保険者名 1,439 件 / 担当者 1,880 件 (全件) が空
 *     ・第1表           認定年月日 2,959 / 計画作成者 2,956 / 生年月日 2,943 … が空
 *   どちらも
 *     取込が本文だけ入れて表題部を入れない  ＋  画面の既定値がハードコード空
 *   の組み合わせで、**印刷して初めて気づく**。集計スモークは金額しか見ないので
 *   ここは誰も見ていなかった。
 *
 * ══ 使い方 ═══════════════════════════════════════════════════════════════════
 *   npm run check:reports
 *   npm run check:reports -- --update     基準値を実測で置き直す (中身を読んでから commit)
 *   npm run check:reports -- --list care-plan-1   その帳票の空欄の利用者を出す
 *
 *   DB は読み取りのみ。env が無ければスキップして exit 0。
 *
 * ══ 判定 ═════════════════════════════════════════════════════════════════════
 *   基準値 (scripts/reports-blank-expected.json) より **増えたら FAIL**。
 *   減った分は「直った」として出すだけで落とさない。
 *   元データが無くて埋めようがない分 (認定年月日 61 件など) は基準値に含める。
 *   ゼロにできないものを毎回赤くしても読まれなくなるので、**悪化だけを見る**。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPDATE = process.argv.includes("--update");
const LIST = (() => {
  const i = process.argv.indexOf("--list");
  return i >= 0 ? process.argv[i + 1] : "";
})();
const EOL = String.fromCharCode(10);

/**
 * 様式の印字欄。**印刷ビュー (reports-content.tsx の PrintXxx) に出ている項目だけ**を
 * 挙げること。編集画面にしかない欄を入れると「空で当然」のものが並んでノイズになる。
 */
const REQUIRED: Record<string, { label: string; fields: [string, string][] }> = {
  "care-plan-1": {
    label: "居宅サービス計画書 第1表",
    fields: [
      ["user_name", "利用者名"],
      ["birth_date", "生年月日"],
      ["address", "住所"],
      ["care_level", "要介護状態区分"],
      ["cert_period", "認定の有効期間"],
      ["certification_date", "認定日"],
      ["creator_name", "計画作成者氏名"],
      ["office_name", "事業所名"],
      ["creation_date", "計画作成（変更）日"],
    ],
  },
  "care-plan-2": {
    label: "居宅サービス計画書 第2表",
    fields: [
      ["user_name", "利用者名"],
      ["creation_date", "作成年月日"],
      // 本文は blocks[] (ニーズ → 長期目標 → 短期目標 → サービス)。
      // 空配列も「空」と数えたいので isBlank が配列を扱えることが前提
      ["blocks", "本文 (ニーズ・目標・サービス)"],
    ],
  },
  "service-usage": {
    label: "サービス利用票・提供票 (第6表)",
    fields: [
      ["user_name", "利用者氏名"],
      ["insurer_number", "保険者番号"],
      ["insurer_name", "保険者名"],
      ["insured_number", "被保険者番号"],
      ["care_level", "要介護状態区分"],
      ["limit_amount", "区分支給限度基準額"],
      ["limit_period", "限度額適用期間"],
      ["support_office_name", "居宅介護支援事業所"],
      ["support_staff_name", "担当者"],
      // 日別の予定・実績が載る行。空だと様式が白紙になる
      ["services", "サービス行"],
      // ⚠ 作成年月日・届出年月日は **ほのぼのの利用票でも空欄で印字される**ので入れない
    ],
  },
  "yobo-care-plan": {
    label: "介護予防サービス・支援計画書",
    fields: [
      ["user_name", "利用者名"],
      ["birth_date", "生年月日"],
      ["cert_date", "認定年月日"],
      ["cert_period", "認定の有効期間"],
      ["care_level", "要介護状態区分"],
      ["creator_name", "計画作成者"],
      ["office_name", "事業所名"],
      ["creation_date", "計画作成（変更）日"],
    ],
  },
};

interface Baseline {
  _readme: string[];
  /** 帳票種別 → 項目 → 許容している空の件数 */
  blanks: Record<string, Record<string, number>>;
  /** 帳票種別 → 総件数 (母数が変わったと分かるように持つ) */
  totals: Record<string, number>;
}

const baselinePath = join(__dirname, "reports-blank-expected.json");
let baseline: Baseline;
try {
  baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline;
} catch {
  baseline = { _readme: [], blanks: {}, totals: {} };
}

function loadEnvLocal(): Record<string, string> {
  try {
    const raw = readFileSync(join(__dirname, "..", ".env.local"), "utf8");
    const vars: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const m = /^([^#=\s][^=]*)=(.*)$/.exec(line);
      if (m) vars[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return vars;
  } catch {
    return {};
  }
}
const envFile = loadEnvLocal();
const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? envFile.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? envFile.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  console.log("check:reports: スキップ (env 必要) — .env.local が見つかりません");
  process.exit(0);
}
const supabase = createClient(SB_URL, SB_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Doc = { id: string; user_id: string; report_month: string | null; content: Record<string, unknown> | null };

/** 空判定。**空配列も空とみなす** (本文が 1 行も無い帳票を拾うため) */
const isBlank = (v: unknown): boolean => {
  if (v === undefined || v === null) return true;
  if (Array.isArray(v)) return v.length === 0;
  return String(v).trim() === "";
};

async function fetchDocs(reportType: string): Promise<Doc[]> {
  const out: Doc[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("kaigo_report_documents")
      .select("id, user_id, report_month, content")
      .eq("report_type", reportType)
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as Doc[]));
    if (!data || data.length < PAGE) return out;
  }
}

/**
 * 「空で正しい」欄を除外するための例外。
 *
 * 認定の更新申請を出して結果待ちの間 (certification_status='申請中') は、要介護度も
 * 区分支給限度基準額も **まだ存在しない**。ほのぼのの 介護保険 CSV でも空で出てくる。
 * これを空欄として数えると更新申請のたびに FAIL し、基準値を上げて黙らせる方向に
 * 力が働く。そうすると **本物の取込漏れが同じ欄で起きたときに気づけない**ので、
 * 数える前に除外する。
 *
 * 実測 (2026-09-01): 要介護度が空の認定は全社 16 件。すべて申請中。
 */
const PENDING_EXEMPT: Record<string, Set<string>> = {
  "service-usage": new Set(["care_level", "limit_amount"]),
};

type Cert = { client_id: string; certification_status: string | null; certification_start_date: string | null; certification_end_date: string | null };

/** (利用者, 対象月) が「認定申請中」か */
async function loadPendingCerts(): Promise<(userId: string, month: string | null) => boolean> {
  const rows: Cert[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("client_insurance_records")
      .select("client_id, certification_status, certification_start_date, certification_end_date")
      .eq("certification_status", "申請中")
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Cert[]));
    if (!data || data.length < PAGE) break;
  }
  const byUser = new Map<string, Cert[]>();
  for (const r of rows) {
    if (!byUser.has(r.client_id)) byUser.set(r.client_id, []);
    byUser.get(r.client_id)!.push(r);
  }
  console.log(`  (認定申請中 ${rows.length} 件 / 利用者 ${byUser.size} 名 — 要介護度が空でも数えません)`);
  return (userId, month) => {
    const list = byUser.get(userId);
    if (!list || !month) return false;
    // 対象月の月末で判定する (月途中に申請しても その月は申請中扱い)
    const [y, m] = month.split("-").map(Number);
    const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const first = `${month}-01`;
    return list.some(
      (c) =>
        (!c.certification_start_date || c.certification_start_date <= last) &&
        (!c.certification_end_date || c.certification_end_date >= first),
    );
  };
}

async function main(): Promise<void> {
  console.log("帳票の印字欄チェック — 様式に欄があるのに空のものを数える");
  if (UPDATE) console.log("--update: 基準値を実測で置き直します");
  const isPending = await loadPendingCerts();

  let worse = 0, better = 0;
  const nextBlanks: Record<string, Record<string, number>> = {};
  const nextTotals: Record<string, number> = {};

  for (const [type, spec] of Object.entries(REQUIRED)) {
    const docs = await fetchDocs(type);
    nextTotals[type] = docs.length;
    nextBlanks[type] = {};
    console.log(`${EOL}[${spec.label}] ${docs.length} 件`);
    if (baseline.totals[type] !== undefined && baseline.totals[type] !== docs.length) {
      console.log(`  (件数が ${baseline.totals[type]} → ${docs.length} に変わっています)`);
    }

    for (const [field, label] of spec.fields) {
      const exempt = PENDING_EXEMPT[type]?.has(field) ?? false;
      const blanks = docs.filter(
        (d) => isBlank(d.content?.[field]) && !(exempt && isPending(d.user_id, d.report_month)),
      );
      nextBlanks[type][field] = blanks.length;
      const base = baseline.blanks[type]?.[field];
      const mark = base === undefined ? "新規" : blanks.length > base ? "★ 増えた" : blanks.length < base ? "○ 減った" : "";
      if (base !== undefined && blanks.length > base) worse++;
      if (base !== undefined && blanks.length < base) better++;
      const baseText = base === undefined ? "" : ` (基準 ${base})`;
      if (blanks.length === 0 && !mark) continue;      // ずっと 0 のものは出さない
      console.log(`  ${mark ? mark + " " : ""}${label} (${field}): 空 ${blanks.length} 件${baseText}`);
      if (LIST === type && blanks.length > 0) {
        blanks.slice(0, 20).forEach((b) =>
          console.log(`      ${String(b.content?.user_name ?? "?")} ${b.report_month ?? ""} id=${b.id}`));
        if (blanks.length > 20) console.log(`      … 他 ${blanks.length - 20} 件`);
      }
    }
  }

  console.log("");
  if (UPDATE) {
    const out: Baseline = {
      _readme: [
        "帳票の印字欄チェック (npm run check:reports) の基準値。",
        "",
        "■ 何を見ているか",
        "  様式に印字欄があるのに content が空の件数。**増えたら FAIL**、減ったら報告だけ。",
        "  ゼロにできない分 (元データがそもそも無い利用者) を基準値に含めてよい。",
        "  0 を強制すると毎回落ちて読まれなくなるので、悪化だけを見る。",
        "",
        "■ 更新のしかた",
        "  npm run check:reports -- --update     … 中身を読んでから commit する",
        "  ⚠ 増えたまま --update すると穴を基準値に焼き付けることになる。",
        "    増えた項目は **先に原因を潰してから** 更新すること。",
        "",
        "■ 対象項目",
        "  scripts/reports-blank-check.mts の REQUIRED。印刷ビューに出ている欄だけ挙げる。",
      ],
      blanks: nextBlanks,
      totals: nextTotals,
    };
    writeFileSync(baselinePath, JSON.stringify(out, null, 2) + EOL, "utf8");
    console.log("scripts/reports-blank-expected.json を更新しました。**中身を読んでから commit してください。**");
    process.exit(0);
  }

  if (worse > 0) {
    console.log(`FAIL — ★ 空欄が増えた項目 ${worse} 件。`);
    console.log("       取込か既定値のどちらかが欄を埋めていません。基準値を上げて黙らせないこと。");
    process.exit(1);
  }
  console.log(better > 0 ? `PASS — 悪化なし (○ 減った ${better} 件)` : "PASS — 悪化なし");
  process.exit(0);
}

main().catch((e: unknown) => {
  console.error("check:reports 実行エラー:", e instanceof Error ? e.message : e);
  process.exit(1);
});
