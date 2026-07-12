"use client";

/**
 * 過誤 (かご) 申立の管理 — 事由コードマスタ + 保険者提出用一覧
 *
 * 過誤 = 一度支払われた (審査決定済みの) レセプトを事後に取り下げる手続き。
 *   ① 事業所 → 保険者 へ過誤申立 (様式は保険者ごと)
 *   ② 保険者 → 国保連 (介護給付費過誤申立書情報 1731)
 *   ③ 国保連が過誤決定 = 当月支払額から控除 (介護給付費過誤決定通知書 1711)
 *   ④ 必要なら事業所が正しい内容で再請求
 *      - 通常過誤: 過誤決定 (支払控除) の翌月以降に再請求
 *      - 同月過誤: 過誤申立と再請求を同月処理 (保険者が対応している場合のみ。
 *        全額返金→再入金ではなく差額調整になるため資金負担が軽い)
 *
 * ── 過誤申立事由コードの体系 (英数4桁) ──────────────────────────────
 * 根拠1: 国保中央会「介護保険 インタフェース仕様書」項番102 過誤申立事由コード
 *        (apps/kaigo-app/migrations/_if_kyotaku.txt)
 *        「英数 4桁: ×1×2 = 様式番号 / ×3×4 = 申立理由番号」
 *        申立理由番号の標準値: 01/02/09/11/21/29/32/90/99 (下記マスタに収録)
 * 根拠2: 保険者公表の現行一覧 (例: 東京都台東区「過誤申立事由コード (介護保険)」、
 *        千葉県柏市 平成28年一覧、鹿児島県国保連合会一覧)
 *        同月過誤 (12/4C/4D) と適正化系 (42/45/46) はこちらに拠る。
 * ※ 申立理由番号の使用範囲・様式は保険者ごとに異なる。提出前に保険者の
 *   一覧で必ず確認すること (だからこのマスタは形式チェックのみで DB は縛らない)。
 * ※ 例: 訪問介護の請求誤りによる申立 = 1002 (同月過誤なら 1012)
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** 過誤申立の付帯情報 (kaigo_billing_status の kago_* 列) */
export interface KagoInfo {
  /** 過誤申立日 (YYYY-MM-DD)。未登録は null */
  moushitateDate: string | null;
  /** 過誤申立事由コード (4桁 = 様式番号 + 申立理由番号) */
  jiyuCode: string | null;
  /** 同月過誤 (申立と再請求を同月処理) */
  dougetsu: boolean;
}

/* ══════════════ 様式番号 (前2桁) — 取下げ対象の請求明細書の様式 ══════════════ */

/**
 * 介護給付 + 介護予防給付の様式番号一覧 (台東区公表一覧に準拠。
 * インタフェース仕様書 項番102 の記載 10/21/22/23/30/40/50/60/70 を包含)。
 * 本アプリ (訪問介護・訪問入浴) の既定値は "10"。
 */
export const KAGO_YOSHIKI_CODES: { code: string; label: string }[] = [
  { code: "10", label: "居宅サービス (訪問介護・訪問入浴・訪問看護・通所介護・福祉用具貸与 等)" },
  { code: "11", label: "介護予防サービス (予防訪問介護・予防訪問入浴 等)" },
  { code: "21", label: "短期入所生活介護" },
  { code: "22", label: "短期入所療養介護 (介護老人保健施設)" },
  { code: "2A", label: "短期入所療養介護 (介護医療院)" },
  { code: "23", label: "短期入所療養介護 (介護療養型医療施設等)" },
  { code: "24", label: "介護予防短期入所生活介護" },
  { code: "25", label: "介護予防短期入所療養介護 (介護老人保健施設)" },
  { code: "2B", label: "介護予防短期入所療養介護 (介護医療院)" },
  { code: "26", label: "介護予防短期入所療養介護 (介護療養型医療施設等)" },
  { code: "30", label: "認知症対応型共同生活介護 (短期利用以外)" },
  { code: "31", label: "介護予防認知症対応型共同生活介護 (短期利用以外)" },
  { code: "32", label: "特定施設入居者生活介護 (短期利用以外)" },
  { code: "33", label: "介護予防特定施設入居者生活介護" },
  { code: "34", label: "認知症対応型共同生活介護 (短期利用)" },
  { code: "35", label: "介護予防認知症対応型共同生活介護 (短期利用)" },
  { code: "36", label: "特定施設入居者生活介護 (短期利用)" },
  { code: "40", label: "居宅介護支援 (計画費)" },
  { code: "41", label: "介護予防支援 (計画費)" },
  { code: "50", label: "介護福祉施設サービス" },
  { code: "60", label: "介護保健施設サービス" },
  { code: "61", label: "介護医療院サービス" },
  { code: "70", label: "介護療養施設サービス" },
];

/* ══════════════ 申立理由番号 (後2桁) ══════════════ */

export interface KagoRiyu {
  code: string;
  label: string;
  /** 同月過誤用のコードか */
  dougetsu: boolean;
  /** 通常↔同月の対応コード (あれば) */
  pair?: string;
}

export const KAGO_RIYU_CODES: KagoRiyu[] = [
  // ── インタフェース仕様書 項番102 の標準値 ──
  { code: "01", label: "台帳誤り修正による保険者申立の過誤調整", dougetsu: false },
  { code: "02", label: "請求誤りによる実績取下げ", dougetsu: false, pair: "12" },
  { code: "09", label: "時効による保険者申立の取下げ", dougetsu: false },
  { code: "11", label: "台帳誤り修正による事業所申立の過誤調整", dougetsu: false },
  { code: "21", label: "台帳誤り修正による公費負担者申立の過誤調整", dougetsu: false },
  { code: "29", label: "時効による公費負担者申立の取下げ", dougetsu: false },
  { code: "32", label: "給付管理票取消による実績の取下げ", dougetsu: false },
  { code: "90", label: "その他の事由による台帳過誤", dougetsu: false },
  { code: "99", label: "その他の事由による実績の取下げ (指導検査含む)", dougetsu: false },
  // ── 保険者公表の現行一覧より (同月過誤・適正化系) ──
  { code: "12", label: "請求誤りによる実績取下げ (同月)", dougetsu: true, pair: "02" },
  { code: "42", label: "適正化 (その他) による過誤取下げ (指導検査含む)", dougetsu: false },
  { code: "45", label: "適正化 (医療突合) による過誤取下げ", dougetsu: false, pair: "4C" },
  { code: "46", label: "適正化 (縦覧点検) による過誤取下げ", dougetsu: false, pair: "4D" },
  { code: "4C", label: "適正化 (医療突合) による過誤取下げ (同月)", dougetsu: true, pair: "45" },
  { code: "4D", label: "適正化 (縦覧点検) による過誤取下げ (同月)", dougetsu: true, pair: "46" },
];

/** 本アプリ (訪問介護・訪問入浴 = 様式10) の既定コード: 請求誤りによる実績取下げ */
export const KAGO_DEFAULT_YOSHIKI = "10";
export const KAGO_DEFAULT_RIYU = "02";

/* ══════════════ コードヘルパ ══════════════ */

/** 4桁コード → { 様式番号, 申立理由番号 }。形式外は null */
export function splitKagoJiyuCode(
  code: string | null | undefined,
): { yoshiki: string; riyu: string } | null {
  const s = (code ?? "").trim().toUpperCase();
  if (!/^[0-9A-Z]{4}$/.test(s)) return null;
  return { yoshiki: s.slice(0, 2), riyu: s.slice(2, 4) };
}

export function kagoYoshikiLabel(code: string): string {
  return KAGO_YOSHIKI_CODES.find((c) => c.code === code)?.label ?? "";
}

export function kagoRiyuLabel(code: string): string {
  return KAGO_RIYU_CODES.find((c) => c.code === code)?.label ?? "";
}

/** 4桁コードの読み下し (例: "1002 = 居宅サービス… / 請求誤りによる実績取下げ") */
export function kagoJiyuCodeLabel(code: string | null | undefined): string {
  const parts = splitKagoJiyuCode(code);
  if (!parts) return code ?? "";
  const y = kagoYoshikiLabel(parts.yoshiki);
  const r = kagoRiyuLabel(parts.riyu);
  return `${parts.yoshiki}${parts.riyu}${y || r ? ` (${[y, r].filter(Boolean).join(" / ")})` : ""}`;
}

/**
 * 同月過誤チェックの ON/OFF に合わせて理由番号を通常↔同月の対応コードに付け替える。
 * 対応コードが無い理由 (01/42/99 等) はそのまま返す。
 */
export function toggleDougetsuRiyu(riyu: string, dougetsu: boolean): string {
  const def = KAGO_RIYU_CODES.find((c) => c.code === riyu);
  if (!def) return riyu;
  if (def.dougetsu === dougetsu) return riyu;
  return def.pair ?? riyu;
}

/* ══════════════ 保険者提出用の過誤申立一覧 (CSV) ══════════════ */

export interface KagoMoushitateRow {
  clientId: string;
  clientName: string;
  insuredNumber: string | null;
  targetMonth: string; // 'YYYY-MM' (サービス提供月)
  moushitateDate: string | null;
  jiyuCode: string | null;
  dougetsu: boolean;
  notes: string | null;
}

// テーブル未作成 (直 SQL=42P01 / PostgREST schema cache=PGRST205) 判定
const isMissingTable = (code: string | null | undefined) =>
  code === "42P01" || code === "PGRST205";

/**
 * 過誤申立中 (kago=true × 国保未対象 = 取下げ済で再請求未実施) の一覧を返す。
 * kago_* 列が未適用 (migrations/kago_saiseikyu.sql 未実行) の環境では
 * 付帯情報なし (colsMissing=true) で kago フラグ行のみ返す。
 */
export async function loadKagoMoushitateRows(
  supabase: SupabaseClient,
  opts: { officeId: string; table?: string },
): Promise<{ rows: KagoMoushitateRow[]; colsMissing: boolean }> {
  const table = opts.table ?? "kaigo_billing_status";
  const BASE = "client_id, target_month, notes";
  const EXT = `${BASE}, kago_moushitate_date, kago_jiyu_code, kago_dougetsu`;

  interface DbRow {
    client_id: string;
    target_month: string;
    notes: string | null;
    kago_moushitate_date?: string | null;
    kago_jiyu_code?: string | null;
    kago_dougetsu?: boolean;
  }

  // select 文字列が異なると PostgREST の戻り型が合わずに再代入できないため
  // 共通の緩い型で受ける (data は下で DbRow[] にキャスト)
  interface QueryRes {
    data: unknown;
    error: { code?: string; message: string } | null;
  }
  const fetchPage = (cols: string, from: number, to: number): Promise<QueryRes> =>
    supabase
      .from(table)
      .select(cols)
      .eq("office_id", opts.officeId)
      .eq("kago", true)
      .eq("kokuho_target", false)
      .order("target_month", { ascending: true })
      .range(from, to) as unknown as Promise<QueryRes>;

  let colsMissing = false;
  const raw: DbRow[] = [];
  // PostgREST 1000 行 limit 対応の page-loop
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let res = await fetchPage(EXT, from, from + PAGE - 1);
    if (res.error && res.error.code === "42703") {
      // kago_* 列が未適用 → 基本列のみで再取得
      colsMissing = true;
      res = await fetchPage(BASE, from, from + PAGE - 1);
    }
    if (res.error) {
      if (isMissingTable(res.error.code)) return { rows: [], colsMissing };
      throw new Error("過誤申立一覧の取得に失敗: " + res.error.message);
    }
    const page = (res.data ?? []) as DbRow[];
    raw.push(...page);
    if (page.length < PAGE) break;
  }
  if (raw.length === 0) return { rows: [], colsMissing };

  // 利用者名・被保険者番号の突合
  const ids = [...new Set(raw.map((r) => r.client_id))];
  const clientById = new Map<string, { name: string; insured: string | null }>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase
      .from("clients")
      .select("id, name, insured_number")
      .in("id", ids.slice(i, i + 200));
    if (error) throw new Error("利用者マスタの取得に失敗: " + error.message);
    for (const c of (data ?? []) as { id: string; name: string; insured_number: string | null }[]) {
      clientById.set(c.id, { name: c.name, insured: c.insured_number });
    }
  }

  return {
    rows: raw.map((r) => ({
      clientId: r.client_id,
      clientName: clientById.get(r.client_id)?.name ?? "(名称不明)",
      insuredNumber: clientById.get(r.client_id)?.insured ?? null,
      targetMonth: r.target_month,
      moushitateDate: r.kago_moushitate_date ?? null,
      jiyuCode: r.kago_jiyu_code ?? null,
      dougetsu: !!r.kago_dougetsu,
      notes: r.notes,
    })),
    colsMissing,
  };
}

/** CSV セルの防御 (カンマ・引用符・改行) */
const csvCell = (s: string | null | undefined) => {
  const v = (s ?? "").replace(/\r?\n/g, " ");
  return /[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

/**
 * 保険者提出用の過誤申立一覧 CSV (Excel 閲覧用 BOM は呼出側で付ける)。
 * 列: 提供年月 / 被保険者番号 / 利用者名 / 過誤申立事由コード / 様式番号 / 様式 /
 *     申立理由番号 / 申立理由 / 同月過誤 / 過誤申立日 / メモ
 */
export function buildKagoMoushitateCsv(rows: KagoMoushitateRow[]): string {
  const header = [
    "提供年月",
    "被保険者番号",
    "利用者名",
    "過誤申立事由コード",
    "様式番号",
    "様式",
    "申立理由番号",
    "申立理由",
    "同月過誤",
    "過誤申立日",
    "メモ",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    const parts = splitKagoJiyuCode(r.jiyuCode);
    lines.push(
      [
        r.targetMonth.replace("-", ""), // YYYYMM
        r.insuredNumber ?? "",
        csvCell(r.clientName),
        r.jiyuCode ?? "",
        parts?.yoshiki ?? "",
        csvCell(parts ? kagoYoshikiLabel(parts.yoshiki) : ""),
        parts?.riyu ?? "",
        csvCell(parts ? kagoRiyuLabel(parts.riyu) : ""),
        r.dougetsu ? "同月" : "",
        r.moushitateDate ?? "",
        csvCell(r.notes),
      ].join(","),
    );
  }
  return lines.join("\r\n");
}
