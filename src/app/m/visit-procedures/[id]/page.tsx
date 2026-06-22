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

  // モジュール grid 用 (= adaptive: 右端 default 120 分、step 合計が超えたら 30 分単位で拡張)
  const cellW = 24;
  // increment / cellCount は per-service で計算 (= 各サービスの step 合計 に応じて)
  const computeGrid = (totalMinutes: number) => {
    const t = Math.max(120, Math.ceil(Math.max(totalMinutes, 1) / 30) * 30);
    const increment = t <= 120 ? 5 : t <= 240 ? 10 : t <= 360 ? 15 : 30;
    const cellCount = Math.ceil(t / increment);
    return { increment, cellCount };
  };

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
          <div className="text-[11px] text-gray-500 truncate tabular-nums">{period}</div>
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
        {/* 基本情報 (簡潔)
            mobile-first: 利用者名は大きく、定義リスト風で label/value を左右に
        */}
        <section className="rounded-lg border border-gray-200 bg-white p-3 space-y-1.5">
          <div className="text-base font-bold text-gray-900 break-words leading-tight">{doc.client_name}</div>
          <div className="text-xs text-gray-600 tabular-nums">{period}</div>
          {(doc.author_name || doc.creation_reason) && (
            <div className="pt-1.5 border-t border-gray-100 text-[11px] text-gray-700 space-y-0.5">
              {doc.author_name && (
                <div className="flex gap-1.5">
                  <span className="shrink-0 text-gray-500">作成者</span>
                  <span className="break-words">{doc.author_name}</span>
                </div>
              )}
              {doc.creation_reason && (
                <div className="flex gap-1.5">
                  <span className="shrink-0 text-gray-500">理由</span>
                  <span className="break-words">{doc.creation_reason}</span>
                </div>
              )}
            </div>
          )}
          {doc.special_notes && (
            <div className="pt-1.5 border-t border-gray-100 text-[11px]">
              <span className="inline-block px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 font-medium mr-1.5">特記</span>
              <span className="text-gray-800 whitespace-pre-wrap break-words">{doc.special_notes}</span>
            </div>
          )}
        </section>

        {/* 週次表 (アコーディオン)
            mobile-first design:
              - 列ヘッダー = サ番号 + 種類 (2 行表示) でセルから種類情報を移動
              - セル = 開始時刻 (大) + 終了時刻 (小、薄) の 2 行 (= 時刻だけに集中)
              - サービス未登録列は header を薄く / 全行斜線で視覚的に区別
        */}
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
                  <col style={{ width: "8%" }} />
                  {SERVICE_NOS.map((no) => <col key={no} style={{ width: `${92 / SERVICE_NOS.length}%` }} />)}
                </colgroup>
                <thead>
                  <tr className="bg-gray-50 text-gray-600">
                    <th className="px-0.5 py-1 border border-gray-200 text-center align-middle">曜日</th>
                    {SERVICE_NOS.map((no) => {
                      const svc = doc.services.find((s) => s.service_no === no);
                      const kind = svc?.service_kind || "";
                      const total = sumServiceMinutes(svc);
                      const isEmpty = !kind && total === 0 && (!svc || svc.steps.length === 0);
                      return (
                        <th key={no} className={`px-0.5 py-1 border border-gray-200 text-center align-middle ${isEmpty ? "text-gray-300" : "text-gray-700"}`}>
                          <div className="font-semibold">サ{no}</div>
                          <div className={`text-[10px] font-normal leading-tight break-all ${isEmpty ? "text-gray-300" : "text-gray-500"}`}>
                            {kind || "—"}
                          </div>
                        </th>
                      );
                    })}
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
                            className="px-0.5 py-1 border border-gray-200 text-center font-semibold bg-gray-50 text-gray-700"
                          >
                            {WEEKDAY_LABELS[day]}
                          </td>
                        )}
                        {SERVICE_NOS.map((no) => {
                          const cell = row?.[String(no)];
                          const start = cell?.start;
                          if (!start) {
                            return (
                              <td key={no} className="px-0.5 py-1 border border-gray-200 align-middle">
                                <span className="block text-gray-200 text-center">·</span>
                              </td>
                            );
                          }
                          const svc = doc.services.find((s) => s.service_no === no);
                          const startMin = parseHHMM(start);
                          const total = sumServiceMinutes(svc);
                          const endLabel = startMin !== null && total > 0 ? formatHHMM(startMin + total) : "";
                          return (
                            <td key={no} className="px-0.5 py-1 border border-gray-200 align-middle">
                              <div className="flex flex-col items-center leading-tight">
                                <span className="text-gray-900 tabular-nums font-medium whitespace-nowrap">
                                  {start}
                                </span>
                                {endLabel && (
                                  <span className="text-gray-400 tabular-nums text-[10px] whitespace-nowrap">
                                    〜{endLabel}
                                  </span>
                                )}
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

        {/* サービス毎 ステップ (カード stack)
            mobile-first:
              - ヘッダーに サ番号 (大) + 種類 + 合計分 を 1 行で
              - 各 step は 番号 badge + 内容 + 分 (右端)、min-height 44px (= タップ領域)
              - step.detail は折りたたみ無し (= 短いものが多いので常時表示)
        */}
        {visibleServices.map((svc, svcIdx) => {
          const totalMin = sumServiceMinutes(svc);
          return (
            <section key={svc.service_no} className="rounded-lg border border-gray-200 bg-white overflow-hidden">
              <div className={`px-3 py-2 ${SERVICE_COLORS[svcIdx % SERVICE_COLORS.length]} border-b border-gray-200`}>
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-sm font-bold text-gray-900">サービス{svc.service_no}</span>
                  <span className="text-xs font-medium text-gray-800">{svc.service_kind || "—"}</span>
                  {totalMin > 0 && (
                    <span className="ml-auto text-[11px] text-gray-600 tabular-nums">合計 {totalMin} 分</span>
                  )}
                </div>
              </div>
              <div className="p-2 sm:p-3">
                {svc.steps.length === 0 ? (
                  <p className="text-xs text-gray-400 italic text-center py-3">ステップ未登録</p>
                ) : (
                  <ol className="space-y-1.5">
                    {svc.steps.map((step, idx) => (
                      <li key={idx} className="flex gap-2 rounded-md border border-gray-200 bg-gray-50 p-2 min-h-[44px]">
                        <span className="shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-full bg-white border border-gray-300 text-[10px] font-semibold text-gray-600 tabular-nums">
                          {idx + 1}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="text-sm font-medium text-gray-900 break-words flex-1 min-w-0 leading-snug">{step.content || "—"}</span>
                            <span className="shrink-0 text-[11px] text-gray-600 tabular-nums whitespace-nowrap font-medium">{step.minutes}分</span>
                          </div>
                          {step.detail && (
                            <p className="mt-1 text-xs text-gray-600 whitespace-pre-wrap break-words leading-snug">{step.detail}</p>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
                {svc.special_notes && (
                  <div className="mt-2 pt-2 border-t border-gray-100 text-xs">
                    <span className="inline-block px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 font-medium mr-1.5">特記</span>
                    <span className="text-gray-700 whitespace-pre-wrap break-words">{svc.special_notes}</span>
                  </div>
                )}
              </div>
            </section>
          );
        })}

        {/* モジュール (アコーディオン、折りたたみ default) */}
        <section className="rounded-lg border border-gray-200 bg-white overflow-hidden">
          <button
            onClick={() => setShowModule((v) => !v)}
            className="w-full flex items-center justify-between px-3 py-2 text-sm font-semibold text-gray-700 bg-gray-50 hover:bg-gray-100 mv-print-hide"
          >
            <span>モジュール (adaptive タイムライン)</span>
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
                const { increment, cellCount } = computeGrid(total);
                const COLS = Array.from({ length: cellCount }, (_, i) => (i + 1) * increment);
                // mobile: ラベル密度を下げる (= 隣接 cell 24px は数字 2 桁が ぎりぎり)
                // 30 分単位や 15 分単位 などキリのいい所だけラベル表示
                const labelStep = increment >= 30 ? increment
                  : increment >= 15 ? 30
                  : increment >= 10 ? 30
                  : 15; // 5 分刻みの時は 15 分毎にラベル
                return (
                  <div key={svc.service_no} className="rounded border border-gray-200 p-2">
                    <div className="text-xs font-medium text-gray-700 mb-1 flex items-baseline gap-2 flex-wrap">
                      <span className="font-semibold">サ{svc.service_no}</span>
                      <span>{svc.service_kind || "—"}</span>
                      <span className="ml-auto text-[10px] text-gray-500 tabular-nums">{total} 分 / {increment} 分刻み</span>
                    </div>
                    <div style={{ width: `${cellW * cellCount + 80}px` }}>
                      <div className="flex border-b border-gray-200 text-[9px] text-gray-500 mb-1">
                        <div className="w-[80px] shrink-0 px-1">内容</div>
                        {COLS.map((m) => {
                          const showLabel = m % labelStep === 0;
                          return (
                            <div key={m} className="text-center tabular-nums" style={{ width: `${cellW}px` }}>
                              {showLabel ? m : ""}
                            </div>
                          );
                        })}
                      </div>
                      {bands.length === 0 ? (
                        <div className="text-center text-xs text-gray-400 italic py-2">ステップ未登録</div>
                      ) : (
                        bands.map((b, i) => {
                          const leftPx = (b.start / increment) * cellW;
                          const widthPx = Math.max(2, (b.len / increment) * cellW);
                          return (
                            <div key={i} className="flex items-stretch border-t border-gray-100 relative" style={{ minHeight: 22 }}>
                              <div className="w-[80px] shrink-0 px-1 py-0.5 text-[10px] truncate" title={b.content}>{b.content || `ステップ${i + 1}`}</div>
                              <div className="relative" style={{ width: `${cellW * cellCount}px` }}>
                                {COLS.map((m) => (
                                  <div key={m} className="absolute top-0 bottom-0 border-r border-gray-100"
                                    style={{ left: `${(m / increment - 1) * cellW}px`, width: `${cellW}px` }} />
                                ))}
                                <div className={`absolute top-0.5 bottom-0.5 rounded ${SERVICE_COLORS[svcIdx % SERVICE_COLORS.length]} flex items-center justify-center text-[9px] text-gray-700 px-0.5`}
                                  style={{ left: `${leftPx}px`, width: `${widthPx}px` }}>
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
