/**
 * 障害の契約情報 (受給者証「事業者記入欄」) の読み書き。
 *
 * ── 何を持っているか ──────────────────────────────────────────────────
 *   伝送 J121 契約情報レコード (05) の出所。原典 (docs/kokuho_if/障害IF_サービス事業所編_R7.04.pdf
 *   P.29) では 決定サービスコードごとに 1 レコードが **◎必須**。
 *     項7 決定サービスコード / 項8 契約支給量 / 項9 契約開始年月日 /
 *     項10 契約終了年月日 (○: 終了時のみ) / 項11 事業者記入欄番号
 *
 * ── 契約支給量の単位 ──────────────────────────────────────────────────
 *   伝送は「整数3桁+小数2桁」の 5 桁。100.5時間→10050 / 12日→01200 / 5回→00500。
 *   DB は amount_x100 (小数2桁を保った整数) で持つ。32時間30分 → 3250。
 *   ⚠ 浮動小数で持つと 32.5 が 32.499… になり伝送で 1 桁ずれる。必ず整数で扱うこと。
 *
 * ── 履歴 ──────────────────────────────────────────────────────────────
 *   支給量を変えたら新しい行を足し、古い行に end_date を入れる。
 *   請求は「その月に有効な行」だけを使う → 月遅れ・過誤の再請求でも当時の契約が出る。
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** 決定サービスコード → 表示名 (共通編 コード一覧より。訪問系のみ) */
export const DECISION_CODES: Record<string, string> = {
  "111000": "居宅介護 身体介護",
  "112000": "居宅介護 家事援助",
  "113000": "居宅介護 通院等介助 (身体介護伴う)",
  "114000": "居宅介護 通院等介助 (身体介護伴わない)",
  "115000": "居宅介護 通院等乗降介助",
  "110908": "居宅介護 特別地域加算対象者",
  "121000": "重度訪問介護 重度障害者等包括支援対象者",
  "122000": "重度訪問介護 障害支援区分6該当者",
  "123000": "重度訪問介護 その他",
  "120901": "重度訪問介護 加算移動介護",
  "120908": "重度訪問介護 特別地域加算対象者",
  "151000": "同行援護 (身体介護伴う)",
  "152000": "同行援護 (身体介護伴わない)",
  "153000": "同行援護 基本",
  "154000": "同行援護 基本 (盲ろう者)",
  "150908": "同行援護 特別地域加算対象者",
  "141000": "重度包括支援 基本",
  "140908": "重度包括支援 特別地域加算対象者",
};

/** 決定コードの既定の単位。通院等乗降介助だけ「回」 */
export function defaultUnitOf(code: string): "時間" | "日" | "回" {
  return code === "115000" ? "回" : "時間";
}

export interface ShogaiContract {
  id: string;
  client_id: string;
  office_id: string;
  decision_code: string;
  amount_x100: number;
  amount_unit: string;
  entry_number: number | null;
  start_date: string;
  end_date: string | null;
  provided_before_end_x100: number | null;
  reason: string;
  notes: string | null;
}

/** 伝送用の 5 桁 (整数3+小数2)。3250 → "03250" */
export const toDensouAmount = (x100: number) => String(Math.round(x100)).padStart(5, "0");

/** 「32時間30分」形式の表示。回・日は小数のまま */
export function formatAmount(x100: number, unit: string): string {
  const whole = Math.floor(x100 / 100);
  const frac = x100 % 100;
  if (unit === "時間") {
    const min = Math.round((frac / 100) * 60);
    return min === 0 ? `${whole}時間` : `${whole}時間${min}分`;
  }
  return frac === 0 ? `${whole}${unit}` : `${whole}.${String(frac).padStart(2, "0")}${unit}`;
}

/** 「32時間30分」「32.5」「32:30」など人の入力を x100 に正規化する */
// 単位 (時間/回) は表示のときだけ要る。パースは書式で判別できるので受け取らない
export function parseAmount(input: string): number | null {
  const s = input.normalize("NFKC").trim();
  if (!s) return null;
  let m = /^(\d+)\s*時間\s*(\d+)?\s*分?$/.exec(s);
  if (m) return Number(m[1]) * 100 + Math.round((Number(m[2] ?? 0) / 60) * 100);
  m = /^(\d+):(\d{1,2})$/.exec(s);
  if (m) return Number(m[1]) * 100 + Math.round((Number(m[2]) / 60) * 100);
  m = /^(\d+)(?:\.(\d{1,2}))?\s*(?:時間|日|回)?$/.exec(s);
  if (m) {
    const whole = Number(m[1]);
    const frac = m[2] ? Number(m[2].padEnd(2, "0")) : 0;
    // 「32.5」は 時間なら 32.5時間 = 3250 (32時間30分)。日・回も小数2桁として扱う
    return whole * 100 + frac;
  }
  return null;
}

/**
 * 対象月に有効な契約を引く。
 * 「有効」= start_date が月末以前 かつ (end_date が無い or 月初以降)。
 * 同じ決定コードで複数該当したら **start_date が新しい方**を採る (途中変更)。
 */
export async function loadContractsForMonth(
  supabase: SupabaseClient,
  officeId: string,
  clientIds: string[],
  year: number,
  month: number,
): Promise<Map<string, ShogaiContract[]>> {
  const out = new Map<string, ShogaiContract[]>();
  if (!officeId || clientIds.length === 0) return out;
  const first = `${year}-${String(month).padStart(2, "0")}-01`;
  const last = `${year}-${String(month).padStart(2, "0")}-${String(new Date(year, month, 0).getDate()).padStart(2, "0")}`;

  const rows: ShogaiContract[] = [];
  for (let i = 0; i < clientIds.length; i += 100) {
    const { data, error } = await supabase
      .from("shogai_contracts")
      .select(
        "id, client_id, office_id, decision_code, amount_x100, amount_unit, entry_number, start_date, end_date, provided_before_end_x100, reason, notes",
      )
      .eq("office_id", officeId)
      .in("client_id", clientIds.slice(i, i + 100))
      .lte("start_date", last)
      .or(`end_date.is.null,end_date.gte.${first}`)
      .order("start_date", { ascending: true });
    // テーブル未適用 (42P01 / PGRST205) でも請求は止めない — 契約なしとして続行する
    if (error) return out;
    rows.push(...((data ?? []) as ShogaiContract[]));
  }

  for (const r of rows) {
    if (!out.has(r.client_id)) out.set(r.client_id, []);
    const list = out.get(r.client_id)!;
    // 同じ決定コードは新しい start_date で置き換える (order 昇順なので後勝ちでよい)
    const i = list.findIndex((x) => x.decision_code === r.decision_code);
    if (i >= 0) list[i] = r;
    else list.push(r);
  }
  // 伝送の並びに合わせて決定コード昇順
  for (const list of out.values()) list.sort((a, b) => a.decision_code.localeCompare(b.decision_code));
  return out;
}

/**
 * サービス利用開始年月日 (伝送 J121-02 項8) を引く。
 * キーは 利用者 × 事業所 × サービス種類コード (11=居宅介護 / 12=重度訪問 / 15=同行援護)。
 *
 * ⚠ 契約日ではない。「一連とみなされる利用契約の下で最初にサービスを提供した日」
 *   (原典 サービス事業所編 P.18)。契約支給量を変更しても動かない。
 */
export async function loadServiceStartDates(
  supabase: SupabaseClient,
  officeId: string,
  clientIds: string[],
): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>();
  if (!officeId || clientIds.length === 0) return out;
  for (let i = 0; i < clientIds.length; i += 100) {
    const { data, error } = await supabase
      .from("shogai_service_start")
      .select("client_id, service_type_code, start_date")
      .eq("office_id", officeId)
      .in("client_id", clientIds.slice(i, i + 100));
    // テーブル未適用でも請求は止めない (従来の代替に落ちる)
    if (error) return out;
    for (const r of (data ?? []) as {
      client_id: string;
      service_type_code: string;
      start_date: string;
    }[]) {
      if (!out.has(r.client_id)) out.set(r.client_id, new Map());
      out.get(r.client_id)!.set(r.service_type_code, r.start_date);
    }
  }
  return out;
}
