"use client";

/**
 * 訪問介護 手順書: プレビュー page (read-only)
 *
 * URL: /visit-procedures/[id]
 *
 * - 既存 doc を fetch して整形表示 (印刷向けレイアウト)
 * - 2 タブ: 手順 / モジュール (両方 read-only)
 * - 編集ボタンで /[id]/edit へ
 */

import Link from "next/link";
import { useRouter, useParams, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, BookOpen, Edit3, Loader2, AlertCircle, Layers, LayoutGrid, Printer } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import { getDocument } from "@/lib/visit-procedure/queries";
import {
  WEEKDAY_KEYS,
  WEEKDAY_LABELS,
  SERVICE_NOS,
  type VisitProcedureDocument,
} from "@/lib/visit-procedure/types";

type Tab = "procedure" | "module";

function formatJpDate(s: string | null | undefined): string {
  if (!s) return "（未設定）";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s;
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;
}

export default function VisitProcedurePreviewPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const id = params?.id ?? "";
  const supabase = useMemo(() => createClient(), []);
  const { businessType, currentOffice, loading: btLoading } = useBusinessType();
  const [tab, setTab] = useState<Tab>("procedure");
  const [doc, setDoc] = useState<VisitProcedureDocument | null>(null);
  const [loading, setLoading] = useState(true);

  const tenantId = currentOffice?.tenant_id ?? null;
  const officeQuery = search?.get("office") ? `?office=${encodeURIComponent(search.get("office")!)}` : "";

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- mount-time async fetch (HANDOVER §2) */
    if (btLoading) return;
    if (!tenantId || !id) { setLoading(false); return; }
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const found = await getDocument(supabase, id);
        if (!cancelled) {
          if (!found) {
            toast.error("手順書が見つかりません");
            router.push("/visit-procedures");
            return;
          }
          const filled = SERVICE_NOS.map((no) => {
            const ex = found.services.find((s) => s.service_no === no);
            return ex ?? { service_no: no, time_range: "", service_kind: "" as const, special_notes: "", steps: [] };
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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- router 変化で再 load 不要
  }, [supabase, tenantId, id, btLoading]);

  if (!btLoading && businessType !== "訪問介護") {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-gray-900">手順書</h1>
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-amber-800 flex items-start gap-3">
          <AlertCircle size={20} className="shrink-0 mt-0.5" />
          <p className="font-medium">この機能は訪問介護モード専用です</p>
        </div>
      </div>
    );
  }

  if (loading || !doc) {
    return (
      <div className="flex items-center justify-center py-12 text-gray-400">
        <Loader2 size={20} className="animate-spin mr-2" />
        読込中...
      </div>
    );
  }

  const period = `${formatJpDate(doc.plan_start_date)}〜${formatJpDate(doc.plan_end_date)}`;

  return (
    <div className="space-y-4 sm:space-y-6 visit-procedure-print-root">
      {/* 印刷専用 style: A4 縦、不要 UI 非表示 */}
      <style>{`
        @media print {
          @page { size: A4 portrait; margin: 12mm; }
          aside, nav, header, [role="navigation"], .print-hide { display: none !important; }
          body, html { background: #fff !important; }
          .visit-procedure-print-root { padding: 0 !important; }
          .visit-procedure-print-root, .visit-procedure-print-root * {
            color: #000 !important; box-shadow: none !important;
          }
          .visit-procedure-print-root table { page-break-inside: avoid; }
          .visit-procedure-print-root section { page-break-inside: avoid; }
        }
      `}</style>
      <div className="flex items-center justify-between gap-2 flex-wrap print-hide">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <Link
            href={`/visit-procedures/clients/${encodeURIComponent(doc.client_name)}${officeQuery}`}
            className="text-gray-400 hover:text-gray-600 shrink-0"
            title="バージョン一覧に戻る"
          >
            <ArrowLeft size={20} />
          </Link>
          <h1 className="text-lg sm:text-xl font-bold text-gray-900 flex items-center gap-2 min-w-0">
            <BookOpen size={20} className="text-green-600 shrink-0" />
            <span className="truncate">{doc.client_name}</span>
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            <Printer size={16} />
            <span className="hidden sm:inline">印刷 (A4 縦)</span>
            <span className="sm:hidden">印刷</span>
          </button>
          <Link
            href={`/visit-procedures/${id}/edit${officeQuery}`}
            className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-2 text-sm font-medium text-white hover:bg-green-700"
          >
            <Edit3 size={16} />
            編集
          </Link>
        </div>
      </div>

      {/* 基本情報 */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-y-2 gap-x-6 text-sm">
          <div><span className="text-gray-500 text-xs">利用者氏名 </span><span className="font-medium">{doc.client_name}</span></div>
          <div><span className="text-gray-500 text-xs">計画期間 </span><span className="font-medium">{period}</span></div>
          <div><span className="text-gray-500 text-xs">作成者 </span><span className="font-medium">{doc.author_name || "—"}</span></div>
          {doc.creation_reason && (
            <div className="sm:col-span-3"><span className="text-gray-500 text-xs">作成理由 </span><span>{doc.creation_reason}</span></div>
          )}
        </div>
      </div>

      {/* タブ切替 */}
      <div className="flex gap-1 border-b border-gray-200 print-hide">
        <button onClick={() => setTab("procedure")}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === "procedure" ? "border-green-600 text-green-700" : "border-transparent text-gray-500 hover:text-gray-700"
          }`}>
          <Layers size={16} />手順
        </button>
        <button onClick={() => setTab("module")}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === "module" ? "border-green-600 text-green-700" : "border-transparent text-gray-500 hover:text-gray-700"
          }`}>
          <LayoutGrid size={16} />モジュール
        </button>
      </div>

      {tab === "procedure" ? <ProcedurePreview doc={doc} /> : <ModulePreview doc={doc} />}
    </div>
  );
}

// =====================================================================
// 手順 タブ (read-only)
// =====================================================================
function ProcedurePreview({ doc }: { doc: VisitProcedureDocument }) {
  return (
    <div className="space-y-6">
      {/* 週次表 */}
      <section className="rounded-lg border border-gray-200 bg-white">
        <h2 className="px-3 py-2 border-b border-gray-200 text-sm font-semibold text-gray-700 bg-gray-50">週次サービス表</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse table-fixed">
            <colgroup>
              <col className="w-12" />
              {SERVICE_NOS.map((no) => <col key={no} />)}
            </colgroup>
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="px-2 py-1.5 border border-gray-200 text-center">曜日</th>
                {SERVICE_NOS.map((no) => (<th key={no} className="px-2 py-1.5 border border-gray-200 text-center">サービス{no}</th>))}
              </tr>
            </thead>
            <tbody>
              {WEEKDAY_KEYS.map((day) => (
                <tr key={day} className="border-t border-gray-200">
                  <td className="px-2 py-1 border border-gray-200 text-center font-medium bg-gray-50">{WEEKDAY_LABELS[day]}</td>
                  {SERVICE_NOS.map((no) => {
                    const cell = doc.weekly_schedule?.[day]?.[String(no)] ?? {};
                    const hasContent = cell.time_range || cell.service_kind;
                    return (
                      <td key={no} className="px-2 py-1 border border-gray-200 text-center align-middle">
                        {hasContent ? (
                          <span className="text-gray-800 whitespace-nowrap">
                            {cell.time_range || "—"}
                            {cell.service_kind ? <span className="text-gray-500 ml-4">{cell.service_kind}</span> : null}
                          </span>
                        ) : <span className="text-gray-300">&nbsp;</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 全体 特記事項 */}
      {doc.special_notes && (
        <section className="rounded-lg border border-gray-200 bg-white p-3 sm:p-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-2">特記事項 (全体)</h3>
          <p className="text-sm text-gray-700 whitespace-pre-wrap break-words">{doc.special_notes}</p>
        </section>
      )}

      {/* サービス①〜⑤ */}
      {doc.services.map((svc) => {
        const hasAny = (svc.time_range || svc.service_kind || svc.steps.length > 0 || svc.special_notes);
        if (!hasAny) return null;
        return (
          <section key={svc.service_no} className="rounded-lg border border-gray-200 bg-white">
            <h3 className="px-3 sm:px-4 py-2 border-b border-gray-200 text-sm font-semibold text-gray-700 bg-gray-50 flex items-center gap-2 sm:gap-3 flex-wrap">
              <span>サービス{svc.service_no}</span>
              <span className="text-xs font-normal text-gray-500">
                {svc.time_range || "—"}
                {svc.service_kind ? ` / ${svc.service_kind}` : ""}
              </span>
            </h3>
            <div className="p-3 sm:p-4 space-y-3">
              {svc.steps.length === 0 ? (
                <p className="text-xs text-gray-400 italic">ステップ未登録</p>
              ) : (
                <>
                  {/* PC: table、SP: カード stack */}
                  <table className="hidden sm:table w-full text-xs">
                    <thead className="bg-gray-50 text-gray-600">
                      <tr>
                        <th className="px-2 py-1.5 border border-gray-200 w-32 text-left">サービス内容</th>
                        <th className="px-2 py-1.5 border border-gray-200 w-16 text-right">時間(分)</th>
                        <th className="px-2 py-1.5 border border-gray-200 text-left">具体的取り組内容及び手順</th>
                      </tr>
                    </thead>
                    <tbody>
                      {svc.steps.map((step, idx) => (
                        <tr key={idx} className="border-t border-gray-200">
                          <td className="px-2 py-1.5 border border-gray-200">{step.content || "—"}</td>
                          <td className="px-2 py-1.5 border border-gray-200 text-right tabular-nums">{step.minutes}</td>
                          <td className="px-2 py-1.5 border border-gray-200 whitespace-pre-wrap">{step.detail || ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="sm:hidden space-y-2">
                    {svc.steps.map((step, idx) => (
                      <div key={idx} className="rounded border border-gray-200 p-2 bg-gray-50">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-sm font-medium text-gray-900 break-words flex-1 min-w-0">{step.content || "—"}</span>
                          <span className="shrink-0 text-xs text-gray-500 tabular-nums">{step.minutes}分</span>
                        </div>
                        {step.detail && (
                          <p className="mt-1 text-xs text-gray-700 whitespace-pre-wrap break-words">{step.detail}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}
              {svc.special_notes && (
                <div className="text-xs">
                  <span className="text-gray-500">特記事項: </span>
                  <span className="text-gray-700 whitespace-pre-wrap break-words">{svc.special_notes}</span>
                </div>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// =====================================================================
// モジュール タブ (read-only)
// =====================================================================
function ModulePreview({ doc }: { doc: VisitProcedureDocument }) {
  const COLS = Array.from({ length: 18 }, (_, i) => (i + 1) * 5);
  const COLORS = ["bg-blue-200", "bg-emerald-200", "bg-amber-200", "bg-rose-200", "bg-violet-200"];

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-500">5 分刻みでサービス毎のステップを帯表示</p>
      {doc.services.map((svc, svcIdx) => {
        if (svc.steps.length === 0 && !svc.time_range && !svc.service_kind) return null;
        let cursor = 0;
        const bands = svc.steps.map((st) => {
          const start = cursor;
          const len = Math.max(0, Math.floor(st.minutes));
          cursor += len;
          return { ...st, start, len };
        });
        const total = cursor;
        const cellW = 28;
        return (
          <section key={svc.service_no} className="rounded-lg border border-gray-200 bg-white p-3">
            <div className="flex items-center gap-3 text-sm font-medium text-gray-700 mb-2">
              <span>サービス{svc.service_no}</span>
              <span className="text-xs text-gray-500">{svc.time_range || "(時間帯未設定)"}{svc.service_kind ? ` / ${svc.service_kind}` : ""}</span>
              <span className="text-xs text-gray-400 ml-auto">合計 {total} 分</span>
            </div>
            <div className="overflow-x-auto">
              <div className="flex border-b border-gray-200 text-[10px] text-gray-500 mb-1" style={{ width: `${cellW * COLS.length + 120}px` }}>
                <div className="w-[120px] shrink-0 px-2">内容</div>
                {COLS.map((m) => (<div key={m} className="text-center" style={{ width: `${cellW}px` }}>{m}</div>))}
              </div>
              {bands.length === 0 ? (
                <div className="text-center text-xs text-gray-400 italic py-3">ステップが未登録です</div>
              ) : (
                bands.map((b, i) => {
                  const startCols = Math.floor(b.start / 5);
                  const widthCols = Math.max(1, Math.floor(b.len / 5));
                  return (
                    <div key={i} className="flex items-stretch border-t border-gray-100 relative" style={{ width: `${cellW * COLS.length + 120}px`, minHeight: 26 }}>
                      <div className="w-[120px] shrink-0 px-2 py-1 text-xs truncate" title={b.content}>{b.content || `ステップ${i + 1}`}</div>
                      <div className="relative" style={{ width: `${cellW * COLS.length}px` }}>
                        {COLS.map((m) => (
                          <div key={m} className="absolute top-0 bottom-0 border-r border-gray-100" style={{ left: `${(m / 5 - 1) * cellW}px`, width: `${cellW}px` }} />
                        ))}
                        <div className={`absolute top-1 bottom-1 rounded ${COLORS[svcIdx % COLORS.length]} flex items-center justify-center text-[10px] text-gray-700 px-1`}
                          style={{ left: `${startCols * cellW}px`, width: `${widthCols * cellW}px` }} title={`${b.content} (${b.len} 分)`}>
                          {b.len > 0 ? `${b.len}分` : ""}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
