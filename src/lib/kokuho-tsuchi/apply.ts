/**
 * 国保連通知ファイル取込の DB 反映ロジック
 *
 *   - 被保険者番号 → client_id の突合 (clients.insured_number 優先、
 *     client_insurance_records.insured_number をフォールバック)
 *   - 取込ファイル/明細行の raw 保存 (kokuho_shinsa_notice_files / _rows)
 *   - 返戻 (7411) → kaigo_billing_status.henrei 自動セット
 *   - 支払決定額通知 (7511/7513) → kokuho_nyukin_records.kettei_amount 取込
 *   - 「返戻・過誤あり × 再請求未実施」の突合リスト
 *
 * ⚠ 実ファイル未検証: パーサ (parse.ts) と同様、仕様書由来の実装。
 *   初回の実ファイル取込ではプレビューで突合結果・金額を必ず目視確認すること。
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  HenreiRow,
  ParsedNoticeFile,
  RawDataRecord,
  ShiharaiKettei,
} from "./parse";
import { HENREI_JIYU_LABEL } from "./parse";

/* ══════════════════════ 共通ヘルパ ══════════════════════ */

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** "YYYYMMDD" → "YYYY-MM-DD" (それ以外は null) */
function dateToIso(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!/^\d{8}$/.test(s)) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/** テーブル未作成 (migration 未適用) 判定 */
function isMissingTable(code: string | undefined | null): boolean {
  return code === "42P01" || code === "PGRST205";
}

/* ══════════════════════ テーブル存在チェック ══════════════════════ */

/**
 * kokuho_shinsa_notice_files / _rows が適用済みかを確認する。
 * 未適用なら { exists: false } — 取込画面はガイダンス表示のみにフォールバックする。
 */
export async function checkNoticeTables(
  supabase: SupabaseClient,
): Promise<{ exists: boolean; error: string | null }> {
  const { error } = await supabase
    .from("kokuho_shinsa_notice_files")
    .select("id", { count: "exact", head: true })
    .limit(1);
  if (error) {
    if (isMissingTable(error.code)) return { exists: false, error: null };
    return { exists: false, error: error.message };
  }
  return { exists: true, error: null };
}

/* ══════════════════════ 被保険者番号 → client 突合 ══════════════════════ */

export interface MatchedClient {
  clientId: string;
  name: string;
  /** どこで突合したか */
  source: "clients" | "insurance_records";
}

/**
 * 被保険者番号のリストから client_id を解決する。
 * 1. clients.insured_number 完全一致 (careplan-import と同じパターン)
 * 2. 未解決分は client_insurance_records.insured_number で解決
 * 解決できないものは Map に入らない (呼出側で「未突合」として扱う。silent skip 禁止)。
 */
export async function resolveClientsByInsuredNumber(
  supabase: SupabaseClient,
  insuredNumbers: string[],
): Promise<Map<string, MatchedClient>> {
  const result = new Map<string, MatchedClient>();
  const targets = [...new Set(insuredNumbers.map((s) => s.trim()).filter(Boolean))];
  if (targets.length === 0) return result;

  // 1) clients.insured_number
  for (const part of chunk(targets, 200)) {
    const { data, error } = await supabase
      .from("clients")
      .select("id, name, insured_number")
      .in("insured_number", part);
    if (error) throw new Error("利用者マスタの突合に失敗: " + error.message);
    for (const row of (data ?? []) as { id: string; name: string; insured_number: string | null }[]) {
      if (row.insured_number && !result.has(row.insured_number)) {
        result.set(row.insured_number, { clientId: row.id, name: row.name, source: "clients" });
      }
    }
  }

  // 2) client_insurance_records.insured_number (フォールバック)
  const unresolved = targets.filter((t) => !result.has(t));
  if (unresolved.length > 0) {
    const foundIds = new Map<string, string>(); // insured_number -> client_id
    for (const part of chunk(unresolved, 200)) {
      const { data, error } = await supabase
        .from("client_insurance_records")
        .select("client_id, insured_number")
        .in("insured_number", part);
      if (error) {
        // テーブル/列が無い環境ではフォールバックせず 1) の結果のみ返す
        if (!isMissingTable(error.code) && error.code !== "42703") {
          throw new Error("保険証履歴の突合に失敗: " + error.message);
        }
        break;
      }
      for (const row of (data ?? []) as { client_id: string; insured_number: string | null }[]) {
        if (row.insured_number && !foundIds.has(row.insured_number)) {
          foundIds.set(row.insured_number, row.client_id);
        }
      }
    }
    const ids = [...new Set(foundIds.values())];
    if (ids.length > 0) {
      const nameById = new Map<string, string>();
      for (const part of chunk(ids, 200)) {
        const { data, error } = await supabase.from("clients").select("id, name").in("id", part);
        if (error) throw new Error("利用者名の取得に失敗: " + error.message);
        for (const row of (data ?? []) as { id: string; name: string }[]) nameById.set(row.id, row.name);
      }
      for (const [insured, clientId] of foundIds) {
        result.set(insured, {
          clientId,
          name: nameById.get(clientId) ?? "(名称不明)",
          source: "insurance_records",
        });
      }
    }
  }

  return result;
}

/* ══════════════════════ ファイル/明細行の raw 保存 ══════════════════════ */

export interface SaveNoticeFileResult {
  fileId: string;
  rowCount: number;
}

/**
 * パース結果を kokuho_shinsa_notice_files + _rows に raw 保存する (監査可能性)。
 * 突合結果 (client_id / match_status) も行に記録する。
 */
export async function saveNoticeFile(
  supabase: SupabaseClient,
  opts: {
    tenantId: string;
    officeId: string;
    parsed: ParsedNoticeFile;
    rawContent: string;
    matches: Map<string, MatchedClient>;
  },
): Promise<SaveNoticeFileResult> {
  const { tenantId, officeId, parsed, rawContent, matches } = opts;

  const exchangeNumbers = [...new Set(parsed.rawRecords.map((r) => r.exchangeNumber))];
  const { data: fileRow, error: fileErr } = await supabase
    .from("kokuho_shinsa_notice_files")
    .insert({
      tenant_id: tenantId,
      office_id: officeId,
      file_name: parsed.fileName,
      data_type: parsed.control?.dataType ?? null,
      exchange_numbers: exchangeNumbers,
      shinsa_ym: parsed.shinsaYm,
      control_office_number: parsed.headerOfficeNumber,
      record_count: parsed.rawRecords.length,
      raw_content: rawContent,
    })
    .select("id")
    .single();
  if (fileErr) throw new Error("取込ファイルの保存に失敗: " + fileErr.message);
  const fileId = (fileRow as { id: string }).id;

  // 明細行: raw レコード全件を保存。7411 D1 は突合結果付き。
  const henreiByRowIndex = new Map(parsed.henreiRows.map((r) => [r.rowIndex, r]));
  const ketteiByRowIndex = new Map(parsed.shiharaiKettei.map((r) => [r.rowIndex, r]));
  const uchiwakeByRowIndex = new Map(parsed.uchiwakeRows.map((r) => [r.rowIndex, r]));
  const zougenByRowIndex = new Map(parsed.zougenRows.map((r) => [r.rowIndex, r]));

  const rows = parsed.rawRecords.map((raw: RawDataRecord) => {
    const base = {
      tenant_id: tenantId,
      office_id: officeId,
      file_id: fileId,
      notice_type: raw.noticeKind,
      exchange_number: raw.exchangeNumber,
      record_kind: raw.recordKind,
      row_index: raw.rowIndex,
      shinsa_ym: parsed.shinsaYm,
      service_ym: null as string | null,
      insurer_number: null as string | null,
      insured_number: null as string | null,
      kana_name: null as string | null,
      shubetsu: null as string | null,
      service_kind_code: null as string | null,
      tanisu: null as number | null,
      jiyu_code: null as string | null,
      jiyu_naiyo: null as string | null,
      biko: null as string | null,
      amount: null as number | null,
      payload: { fields: raw.fields } as Record<string, unknown>,
      client_id: null as string | null,
      match_status: "na" as "matched" | "unmatched" | "na",
    };
    const henrei = raw.recordKind === "D1" ? henreiByRowIndex.get(raw.rowIndex) : undefined;
    if (raw.noticeKind === "henrei" && henrei) {
      const m = matches.get(henrei.insuredNumber);
      return {
        ...base,
        service_ym: henrei.serviceYm,
        insurer_number: henrei.insurerNumber,
        insured_number: henrei.insuredNumber,
        kana_name: henrei.kanaName,
        shubetsu: henrei.shubetsu,
        service_kind_code: henrei.serviceKindCode,
        tanisu: henrei.tanisu,
        jiyu_code: henrei.jiyuCode,
        jiyu_naiyo: henrei.jiyuNaiyo,
        biko: henrei.biko,
        client_id: m?.clientId ?? null,
        match_status: (m ? "matched" : "unmatched") as "matched" | "unmatched",
      };
    }
    const kettei = ketteiByRowIndex.get(raw.rowIndex);
    if (raw.noticeKind === "shiharai_kettei" && kettei) {
      return { ...base, amount: kettei.furikomiAmount, payload: { ...base.payload, parsed: kettei } };
    }
    const uchiwake = raw.recordKind === "D1" ? uchiwakeByRowIndex.get(raw.rowIndex) : undefined;
    if (raw.noticeKind === "shiharai_uchiwake" && uchiwake) {
      return {
        ...base,
        service_ym: uchiwake.serviceYm,
        insurer_number: uchiwake.insurerNumber,
        service_kind_code: uchiwake.serviceKindCode,
        tanisu: uchiwake.tanisu,
        amount: uchiwake.kingaku,
      };
    }
    const zougen = raw.recordKind === "D1" ? zougenByRowIndex.get(raw.rowIndex) : undefined;
    if (raw.noticeKind === "zougen" && zougen) {
      return {
        ...base,
        service_ym: zougen.serviceYm,
        insurer_number: zougen.insurerNumber,
        tanisu: zougen.satei.tanisuKaigo, // 査定増減の単位数を代表値として保存
        payload: { ...base.payload, parsed: zougen },
      };
    }
    return base;
  });

  for (const part of chunk(rows, 500)) {
    const { error } = await supabase.from("kokuho_shinsa_notice_rows").insert(part);
    if (error) throw new Error("取込明細の保存に失敗: " + error.message);
  }

  return { fileId, rowCount: rows.length };
}

/* ══════════════════════ 返戻 → kaigo_billing_status 反映 ══════════════════════ */

export interface HenreiApplyEntry {
  clientId: string;
  clientName: string;
  targetMonth: string; // 'YYYY-MM' (サービス提供年月)
  row: HenreiRow;
}

export interface HenreiApplyResult {
  applied: number; // henrei フラグを立てた (client, month) 数
  alreadyFlagged: number; // 既に henrei=true だった数
}

/**
 * 突合済みの 7411 明細を kaigo_billing_status.henrei=true に反映する。
 * 既存行の tsukiokure / kago / kokuho_target は保持 (upsert で列を渡さない)。
 * notes には返戻事由を追記する (同一内容の重複追記はしない)。
 */
export async function applyHenreiFlags(
  supabase: SupabaseClient,
  opts: {
    tenantId: string;
    officeId: string;
    shinsaYm: string | null;
    entries: HenreiApplyEntry[];
  },
): Promise<HenreiApplyResult> {
  const { tenantId, officeId, shinsaYm, entries } = opts;
  if (entries.length === 0) return { applied: 0, alreadyFlagged: 0 };

  // (client_id, target_month) 単位に事由を集約
  const byKey = new Map<string, { clientId: string; targetMonth: string; reasons: string[] }>();
  for (const e of entries) {
    const key = `${e.clientId}|${e.targetMonth}`;
    const cur = byKey.get(key) ?? { clientId: e.clientId, targetMonth: e.targetMonth, reasons: [] };
    const jiyuLabel = e.row.jiyuCode
      ? `${e.row.jiyuCode}(${HENREI_JIYU_LABEL[e.row.jiyuCode] ?? "不明"})`
      : "";
    const reason = [
      e.row.shubetsu ? `種別${e.row.shubetsu}` : null,
      jiyuLabel || null,
      e.row.jiyuNaiyo || null,
      e.row.biko || null,
    ]
      .filter(Boolean)
      .join(" ");
    if (reason && !cur.reasons.includes(reason)) cur.reasons.push(reason);
    byKey.set(key, cur);
  }

  // 既存行 (notes/henrei) を取得して notes を安全にマージする
  const clientIds = [...new Set([...byKey.values()].map((v) => v.clientId))];
  const months = [...new Set([...byKey.values()].map((v) => v.targetMonth))];
  const existing = new Map<string, { notes: string | null; henrei: boolean }>();
  for (const part of chunk(clientIds, 100)) {
    const { data, error } = await supabase
      .from("kaigo_billing_status")
      .select("client_id, target_month, notes, henrei")
      .in("client_id", part)
      .in("target_month", months);
    if (error) throw new Error("請求状態の取得に失敗: " + error.message);
    for (const r of (data ?? []) as {
      client_id: string;
      target_month: string;
      notes: string | null;
      henrei: boolean;
    }[]) {
      existing.set(`${r.client_id}|${r.target_month}`, { notes: r.notes, henrei: r.henrei });
    }
  }

  const marker = `[返戻取込${shinsaYm ? " " + shinsaYm + "審査" : ""}]`;
  let alreadyFlagged = 0;
  const payloads = [...byKey.entries()].map(([key, v]) => {
    const ex = existing.get(key);
    if (ex?.henrei) alreadyFlagged += 1;
    const addition = `${marker} ${v.reasons.join(" / ")}`.trim();
    let notes = ex?.notes ?? "";
    if (addition && !notes.includes(addition)) {
      notes = notes ? `${notes}\n${addition}` : addition;
    }
    return {
      client_id: v.clientId,
      target_month: v.targetMonth,
      office_id: officeId,
      tenant_id: tenantId,
      henrei: true,
      notes: notes || null,
    };
  });

  for (const part of chunk(payloads, 200)) {
    const { error } = await supabase
      .from("kaigo_billing_status")
      .upsert(part, { onConflict: "client_id,target_month" });
    if (error) throw new Error("返戻フラグの反映に失敗: " + error.message);
  }

  return { applied: payloads.length, alreadyFlagged };
}

/* ══════════════════════ 支払決定額 → kokuho_nyukin_records 反映 ══════════════════════ */

export interface ShiharaiApplyResult {
  updated: number; // 既存入金行に kettei_amount を反映した数
  inserted: number; // 新規作成した数 (請求スナップショット未登録月)
}

/**
 * 支払決定額通知 (7511/7513) を kokuho_nyukin_records に反映する。
 *   - target_month = 審査年月 (請求月)。既存の「請求額スナップショット vs 支払決定額」差額表示に乗る
 *   - kettei_amount = 振込金額 (項10 支払決定金額) / nyukin_date = 作成年月日 (振込日)
 *   - 既存行の seikyu_amount / status は変更しない (状態遷移はユーザー管理)
 */
export async function applyShiharaiKettei(
  supabase: SupabaseClient,
  opts: { tenantId: string; officeId: string; notices: ShiharaiKettei[] },
): Promise<ShiharaiApplyResult> {
  const { tenantId, officeId, notices } = opts;
  let updated = 0;
  let inserted = 0;

  for (const n of notices) {
    if (!n.shinsaYm) {
      throw new Error(`支払決定額通知 (行${n.rowIndex}) の審査年月が読み取れません`);
    }
    if (n.furikomiAmount == null) {
      throw new Error(`支払決定額通知 (行${n.rowIndex}) の振込金額が読み取れません`);
    }
    const note = `[支払決定取込] 給付費${n.kaigoKyufuhiAmount ?? "-"}円 / 合計${n.goukeiAmount ?? "-"}円 / ${n.bankName} ${n.branchName}`;

    const { data: ex, error: exErr } = await supabase
      .from("kokuho_nyukin_records")
      .select("id, notes")
      .eq("office_id", officeId)
      .eq("target_month", n.shinsaYm)
      .maybeSingle();
    if (exErr) throw new Error("入金レコードの取得に失敗: " + exErr.message);

    if (ex) {
      const exRow = ex as { id: string; notes: string | null };
      const notes = exRow.notes?.includes(note)
        ? exRow.notes
        : exRow.notes
          ? `${exRow.notes}\n${note}`
          : note;
      const { error } = await supabase
        .from("kokuho_nyukin_records")
        .update({
          kettei_amount: n.furikomiAmount,
          nyukin_date: dateToIso(n.furikomiDate),
          notes,
        })
        .eq("id", exRow.id);
      if (error) throw new Error("支払決定額の反映に失敗: " + error.message);
      updated += 1;
    } else {
      const { error } = await supabase.from("kokuho_nyukin_records").insert({
        tenant_id: tenantId,
        office_id: officeId,
        target_month: n.shinsaYm,
        seikyu_amount: 0, // 請求スナップショット未登録月 (国保入金管理タブで請求額を確認)
        kettei_amount: n.furikomiAmount,
        nyukin_date: dateToIso(n.furikomiDate),
        notes: `${note}\n※請求額スナップショット未登録の月に支払決定通知を取り込みました`,
      });
      if (error) throw new Error("支払決定額の登録に失敗: " + error.message);
      inserted += 1;
    }
  }
  return { updated, inserted };
}

/* ══════════════════════ 行の applied マーク ══════════════════════ */

/** 自動反映が完了した行 (返戻=突合済 / 支払決定) に applied=true を付ける */
export async function markRowsApplied(
  supabase: SupabaseClient,
  fileId: string,
): Promise<void> {
  const { error } = await supabase
    .from("kokuho_shinsa_notice_rows")
    .update({ applied: true, applied_at: new Date().toISOString() })
    .eq("file_id", fileId)
    .or("and(notice_type.eq.henrei,match_status.eq.matched,record_kind.eq.D1),notice_type.eq.shiharai_kettei");
  if (error) throw new Error("反映済みマークの更新に失敗: " + error.message);
}

/* ══════════════════ 返戻・過誤 × 再請求未実施 の突合リスト ══════════════════ */

export interface MissedReSeikyuRow {
  clientId: string;
  clientName: string;
  targetMonth: string;
  notes: string | null;
  tsukiokure: boolean;
  henrei: boolean;
  kago: boolean;
}

/**
 * 「返戻または過誤フラグあり × 再請求未実施」の一覧。
 * 再請求の実施済み判定は re-seikyu.ts と同じ: kokuho_target=false のうちは未実施
 * (再請求を伝送し国保対象化すると kokuho_target=true になる)。
 * 過誤は請求画面の「過誤申立」ブロックで申立を登録 (= 取下げ = kokuho_target 解除)
 * した時点からこの一覧に乗る (グリッドの過誤フラグだけでは国保対象のまま = 対象外)。
 */
export async function loadMissedReSeikyu(
  supabase: SupabaseClient,
  officeId: string,
): Promise<MissedReSeikyuRow[]> {
  const rows: {
    client_id: string;
    target_month: string;
    notes: string | null;
    tsukiokure: boolean;
    henrei: boolean;
    kago: boolean;
  }[] = [];
  // PostgREST 1000 行 limit 対応の page-loop
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("kaigo_billing_status")
      .select("client_id, target_month, notes, tsukiokure, henrei, kago")
      .eq("office_id", officeId)
      .or("henrei.eq.true,kago.eq.true")
      .eq("kokuho_target", false)
      .order("target_month", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) {
      if (isMissingTable(error.code)) return [];
      throw new Error("返戻・過誤状態の取得に失敗: " + error.message);
    }
    rows.push(...((data ?? []) as typeof rows));
    if (!data || data.length < PAGE) break;
  }
  if (rows.length === 0) return [];

  const nameById = new Map<string, string>();
  for (const part of chunk([...new Set(rows.map((r) => r.client_id))], 200)) {
    const { data, error } = await supabase.from("clients").select("id, name").in("id", part);
    if (error) throw new Error("利用者名の取得に失敗: " + error.message);
    for (const c of (data ?? []) as { id: string; name: string }[]) nameById.set(c.id, c.name);
  }

  return rows.map((r) => ({
    clientId: r.client_id,
    clientName: nameById.get(r.client_id) ?? "(名称不明)",
    targetMonth: r.target_month,
    notes: r.notes,
    tsukiokure: r.tsukiokure,
    henrei: r.henrei,
    kago: r.kago,
  }));
}
