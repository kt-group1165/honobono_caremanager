"use client";

/**
 * 訪問介護 手順書 SP 閲覧専用ビューワ
 *
 * URL: /m/visit-procedures/[id]
 *
 * - 編集不可、印刷可
 * - サイドバー / ヘッダなしの全画面表示
 * - ステップは カード stack (PC でも同じ)
 * - 週次表 / モジュール グリッドはアコーディオン折りたたみ
 */

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { BookOpen, Loader2, Printer, ChevronDown, ChevronRight, LogOut } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { getDocument } from "@/lib/visit-procedure/queries";
import {
  WEEKDAY_KEYS,
  WEEKDAY_LABELS,
  SERVICE_NOS,
  parseHHMM,
  formatHHMM,
  sumServiceMinutes,
  type VisitProcedureDocument,
} from "@/lib/visit-procedure/types";

function formatJpDate(s: string | null | undefined): string {
  if (!s) return "（未設定）";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s;
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;
}

export default function MobileVisitProcedureView() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id ?? "";
  const supabase = useMemo(() => createClient(), []);
  const [doc, setDoc] = useState<VisitProcedureDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [showWeekly, setShowWeekly] = useState(true);
  const [showModule, setShowModule] = useState(false);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- mount-time async fetch (HANDOVER §2) */
    if (!id) { setLoading(false); return; }
    let cancelled = false;
    const load = async () => {
      try {
        const found = await getDocument(supabase, id);
        if (!cancelled) {
          if (!found) {
            toast.error("手順書が見つかりません");
            router.push("/login");
            return;
          }
          const filled = SERVICE_NOS.map((no) => {
            const ex = found.services.find((s) => s.service_no === no);
            return ex ?? { service_no: no, service_kind: "" as const, special_notes: "", steps: [] };
          });
          setDoc({ ...found, services: filled });
        }
      } catch (err) {
        console.error(err);
        toast.error("読込失敗: " + (err instanceof Error ? err.message : String(err)));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [supabase, id, router]);

  if (loading || !doc) {
    return (
      <div className="flex items-center justify-center min-h-[50vh] text-gray-400">
        <Loader2 size={20} className="animate-spin mr-2" />
        読込中...
      </div>
    );
  }

  const period = `${formatJpDate(doc.plan_start_date)}〜${formatJpDate(doc.plan_end_date)}`;
  const SERVICE_COLORS = ["bg-blue-100", "bg-emerald-100", "bg-amber-100", "bg-rose-100", "bg-violet-100"];

  const visibleServices = doc.services.filter((s) => s.service_kind || s.steps.length > 0 || s.special_notes);

  // モジュール grid 用
  const COLS = Array.from({ length: 18 }, (_, i) => (i + 1) * 5);
  const cellW = 24;

  return (
    <div className="space-y-3 max-w-2xl mx-auto pb-12">
      {/* 印刷専用 style */}
      <style>{`
        @media print {
          @page { size: A4 portrait; margin: 12mm; }
          .mv-print-hide { display: none !important; }
          body, html { background: #fff !important; }
          .mv-print-root, .mv-print-root * { color: #000 !important; box-shadow: none !important; }
          .mv-print-root section, .mv-print-root table { page-break-inside: avoid; }
        }
      `}</style>

      {/* sticky ヘッダー */}
      <div className="sticky top-0 z-10 bg-white/95 backdrop-blur border-b border-gray-200 -mx-3 sm:-mx-6 px-3 sm:px-6 py-2 flex items-center gap-2 mv-print-hide">
        <BookOpen size={18} className="text-green-600 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-gray-900 truncate">{doc.client_name}</div>
          <div className="text-[10px] text-gray-500 truncate">{period}</div>
        </div>
        <button
          onClick={() => window.print()}
          className="shrink-0 inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
          aria-label="印刷"
        >
          <Printer size={14} />
          印刷
        </button>
        <button
          onClick={async () => { await supabase.auth.signOut(); router.push("/login"); }}
          className="shrink-0 inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
          aria-label="ログアウト"
        >
          <LogOut size={14} />
        </button>
      </div>

      <div className="mv-print-root space-y-3">
        {/* 基本情報 (簡潔) */}
        <section className="rounded-lg border border-gray-200 bg-white p-3 text-xs space-y-1">
          <div><span className="text-gray-500">利用者:</span> <span className="font-medium text-gray-900">{doc.client_name}</span></div>
          <div><span className="text-gray-500">計画期間:</span> <span className="font-medium text-gray-900">{period}</span></div>
          {doc.author_name && <div><span className="text-gray-500">作成者:</span> <span className="text-gray-900">{doc.author_name}</span></div>}
          {doc.creation_reason && <div><span className="text-gray-500">作成理由:</span> <span className="text-gray-900">{doc.creation_reason}</span></div>}
          {doc.special_notes && <div className="pt-1 border-t border-gray-100"><span className="text-gray-500">特記:</span> <span className="text-gray-900 whitespace-pre-wrap break-words">{doc.special_notes}</span></div>}
        </section>

        {/* 週次表 (アコーディオン) */}
        <section className="rounded-lg border border-gray-200 bg-white overflow-hidden">
          <button
            onClick={() => setShowWeekly((v) => !v)}
            className="w-full flex items-center justify-between px-3 py-2 text-sm font-semibold text-gray-700 bg-gray-50 hover:bg-gray-100 mv-print-hide"
          >
            <span>週次サービス表</span>
            {showWeekly ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
          {(showWeekly) && (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px] border-collapse table-fixed">
                <colgroup>
                  <col className="w-10" />
                  {SERVICE_NOS.map((no) => <col key={no} />)}
                </colgroup>
                <thead>
                  <tr className="bg-gray-50 text-gray-600">
                    <th className="px-1 py-1 border border-gray-200 text-center">曜日</th>
                    {SERVICE_NOS.map((no) => (
                      <th key={no} className="px-1 py-1 border border-gray-200 text-center">サ{no}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {WEEKDAY_KEYS.flatMap((day) => {
                    const rows = doc.weekly_schedule[day] ?? [{}];
                    const effective = rows.length === 0 ? [{}] : rows;
                    return effective.map((row, rowIdx) => (
                      <tr key={`${day}-${rowIdx}`} className="border-t border-gray-200">
                        {rowIdx === 0 && (
                          <td
                            rowSpan={effective.length}
                            className="px-1 py-1 border border-gray-200 text-center font-medium bg-gray-50"
                          >
                            {WEEKDAY_LABELS[day]}
                          </td>
                        )}
                        {SERVICE_NOS.map((no) => {
                          const cell = row?.[String(no)];
                          const start = cell?.start;
                          if (!start) {
                            return (
                              <td key={no} className="px-1 py-1 border border-gray-200 align-middle">
                                <span className="block text-gray-300 text-center">&nbsp;</span>
                              </td>
                            );
                          }
                          const svc = doc.services.find((s) => s.service_no === no);
                          const startMin = parseHHMM(start);
                          const total = sumServiceMinutes(svc);
                          const endLabel = startMin !== null && total > 0 ? formatHHMM(startMin + total) : "";
                          return (
                            <td key={no} className="px-1 py-1 border border-gray-200 align-middle">
                              <div className="flex items-baseline justify-center gap-2">
                                <span className="text-gray-800 tabular-nums whitespace-nowrap">
                                  {start}{endLabel ? `-${endLabel}` : ""}
                                </span>
                                <span className="text-gray-500 text-left" style={{ minWidth: "4.5rem" }}>
                                  {svc?.service_kind || ""}
                                </span>
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    ));
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* サービス毎 ステップ (カード stack) */}
        {visibleServices.map((svc, svcIdx) => (
          <section key={svc.service_no} className="rounded-lg border border-gray-200 bg-white overflow-hidden">
            <div className={`px-3 py-2 text-sm font-semibold text-gray-800 ${SERVICE_COLORS[svcIdx % SERVICE_COLORS.length]} border-b border-gray-200`}>
              <div>サービス{svc.service_no}</div>
              <div className="text-xs font-normal text-gray-700">
                {svc.service_kind || "—"}
                {sumServiceMinutes(svc) > 0 ? ` (合計 ${sumServiceMinutes(svc)} 分)` : ""}
              </div>
            </div>
            <div className="p-3 space-y-2">
              {svc.steps.length === 0 ? (
                <p className="text-xs text-gray-400 italic text-center py-2">ステップ未登録</p>
              ) : (
                svc.steps.map((step, idx) => (
                  <div key={idx} className="rounded border border-gray-200 p-2 bg-gray-50">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-medium text-gray-900 break-words flex-1 min-w-0">{step.content || "—"}</span>
                      <span className="shrink-0 text-xs text-gray-500 tabular-nums whitespace-nowrap">{step.minutes}分</span>
                    </div>
                    {step.detail && (
                      <p className="mt-1 text-xs text-gray-700 whitespace-pre-wrap break-words">{step.detail}</p>
                    )}
                  </div>
                ))
              )}
              {svc.special_notes && (
                <div className="text-xs pt-1 border-t border-gray-100">
                  <span className="text-gray-500">特記事項: </span>
                  <span className="text-gray-700 whitespace-pre-wrap break-words">{svc.special_notes}</span>
                </div>
              )}
            </div>
          </section>
        ))}

        {/* モジュール (アコーディオン、折りたたみ default) */}
        <section className="rounded-lg border border-gray-200 bg-white overflow-hidden">
          <button
            onClick={() => setShowModule((v) => !v)}
            className="w-full flex items-center justify-between px-3 py-2 text-sm font-semibold text-gray-700 bg-gray-50 hover:bg-gray-100 mv-print-hide"
          >
            <span>モジュール (5 分刻みタイムライン)</span>
            {showModule ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
          {showModule && (
            <div className="p-2 space-y-3 overflow-x-auto">
              {visibleServices.map((svc, svcIdx) => {
                let cursor = 0;
                const bands = svc.steps.map((st) => {
                  const start = cursor;
                  const len = Math.max(0, Math.floor(st.minutes));
                  cursor += len;
                  return { ...st, start, len };
                });
                const total = cursor;
                return (
                  <div key={svc.service_no} className="rounded border border-gray-200 p-2">
                    <div className="text-xs font-medium text-gray-700 mb-1">
                      サービス{svc.service_no} ({svc.service_kind || "—"}) — 合計 {total} 分
                    </div>
                    <div style={{ width: `${cellW * COLS.length + 80}px` }}>
                      <div className="flex border-b border-gray-200 text-[9px] text-gray-500 mb-1">
                        <div className="w-[80px] shrink-0 px-1">内容</div>
                        {COLS.map((m) => (<div key={m} className="text-center" style={{ width: `${cellW}px` }}>{m}</div>))}
                      </div>
                      {bands.length === 0 ? (
                        <div className="text-center text-xs text-gray-400 italic py-2">ステップ未登録</div>
                      ) : (
                        bands.map((b, i) => {
                          const left = Math.floor(b.start / 5) * cellW;
                          const w = Math.max(1, Math.floor(b.len / 5)) * cellW;
                          return (
                            <div key={i} className="flex items-stretch border-t border-gray-100 relative" style={{ minHeight: 22 }}>
                              <div className="w-[80px] shrink-0 px-1 py-0.5 text-[10px] truncate" title={b.content}>{b.content || `ステップ${i + 1}`}</div>
                              <div className="relative" style={{ width: `${cellW * COLS.length}px` }}>
                                {COLS.map((m) => (
                                  <div key={m} className="absolute top-0 bottom-0 border-r border-gray-100"
                                    style={{ left: `${(m / 5 - 1) * cellW}px`, width: `${cellW}px` }} />
                                ))}
                                <div className={`absolute top-0.5 bottom-0.5 rounded ${SERVICE_COLORS[svcIdx % SERVICE_COLORS.length]} flex items-center justify-center text-[9px] text-gray-700 px-0.5`}
                                  style={{ left: `${left}px`, width: `${w}px` }}>
                                  {b.len > 0 ? `${b.len}` : ""}
                                </div>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
