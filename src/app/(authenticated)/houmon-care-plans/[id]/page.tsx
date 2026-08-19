"use client";

/**
 * 訪問介護計画書: 印刷プレビュー page (v2)
 *
 * URL: /houmon-care-plans/[id]
 *
 * - read-only 表示 + window.print() で印刷
 * - A4 縦、不要 UI 非表示
 * - 項目は v2 schema (ニーズ/長期・短期目標(期間) / 週間サービス計画 / 説明・同意) に対応
 */

import Link from "next/link";
import { useRouter, useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ClipboardList, Printer, Loader2, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import { getPlan } from "@/lib/houmon-care-plan/queries";
import { formatDays, type HoumonCarePlan } from "@/lib/houmon-care-plan/types";

interface UserInfo {
  id: string;
  name: string;
  furigana: string | null;
  birth_date: string | null;
  care_level: string | null;
  address: string | null;
}

function formatJpDate(s: string | null | undefined): string {
  if (!s) return "（未設定）";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s;
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;
}

/** "09:00"〜"09:45" の時間帯表示 */
function timeRange(start: string, end: string): string {
  if (!start && !end) return "—";
  return `${start || "—"} 〜 ${end || "—"}`;
}

export default function HoumonCarePlanPrintPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const supabase = useMemo(() => createClient(), []);
  const { businessType, loading: btLoading } = useBusinessType();
  const [plan, setPlan] = useState<HoumonCarePlan | null>(null);
  const [user, setUser] = useState<UserInfo | null>(null);
  const [office, setOffice] = useState<{ name: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- mount-time async fetch */
    if (!id) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const found = await getPlan(supabase, id);
        if (!found) {
          if (!cancelled) {
            toast.error("計画書が見つかりません");
            router.push("/houmon-care-plans");
          }
          return;
        }
        if (cancelled) return;
        setPlan(found);

        const [userRes, officeRes] = await Promise.all([
          supabase
            .from("clients")
            .select("id, name, furigana, birth_date, care_level, address")
            .eq("id", found.user_id)
            .maybeSingle(),
          found.office_id
            ? supabase.from("offices").select("name").eq("id", found.office_id).maybeSingle()
            : Promise.resolve({ data: null, error: null }),
        ]);
        if (!cancelled) {
          if (userRes.error) console.error("user fetch:", userRes.error.message);
          setUser((userRes.data ?? null) as UserInfo | null);
          if (officeRes && "error" in officeRes && officeRes.error) {
            console.error("office fetch:", officeRes.error.message);
          }
          setOffice((officeRes?.data ?? null) as { name: string } | null);
        }
      } catch (err) {
        console.error(err);
        if (!cancelled) {
          toast.error("読込失敗: " + (err instanceof Error ? err.message : String(err)));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
    /* eslint-enable react-hooks/set-state-in-effect */
    // eslint-disable-next-line react-hooks/exhaustive-deps -- router の identity 変化で再 load 不要
  }, [supabase, id]);

  if (!btLoading && businessType !== "訪問介護") {
    return (
      <div className="space-y-6 p-6">
        <h1 className="text-2xl font-bold text-gray-900">訪問介護計画書</h1>
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-amber-800 flex items-start gap-3">
          <AlertCircle size={20} className="shrink-0 mt-0.5" />
          <p className="font-medium">この機能は訪問介護モード専用です</p>
        </div>
      </div>
    );
  }

  if (loading || !plan) {
    return (
      <div className="flex items-center justify-center py-12 text-gray-400">
        <Loader2 size={20} className="animate-spin mr-2" />
        読込中...
      </div>
    );
  }

  return (
    <div className="houmon-care-plan-print-root p-4 sm:p-6">
      <style>{`
        @media print {
          @page { size: A4 portrait; margin: 12mm; }
          aside, nav, header, [role="navigation"], .print-hide { display: none !important; }
          body, html { background: #fff !important; }
          .houmon-care-plan-print-root { padding: 0 !important; }
          .houmon-care-plan-print-root, .houmon-care-plan-print-root * {
            color: #000 !important; box-shadow: none !important;
          }
          .print-page { page-break-inside: auto; }
          table { page-break-inside: auto; }
          tr { page-break-inside: avoid; }
        }
      `}</style>

      {/* 操作 bar (= 印刷時は非表示) */}
      <div className="print-hide mb-4 flex items-center justify-between gap-2 flex-wrap">
        <Link
          href={`/houmon-care-plans?user=${encodeURIComponent(plan.user_id)}`}
          className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
        >
          <ArrowLeft size={14} />
          一覧へ
        </Link>
        <button
          onClick={() => window.print()}
          className="inline-flex items-center gap-1 rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
        >
          <Printer size={14} />
          印刷
        </button>
      </div>

      {/* 印刷本体 */}
      <article className="mx-auto max-w-3xl bg-white p-6 print-page" style={{ minHeight: "auto" }}>
        <header className="mb-4 border-b-2 border-gray-700 pb-2">
          <div className="flex items-end justify-between gap-3">
            <h1 className="text-xl font-bold flex items-center gap-2">
              <ClipboardList size={20} />
              訪問介護計画書
            </h1>
            <span className="text-xs border border-gray-700 px-2 py-0.5">{plan.plan_kind}</span>
          </div>
          <p className="mt-1 text-xs text-gray-600">
            指定居宅サービス等の事業の人員、設備及び運営に関する基準 第28条
          </p>
        </header>

        {/* 利用者・事業所 */}
        <table
          className="w-full text-sm border border-gray-700 mb-3"
          style={{ borderCollapse: "collapse" }}
        >
          <tbody>
            <tr>
              <th className="border border-gray-700 bg-gray-100 px-2 py-1 text-left w-1/4">
                利用者氏名
              </th>
              <td className="border border-gray-700 px-2 py-1">
                {user?.name ?? "—"}
                {user?.furigana ? (
                  <span className="text-xs text-gray-500 ml-2">({user.furigana})</span>
                ) : null}
              </td>
              <th className="border border-gray-700 bg-gray-100 px-2 py-1 text-left w-1/6">
                要介護度
              </th>
              <td className="border border-gray-700 px-2 py-1">{user?.care_level ?? "—"}</td>
            </tr>
            <tr>
              <th className="border border-gray-700 bg-gray-100 px-2 py-1 text-left">生年月日</th>
              <td className="border border-gray-700 px-2 py-1">{formatJpDate(user?.birth_date)}</td>
              <th className="border border-gray-700 bg-gray-100 px-2 py-1 text-left">作成日</th>
              <td className="border border-gray-700 px-2 py-1">
                {formatJpDate(plan.plan_date)}
                {plan.initial_plan_date && plan.initial_plan_date !== plan.plan_date ? (
                  <span className="text-xs text-gray-600 ml-2">
                    (初回 {formatJpDate(plan.initial_plan_date)})
                  </span>
                ) : null}
              </td>
            </tr>
            <tr>
              <th className="border border-gray-700 bg-gray-100 px-2 py-1 text-left">住所</th>
              <td className="border border-gray-700 px-2 py-1" colSpan={3}>
                {user?.address ?? "—"}
              </td>
            </tr>
            <tr>
              <th className="border border-gray-700 bg-gray-100 px-2 py-1 text-left">事業所</th>
              <td className="border border-gray-700 px-2 py-1">{office?.name ?? "—"}</td>
              <th className="border border-gray-700 bg-gray-100 px-2 py-1 text-left">
                サービス提供責任者
              </th>
              <td className="border border-gray-700 px-2 py-1">
                {plan.author_name || "—"}
                {plan.creator_name && plan.creator_name !== plan.author_name ? (
                  <span className="text-xs text-gray-600 ml-2">(作成者 {plan.creator_name})</span>
                ) : null}
              </td>
            </tr>
            <tr>
              <th className="border border-gray-700 bg-gray-100 px-2 py-1 text-left">計画期間</th>
              <td className="border border-gray-700 px-2 py-1" colSpan={3}>
                {formatJpDate(plan.valid_from)} 〜 {formatJpDate(plan.valid_until)}
              </td>
            </tr>
          </tbody>
        </table>

        {/* 意向・方針 */}
        <Block title="本人の意向">{plan.user_intention || "—"}</Block>
        <Block title="家族の意向">{plan.family_intention || "—"}</Block>
        <Block title="援助の基本方針">{plan.basic_policy || "—"}</Block>

        {/* 課題・目標 */}
        <div className="mb-3">
          <h2 className="text-sm font-semibold bg-gray-100 border border-gray-700 px-2 py-1">
            生活全般の解決すべき課題 (ニーズ) と目標
          </h2>
          <table className="w-full text-sm border border-gray-700" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th className="border border-gray-700 bg-gray-50 px-2 py-1 w-8">#</th>
                <th className="border border-gray-700 bg-gray-50 px-2 py-1">課題 (ニーズ)</th>
                <th className="border border-gray-700 bg-gray-50 px-2 py-1 w-1/4">長期目標 (期間)</th>
                <th className="border border-gray-700 bg-gray-50 px-2 py-1 w-1/4">短期目標 (期間)</th>
              </tr>
            </thead>
            <tbody>
              {plan.goals.length === 0 ? (
                <tr>
                  <td colSpan={4} className="border border-gray-700 px-2 py-2 text-center text-gray-500">
                    （課題・目標が登録されていません）
                  </td>
                </tr>
              ) : (
                plan.goals.map((g, idx) => (
                  <tr key={idx}>
                    <td className="border border-gray-700 px-2 py-1 text-center align-top">{idx + 1}</td>
                    <td className="border border-gray-700 px-2 py-1 whitespace-pre-wrap align-top">
                      {g.needs || "—"}
                    </td>
                    <td className="border border-gray-700 px-2 py-1 whitespace-pre-wrap align-top">
                      {g.long_term_goal || "—"}
                      {g.long_term_period ? (
                        <div className="text-xs text-gray-600 mt-0.5">{g.long_term_period}</div>
                      ) : null}
                    </td>
                    <td className="border border-gray-700 px-2 py-1 whitespace-pre-wrap align-top">
                      {g.short_term_goal || "—"}
                      {g.short_term_period ? (
                        <div className="text-xs text-gray-600 mt-0.5">{g.short_term_period}</div>
                      ) : null}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* 週間サービス計画 */}
        <div className="mb-3">
          <h2 className="text-sm font-semibold bg-gray-100 border border-gray-700 px-2 py-1">
            訪問介護の内容 (週間サービス計画)
          </h2>
          <table className="w-full text-sm border border-gray-700" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th className="border border-gray-700 bg-gray-50 px-2 py-1 w-8">#</th>
                <th className="border border-gray-700 bg-gray-50 px-2 py-1 w-1/6">曜日</th>
                <th className="border border-gray-700 bg-gray-50 px-2 py-1 w-1/5">時間</th>
                <th className="border border-gray-700 bg-gray-50 px-2 py-1 w-1/6">サービス区分</th>
                <th className="border border-gray-700 bg-gray-50 px-2 py-1">援助内容 / 留意点</th>
              </tr>
            </thead>
            <tbody>
              {plan.weekly_services.length === 0 ? (
                <tr>
                  <td colSpan={5} className="border border-gray-700 px-2 py-2 text-center text-gray-500">
                    （サービスが登録されていません）
                  </td>
                </tr>
              ) : (
                plan.weekly_services.map((s, idx) => (
                  <tr key={idx}>
                    <td className="border border-gray-700 px-2 py-1 text-center align-top">{idx + 1}</td>
                    <td className="border border-gray-700 px-2 py-1 align-top">
                      {formatDays(s.days) || "—"}
                    </td>
                    <td className="border border-gray-700 px-2 py-1 align-top">
                      {timeRange(s.start_time, s.end_time)}
                    </td>
                    <td className="border border-gray-700 px-2 py-1 align-top">{s.service_kind || "—"}</td>
                    <td className="border border-gray-700 px-2 py-1 whitespace-pre-wrap align-top">
                      {s.content || "—"}
                      {s.notes ? (
                        <div className="text-xs text-gray-600 mt-0.5">留意点: {s.notes}</div>
                      ) : null}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* 状況・留意事項 */}
        <Block title="利用者の状況">{plan.user_situation || "—"}</Block>
        <Block title="家族の状況">{plan.family_situation || "—"}</Block>
        <Block title="サービス提供上の留意事項">{plan.precautions || "—"}</Block>
        <Block title="緊急時の対応">{plan.emergency_response || "—"}</Block>
        <Block title="特記事項">{plan.special_notes || "—"}</Block>

        {/* 説明・同意 */}
        <div className="mt-6 border-t pt-3">
          <p className="mb-2 text-sm">
            上記の訪問介護計画について説明を受け、内容に同意しました。
          </p>
          <table className="w-full text-sm border border-gray-700" style={{ borderCollapse: "collapse" }}>
            <tbody>
              <tr>
                <th className="border border-gray-700 bg-gray-100 px-2 py-1 text-left w-1/4">説明日</th>
                <td className="border border-gray-700 px-2 py-1">{formatJpDate(plan.explained_on)}</td>
                <th className="border border-gray-700 bg-gray-100 px-2 py-1 text-left w-1/4">同意日</th>
                <td className="border border-gray-700 px-2 py-1">
                  {formatJpDate(plan.user_consent_date)}
                </td>
              </tr>
              <tr>
                <th className="border border-gray-700 bg-gray-100 px-2 py-1 text-left">利用者署名</th>
                <td className="border border-gray-700 px-2 py-1">
                  {plan.user_consent_name || "　"}
                  <span className="text-xs text-gray-500 ml-1">印</span>
                </td>
                <th className="border border-gray-700 bg-gray-100 px-2 py-1 text-left">
                  代理人署名 (続柄)
                </th>
                <td className="border border-gray-700 px-2 py-1">
                  {plan.consent_proxy_name || "　"}
                  {plan.consent_proxy_relation ? `（${plan.consent_proxy_relation}）` : ""}
                  <span className="text-xs text-gray-500 ml-1">印</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </article>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <h2 className="text-sm font-semibold bg-gray-100 border border-gray-700 border-b-0 px-2 py-1">
        {title}
      </h2>
      <div className="border border-gray-700 px-2 py-2 text-sm whitespace-pre-wrap min-h-[3rem]">
        {children}
      </div>
    </div>
  );
}
