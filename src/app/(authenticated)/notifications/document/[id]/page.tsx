"use client";

import { useEffect, useMemo, useRef, useState, use } from "react";
import Link from "next/link";
import { ArrowLeft, Download, Loader2, Printer } from "lucide-react";
import { format, parseISO } from "date-fns";
import { ja } from "date-fns/locale";
import { toast } from "sonner";
import {
  getSharedDocument,
  markSharedDocumentRead,
  type SharedDocumentRow,
} from "@/lib/notifications";
import { useBusinessType } from "@/lib/business-type-context";
import { createClient } from "@/lib/supabase/client";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return format(parseISO(iso), "yyyy/MM/dd HH:mm", { locale: ja });
  } catch {
    return iso;
  }
}

// ─── 第7表 取り込み用の型・差分判定 ──────────────────────────────────────────
//
// payload.records は送信側 (visit-records / order-app 月次実績) で生成される
// 「月次サービス実績」の record。送信元によって field 構成は若干異なるが、
// 取り込み側 (居宅介護支援) では key で重複判定し、value は丸ごと content.records
// に格納するだけなので、最小契約の `date` のみ必須として扱う。
//
// diff key:
//   1. start_time があれば `(date, start_time)` (visit-records 由来 = 訪問介護)
//   2. それ以外は `(date, service_content)` (汎用 fallback)

type ServiceUsageRecord = Record<string, unknown> & {
  date: string;
};

function recordKey(r: ServiceUsageRecord): string {
  const date = String(r.date ?? "");
  const startTime = typeof r.start_time === "string" ? r.start_time : "";
  if (startTime) return `${date}__${startTime}`;
  const content = typeof r.service_content === "string" ? r.service_content : "";
  return `${date}__${content}`;
}

// 2 つの record が「同一」かを判定 (key 一致 + 全 field 完全一致)。
function recordEquals(a: ServiceUsageRecord, b: ServiceUsageRecord): boolean {
  // key を含む全 field を JSON 比較 (順序非依存)
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  if (keysA.join("|") !== keysB.join("|")) return false;
  for (const k of keysA) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
  }
  return true;
}

// 差分計算結果
interface DiffResult {
  // 受信のみ (新規追加候補) — default: 取り込む
  added: ServiceUsageRecord[];
  // 既存・受信 両方にあるが内容違い (更新候補) — default: 既存維持
  updated: { existing: ServiceUsageRecord; incoming: ServiceUsageRecord }[];
  // 既存・受信 両方にあり内容も同一 — 表示のみ (操作不要)
  unchanged: ServiceUsageRecord[];
  // 既存のみ (受信に無い) — 削除されない (merge mode では保持)
  existingOnly: ServiceUsageRecord[];
}

function computeDiff(
  existing: ServiceUsageRecord[],
  incoming: ServiceUsageRecord[],
): DiffResult {
  const existingByKey = new Map(existing.map((r) => [recordKey(r), r]));
  const incomingByKey = new Map(incoming.map((r) => [recordKey(r), r]));

  const added: ServiceUsageRecord[] = [];
  const updated: { existing: ServiceUsageRecord; incoming: ServiceUsageRecord }[] = [];
  const unchanged: ServiceUsageRecord[] = [];
  for (const inc of incoming) {
    const key = recordKey(inc);
    const ex = existingByKey.get(key);
    if (!ex) {
      added.push(inc);
    } else if (recordEquals(ex, inc)) {
      unchanged.push(inc);
    } else {
      updated.push({ existing: ex, incoming: inc });
    }
  }
  const existingOnly: ServiceUsageRecord[] = existing.filter(
    (r) => !incomingByKey.has(recordKey(r)),
  );
  return { added, updated, unchanged, existingOnly };
}

// ─── 第7表 (service-usage-detail) doc 取得・upsert helper ─────────────────────

interface TargetDoc {
  id: string | null;
  content: Record<string, unknown>;
}

async function fetchTargetDoc(
  supabase: ReturnType<typeof createClient>,
  clientId: string,
  yearMonth: string,
): Promise<TargetDoc> {
  const { data, error } = await supabase
    .from("kaigo_report_documents")
    .select("id, content")
    .eq("user_id", clientId)
    .eq("report_type", "service-usage-detail")
    .eq("report_month", yearMonth)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return { id: null, content: {} };
  return {
    id: data.id as string,
    content: (data.content ?? {}) as Record<string, unknown>,
  };
}

async function persistRecords(
  supabase: ReturnType<typeof createClient>,
  target: TargetDoc,
  clientId: string,
  yearMonth: string,
  clientName: string,
  records: ServiceUsageRecord[],
): Promise<void> {
  if (target.id) {
    const nextContent = { ...target.content, records };
    const { error } = await supabase
      .from("kaigo_report_documents")
      .update({ content: nextContent })
      .eq("id", target.id);
    if (error) throw new Error(error.message);
    return;
  }
  // 新規 INSERT (最小 content)
  const newContent: Record<string, unknown> = {
    user_name: clientName,
    year_month: yearMonth,
    records,
  };
  const title = `サービス利用票別表（${yearMonth}）`;
  const { error } = await supabase.from("kaigo_report_documents").insert({
    user_id: clientId,
    report_type: "service-usage-detail",
    title,
    report_month: yearMonth,
    content: newContent,
    status: "draft",
  });
  if (error) throw new Error(error.message);
}

// ─── 取り込み確認モーダル ─────────────────────────────────────────────────────

interface ImportConfirmModalProps {
  shared: SharedDocumentRow;
  onClose: () => void;
  onSuccess: (msg: string) => void;
  onError: (msg: string) => void;
}

// 1 record を 1 行で要約表示 (主要 field のみ)
function recordPreview(r: ServiceUsageRecord): string {
  const date = String(r.date ?? "");
  const start = typeof r.start_time === "string" ? r.start_time : "";
  const end = typeof r.end_time === "string" ? r.end_time : "";
  const time = start ? (end ? `${start}-${end}` : start) : "";
  const cat =
    typeof r.service_category === "string"
      ? r.service_category
      : typeof r.service_type === "string"
        ? (r.service_type as string)
        : "";
  const content =
    typeof r.service_content === "string"
      ? r.service_content
      : typeof r.equipment_name === "string"
        ? (r.equipment_name as string)
        : "";
  const provider =
    typeof r.provider_name === "string" ? (r.provider_name as string) : "";
  return [date, time, cat, content, provider].filter(Boolean).join(" / ");
}

function ImportConfirmModal({
  shared,
  onClose,
  onSuccess,
  onError,
}: ImportConfirmModalProps) {
  const supabase = useMemo(() => createClient(), []);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [target, setTarget] = useState<TargetDoc | null>(null);
  const [diff, setDiff] = useState<DiffResult | null>(null);

  // user 選択 state
  // - addedChecked: index → boolean (default true)
  // - updateChoice: index → "keep" (既存維持) | "overwrite" (受信で上書き) (default "keep")
  const [addedChecked, setAddedChecked] = useState<boolean[]>([]);
  const [updateChoice, setUpdateChoice] = useState<("keep" | "overwrite")[]>([]);

  // payload からの抽出 (一度だけ)
  const extracted = useMemo(() => {
    const payload = (shared.payload ?? {}) as Record<string, unknown>;
    const clientId =
      typeof payload.client_id === "string" ? payload.client_id : shared.client_id;
    const clientName =
      typeof payload.client_name === "string" ? (payload.client_name as string) : "";
    const yearMonth =
      typeof payload.year_month === "string" ? (payload.year_month as string) : null;
    const incoming = Array.isArray(payload.records)
      ? (payload.records as unknown[]).filter(
          (r): r is ServiceUsageRecord =>
            !!r &&
            typeof r === "object" &&
            typeof (r as { date?: unknown }).date === "string",
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
        const { clientId, yearMonth, incoming } = extracted;
        if (!clientId) throw new Error("client_id が payload に含まれていません");
        if (!yearMonth) throw new Error("year_month が payload に含まれていません");

        const t = await fetchTargetDoc(supabase, clientId, yearMonth);
        const existingRecords: ServiceUsageRecord[] = Array.isArray(t.content.records)
          ? (t.content.records as ServiceUsageRecord[]).filter(
              (r) => !!r && typeof r === "object" && typeof r.date === "string",
            )
          : [];
        const d = computeDiff(existingRecords, incoming);
        if (cancelled) return;
        setTarget(t);
        setDiff(d);
        setAddedChecked(d.added.map(() => true));
        setUpdateChoice(d.updated.map(() => "keep"));
      } catch (e) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : String(e);
          setErrorMsg(msg);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, extracted]);

  const totalChanges = useMemo(() => {
    if (!diff) return 0;
    const add = addedChecked.filter(Boolean).length;
    const upd = updateChoice.filter((c) => c === "overwrite").length;
    return add + upd;
  }, [diff, addedChecked, updateChoice]);

  // user の選択を反映した records を構築 (merge mode)
  const buildMergedRecords = (): ServiceUsageRecord[] => {
    if (!diff) return [];
    const result: ServiceUsageRecord[] = [];

    // 1. existingOnly はそのまま保持
    for (const r of diff.existingOnly) result.push(r);
    // 2. unchanged はそのまま (= 既存も受信も同じ)
    for (const r of diff.unchanged) result.push(r);
    // 3. updated は user 選択に従う
    diff.updated.forEach((u, i) => {
      const choice = updateChoice[i] ?? "keep";
      result.push(choice === "overwrite" ? u.incoming : u.existing);
    });
    // 4. added は checkbox ON のみ追加
    diff.added.forEach((r, i) => {
      if (addedChecked[i]) result.push(r);
    });

    // sort (date, start_time)
    result.sort((a, b) => {
      const ad = String(a.date ?? "");
      const bd = String(b.date ?? "");
      if (ad !== bd) return ad < bd ? -1 : 1;
      const at = typeof a.start_time === "string" ? a.start_time : "";
      const bt = typeof b.start_time === "string" ? b.start_time : "";
      if (at === bt) return 0;
      return at < bt ? -1 : 1;
    });
    return result;
  };

  const handleConfirmMerge = async () => {
    if (!target || !diff) return;
    if (totalChanges === 0) {
      onError("追加・更新する項目がありません (すべて変更なし)");
      return;
    }
    setSubmitting(true);
    try {
      const { clientId, yearMonth, clientName } = extracted;
      const merged = buildMergedRecords();
      await persistRecords(
        supabase,
        target,
        clientId!,
        yearMonth!,
        clientName,
        merged,
      );
      const addCount = addedChecked.filter(Boolean).length;
      const updCount = updateChoice.filter((c) => c === "overwrite").length;
      onSuccess(
        `第7表に取り込みました (追加 ${addCount} 件 / 上書き ${updCount} 件 / 保持 ${diff.existingOnly.length + diff.unchanged.length + (diff.updated.length - updCount)} 件)`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      onError(`取り込みに失敗: ${msg}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleOverwriteAll = async () => {
    if (!target || !diff) return;
    if (
      !window.confirm(
        "既存の記録を全て破棄し、受信した記録で完全に置き換えます。よろしいですか？",
      )
    ) {
      return;
    }
    setSubmitting(true);
    try {
      const { clientId, yearMonth, clientName, incoming } = extracted;
      await persistRecords(
        supabase,
        target,
        clientId!,
        yearMonth!,
        clientName,
        incoming,
      );
      onSuccess(
        `第7表を受信内容で上書きしました (${incoming.length} 件 / 既存 ${diff.existingOnly.length + diff.unchanged.length + diff.updated.length} 件を破棄)`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      onError(`上書きに失敗: ${msg}`);
    } finally {
      setSubmitting(false);
    }
  };

  const toggleAdded = (i: number) =>
    setAddedChecked((prev) => prev.map((v, idx) => (idx === i ? !v : v)));
  const setAllAdded = (v: boolean) =>
    setAddedChecked((prev) => prev.map(() => v));
  const setUpdate = (i: number, c: "keep" | "overwrite") =>
    setUpdateChoice((prev) => prev.map((p, idx) => (idx === i ? c : p)));
  const setAllUpdate = (c: "keep" | "overwrite") =>
    setUpdateChoice((prev) => prev.map(() => c));

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-gray-100 flex items-start justify-between">
          <div>
            <h3 className="font-semibold text-gray-800">
              第7表 (サービス利用票別表) への取り込み確認
            </h3>
            <p className="text-xs text-gray-500 mt-1">
              {extracted.clientName || "—"} 様 / {extracted.yearMonth ?? "—"} /
              受信 {extracted.incoming.length} 件
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
              差分を計算中...
            </div>
          ) : errorMsg ? (
            <div className="rounded border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-600">
              {errorMsg}
            </div>
          ) : diff ? (
            <>
              {/* サマリー */}
              <div className="grid grid-cols-4 gap-2 rounded-md bg-blue-50 p-3 text-xs">
                <div>
                  <div className="text-gray-500">追加候補</div>
                  <div className="text-base font-bold text-blue-700">
                    {diff.added.length} 件
                  </div>
                </div>
                <div>
                  <div className="text-gray-500">更新候補</div>
                  <div className="text-base font-bold text-amber-700">
                    {diff.updated.length} 件
                  </div>
                </div>
                <div>
                  <div className="text-gray-500">変更なし</div>
                  <div className="text-base font-bold text-gray-700">
                    {diff.unchanged.length} 件
                  </div>
                </div>
                <div>
                  <div className="text-gray-500">既存のみ (保持)</div>
                  <div className="text-base font-bold text-gray-700">
                    {diff.existingOnly.length} 件
                  </div>
                </div>
              </div>

              {/* 追加候補 */}
              <section>
                <header className="flex items-center justify-between mb-2">
                  <h4 className="text-sm font-semibold text-gray-700">
                    追加候補 (受信のみ)
                    <span className="ml-2 text-xs font-normal text-gray-500">
                      ✓ がついた行のみ追加されます
                    </span>
                  </h4>
                  {diff.added.length > 0 && (
                    <div className="flex items-center gap-2 text-xs">
                      <button
                        type="button"
                        onClick={() => setAllAdded(true)}
                        className="rounded border border-gray-200 bg-white px-2 py-0.5 hover:bg-gray-50"
                      >
                        全選択
                      </button>
                      <button
                        type="button"
                        onClick={() => setAllAdded(false)}
                        className="rounded border border-gray-200 bg-white px-2 py-0.5 hover:bg-gray-50"
                      >
                        全解除
                      </button>
                    </div>
                  )}
                </header>
                {diff.added.length === 0 ? (
                  <p className="text-xs text-gray-400 py-2">追加候補はありません</p>
                ) : (
                  <ul className="space-y-1">
                    {diff.added.map((r, i) => (
                      <li
                        key={`add-${i}`}
                        className={`flex items-center gap-2 rounded border px-2 py-1.5 text-xs ${addedChecked[i] ? "border-blue-200 bg-blue-50" : "border-gray-200 bg-gray-50"}`}
                      >
                        <input
                          type="checkbox"
                          checked={addedChecked[i] ?? true}
                          onChange={() => toggleAdded(i)}
                          className="accent-blue-600"
                        />
                        <span className="flex-1 truncate text-gray-700">
                          {recordPreview(r)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* 更新候補 */}
              <section>
                <header className="flex items-center justify-between mb-2">
                  <h4 className="text-sm font-semibold text-gray-700">
                    更新候補 (両方にあるが内容違い)
                    <span className="ml-2 text-xs font-normal text-gray-500">
                      既存維持 / 受信で上書き を選択
                    </span>
                  </h4>
                  {diff.updated.length > 0 && (
                    <div className="flex items-center gap-2 text-xs">
                      <button
                        type="button"
                        onClick={() => setAllUpdate("keep")}
                        className="rounded border border-gray-200 bg-white px-2 py-0.5 hover:bg-gray-50"
                      >
                        全て既存維持
                      </button>
                      <button
                        type="button"
                        onClick={() => setAllUpdate("overwrite")}
                        className="rounded border border-amber-200 bg-amber-50 px-2 py-0.5 hover:bg-amber-100 text-amber-700"
                      >
                        全て上書き
                      </button>
                    </div>
                  )}
                </header>
                {diff.updated.length === 0 ? (
                  <p className="text-xs text-gray-400 py-2">更新候補はありません</p>
                ) : (
                  <ul className="space-y-2">
                    {diff.updated.map((u, i) => (
                      <li
                        key={`upd-${i}`}
                        className="rounded border border-amber-200 bg-amber-50/30 px-2 py-2 text-xs"
                      >
                        <div className="grid grid-cols-2 gap-2">
                          <label
                            className={`flex items-start gap-1.5 rounded border px-2 py-1.5 cursor-pointer ${updateChoice[i] === "keep" ? "border-blue-400 bg-blue-50" : "border-gray-200 bg-white"}`}
                          >
                            <input
                              type="radio"
                              name={`upd-${i}`}
                              checked={updateChoice[i] === "keep"}
                              onChange={() => setUpdate(i, "keep")}
                              className="mt-0.5 accent-blue-500"
                            />
                            <div className="flex-1 min-w-0">
                              <div className="text-[10px] font-semibold text-blue-700">
                                既存維持
                              </div>
                              <div className="truncate text-gray-700">
                                {recordPreview(u.existing)}
                              </div>
                            </div>
                          </label>
                          <label
                            className={`flex items-start gap-1.5 rounded border px-2 py-1.5 cursor-pointer ${updateChoice[i] === "overwrite" ? "border-amber-400 bg-amber-50" : "border-gray-200 bg-white"}`}
                          >
                            <input
                              type="radio"
                              name={`upd-${i}`}
                              checked={updateChoice[i] === "overwrite"}
                              onChange={() => setUpdate(i, "overwrite")}
                              className="mt-0.5 accent-amber-500"
                            />
                            <div className="flex-1 min-w-0">
                              <div className="text-[10px] font-semibold text-amber-700">
                                受信で上書き
                              </div>
                              <div className="truncate text-gray-700">
                                {recordPreview(u.incoming)}
                              </div>
                            </div>
                          </label>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* 変更なし & 既存のみ (折りたたみ表示) */}
              {(diff.unchanged.length > 0 || diff.existingOnly.length > 0) && (
                <section>
                  <details className="rounded border border-gray-200 bg-gray-50">
                    <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-gray-600">
                      変更なし {diff.unchanged.length} 件 / 既存のみ (保持){" "}
                      {diff.existingOnly.length} 件 を表示
                    </summary>
                    <div className="px-3 py-2 space-y-2">
                      {diff.unchanged.length > 0 && (
                        <div>
                          <div className="text-[11px] font-semibold text-gray-500 mb-1">
                            変更なし
                          </div>
                          <ul className="space-y-0.5">
                            {diff.unchanged.map((r, i) => (
                              <li
                                key={`uc-${i}`}
                                className="text-[11px] text-gray-600 truncate"
                              >
                                ・{recordPreview(r)}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {diff.existingOnly.length > 0 && (
                        <div>
                          <div className="text-[11px] font-semibold text-gray-500 mb-1">
                            既存のみ (保持 = 削除されません)
                          </div>
                          <ul className="space-y-0.5">
                            {diff.existingOnly.map((r, i) => (
                              <li
                                key={`eo-${i}`}
                                className="text-[11px] text-gray-600 truncate"
                              >
                                ・{recordPreview(r)}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  </details>
                </section>
              )}
            </>
          ) : null}
        </div>

        <div className="px-5 py-3 border-t border-gray-100 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleOverwriteAll}
              disabled={loading || submitting || !diff}
              className="text-xs text-amber-700 border border-amber-300 bg-amber-50 hover:bg-amber-100 disabled:opacity-50 px-3 py-2 rounded-lg"
              title="既存記録を全削除し、受信内容で完全に置き換え"
            >
              すべて上書き (既存破棄)
            </button>
          </div>
          <div className="flex items-center gap-2">
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
              onClick={handleConfirmMerge}
              disabled={loading || submitting || !diff || totalChanges === 0}
              className="text-sm text-white bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed px-4 py-2 rounded-lg flex items-center gap-1.5"
            >
              {submitting ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Download size={14} />
              )}
              取り込み確定 ({totalChanges} 件)
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function SharedDocumentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { currentOfficeId } = useBusinessType();
  const [doc, setDoc] = useState<SharedDocumentRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [showImport, setShowImport] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // 同一書類で複数回 read マークしないようにするフラグ。
  const markedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      const row = await getSharedDocument(id);
      if (cancelled) return;
      setDoc(row);
      setLoading(false);
      // 初回アクセス時のみ read 化 (まだ未読の場合)。
      if (row && !row.read_at && !markedRef.current) {
        markedRef.current = true;
        await markSharedDocumentRead(row.id);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const handlePrint = () => {
    const win = iframeRef.current?.contentWindow;
    if (win) {
      try {
        win.focus();
        win.print();
        return;
      } catch {
        // fallthrough → window.print
      }
    }
    window.print();
  };

  const backHref = currentOfficeId
    ? `/notifications?office=${encodeURIComponent(currentOfficeId)}`
    : "/notifications";

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-500">
        <Loader2 size={20} className="mr-2 animate-spin" />
        読み込み中...
      </div>
    );
  }

  if (!doc) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <Link
          href={backHref}
          className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
        >
          <ArrowLeft size={14} /> 通知一覧へ戻る
        </Link>
        <div className="rounded-md border bg-gray-50 px-4 py-6 text-center text-sm text-gray-500">
          書類が見つかりませんでした (削除済 or 権限なし)
        </div>
      </div>
    );
  }

  const canImport = doc.document_type === "service_record_monthly";

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <Link
          href={backHref}
          className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
        >
          <ArrowLeft size={14} /> 通知一覧へ戻る
        </Link>
        <div className="flex items-center gap-2">
          {canImport && (
            <button
              type="button"
              onClick={() => setShowImport(true)}
              className="inline-flex items-center gap-1 rounded-md border border-blue-600 bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
            >
              <Download size={14} />
              第7表 (利用票実績表) に取り込む
            </button>
          )}
          <button
            type="button"
            onClick={handlePrint}
            className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            <Printer size={14} />
            印刷
          </button>
        </div>
      </div>
      <div className="rounded-md border bg-white px-4 py-3">
        <h1 className="text-base font-semibold text-gray-900">{doc.title}</h1>
        <div className="mt-1 text-xs text-gray-500">
          受信日時: {formatDate(doc.sent_at)}
          {doc.read_at && (
            <span className="ml-3">既読: {formatDate(doc.read_at)}</span>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-hidden rounded-md border bg-white">
        <iframe
          ref={iframeRef}
          srcDoc={doc.html_content}
          // allow-same-origin: srcDoc 内 CSS / 内部 anchor 用
          // allow-popups / allow-popups-to-escape-sandbox: 印刷ダイアログ等の挙動を保証
          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          className="h-[70vh] w-full border-0"
          title={doc.title}
        />
      </div>

      {showImport && (
        <ImportConfirmModal
          shared={doc}
          onClose={() => setShowImport(false)}
          onSuccess={(msg) => {
            toast.success(msg);
            setShowImport(false);
          }}
          onError={(msg) => {
            toast.error(msg);
          }}
        />
      )}
    </div>
  );
}
