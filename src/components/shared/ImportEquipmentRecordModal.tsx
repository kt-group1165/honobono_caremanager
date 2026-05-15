"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Download } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import type { SharedDocumentRow } from "@/lib/notifications";
import { fetchTargetDoc, type TargetDoc } from "./ImportServiceRecordModal";

// ─── 型 ───────────────────────────────────────────────────────────────────────

/**
 * order-app が送信する福祉用具レンタル実績の 1 行。
 * 1 用具 = 1 レコード (期間表現)。1 月内に開始/終了が closed なら同月内、月跨ぎなら
 * date_range_start/end が当月にクリップされて送られてくる。
 */
export type EquipmentRecord = {
  date_range_start: string; // YYYY-MM-DD
  date_range_end: string;   // YYYY-MM-DD
  equipment_name: string;
  tais_code?: string | null;
  monthly_rental_fee: number;
  category?: string | null;
};

/** kaigo_report_documents.content.services[] の 1 行 (= 福祉用具行) */
type RentalSvcRow = {
  time: string;
  content: string;
  provider: string;
  planned: boolean[];
  actual: boolean[];
  category: string;          // "17" = 福祉用具貸与
  units?: number;
  manual_units?: number | null;
  rental_period_type?: "1month" | "half_month" | "daily" | null;
  rental_days?: number | null;
};

type AnySvcRow = {
  time?: string;
  content?: string;
  provider?: string;
  planned?: boolean[];
  actual?: boolean[];
  category?: string;
  units?: number;
  manual_units?: number | null;
  rental_period_type?: "1month" | "half_month" | "daily" | null;
  rental_days?: number | null;
};

// ─── helpers ─────────────────────────────────────────────────────────────────

function daysInMonth(yearMonth: string): number {
  const m = /^(\d{4})-(\d{1,2})$/.exec(yearMonth);
  if (!m) return 30;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || mo < 1 || mo > 12) return 30;
  return new Date(y, mo, 0).getDate();
}

/** 日付 (YYYY-MM-DD) → 月内の日 (1-31)。月外なら null。 */
function dayOfMonth(date: string, yearMonth: string): number | null {
  if (!date.startsWith(yearMonth + "-")) return null;
  const d = parseInt(date.slice(8, 10), 10);
  if (!Number.isFinite(d) || d < 1 || d > 31) return null;
  return d;
}

/**
 * 福祉用具レンタル期間 [start, end] から 利用票標準の planned/actual マークを生成。
 * 利用票慣習:
 *   - 月初〜末日 (= 当月通し) → 1日 のみマーク (= 1月扱い)
 *   - 月初〜途中終了 → 1日 + 終了日 をマーク (= boundary 触れ + 同月内終了)
 *   - 途中開始〜末日 → 開始日 のみマーク (= boundary 触れ、月末まで継続)
 *   - 途中〜途中 (同月内) → 開始日 + 終了日 をマーク (= 同月内開始+終了、半月扱い)
 */
function buildMarksFromRange(
  start: string,
  end: string,
  yearMonth: string,
): boolean[] {
  const dim = daysInMonth(yearMonth);
  const marks = Array<boolean>(31).fill(false);
  const startDay = dayOfMonth(start, yearMonth);
  const endDay = dayOfMonth(end, yearMonth);
  // 月跨ぎ等で start が月外 → 1日扱い、end が月外 → 末日扱い
  const sDay = startDay ?? 1;
  const eDay = endDay ?? dim;
  // 全月通し
  if (sDay === 1 && eDay === dim) {
    marks[0] = true;
    return marks;
  }
  // 開始日マーク
  marks[sDay - 1] = true;
  // 終了日マーク (start と異なり、かつ月末でない場合のみ明示)
  if (eDay !== sDay && eDay !== dim) {
    marks[eDay - 1] = true;
  }
  return marks;
}

function buildRentalSvcRow(
  r: EquipmentRecord,
  yearMonth: string,
  sourceOfficeName: string,
): RentalSvcRow {
  const marks = buildMarksFromRange(r.date_range_start, r.date_range_end, yearMonth);
  return {
    time: "",
    content: r.equipment_name,
    provider: sourceOfficeName,
    planned: [...marks],
    actual: [...marks],
    category: "17",
    manual_units: r.monthly_rental_fee,
  };
}

function isRentalRow(s: AnySvcRow): s is RentalSvcRow {
  return String(s.category ?? "") === "17";
}

// ─── persist ─────────────────────────────────────────────────────────────────

async function persistEquipmentRecords(
  supabase: ReturnType<typeof createClient>,
  target: TargetDoc,
  clientId: string,
  yearMonth: string,
  clientName: string,
  newRentalRows: RentalSvcRow[],
  importedSharedDocId: string,
): Promise<void> {
  // 既存 services を取得
  const existing: AnySvcRow[] = Array.isArray(target.content.services)
    ? (target.content.services as AnySvcRow[])
    : [];

  // 非 rental 行はそのまま維持、rental 行 (category=17) は equipment_name で match
  const nonRental = existing.filter((s) => !isRentalRow(s));
  const existingRental = existing.filter((s) => isRentalRow(s));
  const byName = new Map<string, RentalSvcRow>();
  for (const r of existingRental) byName.set(r.content ?? "", r as RentalSvcRow);
  for (const r of newRentalRows) byName.set(r.content, r); // 同名上書き

  const mergedServices: AnySvcRow[] = [...nonRental, ...byName.values()];

  // imported_shared_document_ids 維持
  const prevImportedIds = Array.isArray(target.content.imported_shared_document_ids)
    ? (target.content.imported_shared_document_ids as unknown[]).filter(
        (v): v is string => typeof v === "string",
      )
    : [];
  const importedIds = Array.from(new Set([...prevImportedIds, importedSharedDocId]));

  if (target.id) {
    const nextContent = {
      ...target.content,
      services: mergedServices,
      imported_shared_document_ids: importedIds,
    };
    const { error } = await supabase
      .from("kaigo_report_documents")
      .update({ content: nextContent })
      .eq("id", target.id);
    if (error) throw new Error(error.message);
    return;
  }
  const newContent: Record<string, unknown> = {
    user_name: clientName,
    year_month: yearMonth,
    services: mergedServices,
    imported_shared_document_ids: importedIds,
  };
  const title = `サービス利用票・提供票（${yearMonth}）`;
  const { error } = await supabase.from("kaigo_report_documents").insert({
    user_id: clientId,
    report_type: "service-usage",
    title,
    report_month: yearMonth,
    content: newContent,
    status: "draft",
  });
  if (error) throw new Error(error.message);
}

// ─── modal ───────────────────────────────────────────────────────────────────

export interface ImportEquipmentRecordModalProps {
  shared: SharedDocumentRow;
  onClose: () => void;
  onSuccess: (msg: string) => void;
  onError: (msg: string) => void;
}

export function ImportEquipmentRecordModal({
  shared,
  onClose,
  onSuccess,
  onError,
}: ImportEquipmentRecordModalProps) {
  const supabase = useMemo(() => createClient(), []);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [target, setTarget] = useState<TargetDoc | null>(null);
  const [sourceOfficeName, setSourceOfficeName] = useState<string>("");

  const extracted = useMemo(() => {
    const payload = (shared.payload ?? {}) as Record<string, unknown>;
    const clientId =
      typeof payload.client_id === "string" ? payload.client_id : shared.client_id;
    const clientName =
      typeof payload.client_name === "string" ? payload.client_name : "";
    const yearMonth =
      typeof payload.year_month === "string" ? payload.year_month : null;
    const incoming: EquipmentRecord[] = Array.isArray(payload.records)
      ? (payload.records as unknown[]).filter(
          (r): r is EquipmentRecord =>
            !!r &&
            typeof r === "object" &&
            typeof (r as { date_range_start?: unknown }).date_range_start === "string" &&
            typeof (r as { date_range_end?: unknown }).date_range_end === "string" &&
            typeof (r as { equipment_name?: unknown }).equipment_name === "string",
        )
      : [];
    return { clientId, clientName, yearMonth, incoming };
  }, [shared]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErrorMsg(null);
      try {
        const { clientId, yearMonth } = extracted;
        if (!clientId) throw new Error("client_id が payload に含まれていません");
        if (!yearMonth) throw new Error("year_month が payload に含まれていません");
        const [t, srcOfc] = await Promise.all([
          fetchTargetDoc(supabase, clientId, yearMonth),
          supabase
            .from("offices")
            .select("name")
            .eq("id", shared.source_office_id)
            .maybeSingle(),
        ]);
        if (cancelled) return;
        setTarget(t);
        setSourceOfficeName(
          (srcOfc.data as { name?: string } | null)?.name ?? "(送信元事業所)",
        );
      } catch (e) {
        if (!cancelled) setErrorMsg(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, extracted, shared.source_office_id]);

  // 既存 rental 行と incoming を name で diff
  const diff = useMemo(() => {
    if (!target) return null;
    const existing: AnySvcRow[] = Array.isArray(target.content.services)
      ? (target.content.services as AnySvcRow[]).filter((s) => isRentalRow(s))
      : [];
    const existingNames = new Set(existing.map((s) => s.content ?? ""));
    const incomingNames = new Set(extracted.incoming.map((r) => r.equipment_name));
    const added = extracted.incoming.filter((r) => !existingNames.has(r.equipment_name));
    const replaced = extracted.incoming.filter((r) => existingNames.has(r.equipment_name));
    const keepOnly = existing.filter((s) => !incomingNames.has(s.content ?? ""));
    return { added, replaced, keepOnly };
  }, [target, extracted.incoming]);

  const handleImport = async () => {
    if (!target || !diff) return;
    if (!extracted.yearMonth || !extracted.clientId) return;
    setSubmitting(true);
    try {
      const newRows = extracted.incoming.map((r) =>
        buildRentalSvcRow(r, extracted.yearMonth!, sourceOfficeName),
      );
      await persistEquipmentRecords(
        supabase,
        target,
        extracted.clientId,
        extracted.yearMonth,
        extracted.clientName,
        newRows,
        shared.id,
      );
      onSuccess(
        `利用票の福祉用具行を更新しました (追加 ${diff.added.length} 件 / 上書き ${diff.replaced.length} 件)`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      onError(`取り込みに失敗: ${msg}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-gray-100 flex items-start justify-between">
          <div>
            <h3 className="font-semibold text-gray-800">
              利用票・提供票 への取り込み確認 (福祉用具実績)
            </h3>
            <p className="text-xs text-gray-500 mt-1">
              {extracted.clientName || "—"} 様 / {extracted.yearMonth ?? "—"} / 受信{" "}
              {extracted.incoming.length} 件 / 送信元: {sourceOfficeName || "—"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="text-gray-400 hover:text-gray-600 disabled:opacity-50"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {loading ? (
            <div className="flex justify-center py-10 text-gray-500">
              <Loader2 size={20} className="animate-spin mr-2" />
              読み込み中...
            </div>
          ) : errorMsg ? (
            <div className="rounded border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-600">
              {errorMsg}
            </div>
          ) : diff ? (
            <>
              <div className="grid grid-cols-3 gap-2 rounded-md bg-blue-50 p-3 text-xs">
                <div>
                  <div className="text-gray-500">新規追加</div>
                  <div className="text-base font-bold text-blue-700">{diff.added.length} 件</div>
                </div>
                <div>
                  <div className="text-gray-500">同名上書き</div>
                  <div className="text-base font-bold text-amber-700">{diff.replaced.length} 件</div>
                </div>
                <div>
                  <div className="text-gray-500">既存のみ (維持)</div>
                  <div className="text-base font-bold text-gray-700">{diff.keepOnly.length} 件</div>
                </div>
              </div>

              {diff.added.length > 0 && (
                <section>
                  <h4 className="text-sm font-semibold text-gray-700 mb-1">新規追加</h4>
                  <ul className="space-y-1">
                    {diff.added.map((r, i) => (
                      <li
                        key={`add-${i}`}
                        className="rounded border border-blue-200 bg-blue-50 px-2 py-1.5 text-xs"
                      >
                        <div className="font-medium text-gray-800 truncate">{r.equipment_name}</div>
                        <div className="text-[11px] text-gray-500">
                          {r.date_range_start} 〜 {r.date_range_end} / ¥
                          {r.monthly_rental_fee.toLocaleString()}
                          {r.category ? ` / ${r.category}` : ""}
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {diff.replaced.length > 0 && (
                <section>
                  <h4 className="text-sm font-semibold text-gray-700 mb-1">同名上書き</h4>
                  <ul className="space-y-1">
                    {diff.replaced.map((r, i) => (
                      <li
                        key={`rep-${i}`}
                        className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs"
                      >
                        <div className="font-medium text-gray-800 truncate">{r.equipment_name}</div>
                        <div className="text-[11px] text-gray-500">
                          {r.date_range_start} 〜 {r.date_range_end} / ¥
                          {r.monthly_rental_fee.toLocaleString()}
                          {r.category ? ` / ${r.category}` : ""}
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {diff.keepOnly.length > 0 && (
                <section>
                  <details className="rounded border border-gray-200 bg-gray-50">
                    <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-gray-600">
                      既存のみ (= 削除されません) {diff.keepOnly.length} 件
                    </summary>
                    <ul className="px-3 py-2 space-y-0.5">
                      {diff.keepOnly.map((s, i) => (
                        <li key={`keep-${i}`} className="text-[11px] text-gray-600 truncate">
                          ・{s.content}
                        </li>
                      ))}
                    </ul>
                  </details>
                </section>
              )}

              {extracted.incoming.length === 0 && (
                <p className="text-sm text-amber-700">
                  受信した福祉用具レコードが 0 件です。送信元で当月のレンタルが無い可能性があります。
                </p>
              )}
            </>
          ) : null}
        </div>

        <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="text-sm text-gray-600 px-4 py-2 rounded-lg hover:bg-gray-100 disabled:opacity-50"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={handleImport}
            disabled={loading || submitting || !diff || extracted.incoming.length === 0}
            className="text-sm text-white bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed px-4 py-2 rounded-lg flex items-center gap-1.5"
          >
            {submitting ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Download size={14} />
            )}
            取り込み確定 ({extracted.incoming.length} 件)
          </button>
        </div>
      </div>
    </div>
  );
}
