"use client";

import Link from "next/link";
import {
  ClipboardList,
  FileText,
  BarChart2,
  ArrowRight,
  Info,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type ReportCard = {
  type: string;
  titleJa: string;
  titleEn: string;
  description: string;
  icon: React.ReactNode;
  color: string;
  bgColor: string;
  borderColor: string;
  buttonColor: string;
  badge: string | null;
};

// ─── Data ─────────────────────────────────────────────────────────────────────

const REPORT_CARDS: ReportCard[] = [
  {
    type: "visit-implementation",
    titleJa: "サービス実施記録書",
    titleEn: "Visit Implementation Record",
    description:
      "訪問介護のサービス実施記録を帳票形式で出力します。実施日・時刻・担当者・実施内容（身体介護・生活援助チェック項目）・バイタル・特記事項を一覧表示し、ご利用者・ご家族への説明・確認用として利用できます。",
    icon: <ClipboardList size={28} />,
    color: "text-blue-600",
    bgColor: "bg-blue-50",
    borderColor: "border-blue-100",
    buttonColor: "bg-blue-600 hover:bg-blue-700",
    badge: null,
  },
  {
    type: "visit-care-plan",
    titleJa: "訪問介護計画書",
    titleEn: "Home Care Plan",
    description:
      "居宅介護事業所が作成する訪問介護計画書を出力します。生活全般の課題、援助目標（長期・短期）、具体的な援助内容、サービス提供の記録欄を含む公式様式に準拠したフォーマットです。",
    icon: <FileText size={28} />,
    color: "text-emerald-600",
    bgColor: "bg-emerald-50",
    borderColor: "border-emerald-100",
    buttonColor: "bg-emerald-600 hover:bg-emerald-700",
    badge: null,
  },
  {
    type: "visit-results",
    titleJa: "実績報告書",
    titleEn: "Results Report",
    description:
      "月次の訪問介護サービス実績をまとめた報告書を出力します。利用者ごとの訪問日・時間・サービス内容・担当者を一覧化し、ケアマネジャーへの月次報告や請求資料として活用できます。",
    icon: <BarChart2 size={28} />,
    color: "text-violet-600",
    bgColor: "bg-violet-50",
    borderColor: "border-violet-100",
    buttonColor: "bg-violet-600 hover:bg-violet-700",
    badge: "準備中",
  },
];

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ReportsVisitPage() {
  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">帳票作成（訪問介護）</h1>
        <p className="mt-1 text-sm text-gray-500">
          訪問介護に特化した帳票・書類を作成・印刷できます
        </p>
      </div>

      {/* Info banner */}
      <div className="flex items-start gap-3 rounded-xl border border-blue-100 bg-blue-50 px-4 py-3">
        <Info size={16} className="mt-0.5 shrink-0 text-blue-500" />
        <p className="text-xs text-blue-700 leading-relaxed">
          各帳票は利用者・対象月を選択して出力します。
          帳票データは「サービス実施記録」メニューに入力された実績から自動生成されます。
          <strong className="font-semibold"> 印刷はブラウザの印刷機能（Ctrl+P）またはページ内の印刷ボタン</strong>をご利用ください。
        </p>
      </div>

      {/* Report Cards */}
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
        {REPORT_CARDS.map((card) => (
          <div
            key={card.type}
            className={`flex flex-col rounded-xl border bg-white shadow-sm hover:shadow-md transition-shadow overflow-hidden ${card.borderColor}`}
          >
            {/* Card top */}
            <div className={`flex items-center gap-4 p-5 ${card.bgColor}`}>
              <div className={`shrink-0 ${card.color}`}>{card.icon}</div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="font-bold text-gray-900 leading-tight truncate">
                    {card.titleJa}
                  </h2>
                  {card.badge && (
                    <span className="shrink-0 rounded-full bg-yellow-100 px-2 py-0.5 text-[10px] font-semibold text-yellow-700">
                      {card.badge}
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-500 mt-0.5">{card.titleEn}</p>
              </div>
            </div>

            {/* Card body */}
            <div className="flex flex-1 flex-col justify-between p-5 pt-4">
              <p className="text-sm text-gray-600 leading-relaxed">
                {card.description}
              </p>

              {card.badge ? (
                <div className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-400 cursor-not-allowed">
                  <FileText size={15} />
                  近日公開予定
                </div>
              ) : (
                <Link
                  href={`/reports-visit/${card.type}`}
                  className={`mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium text-white transition-colors ${card.buttonColor}`}
                >
                  <FileText size={15} />
                  帳票を作成する
                  <ArrowRight size={14} />
                </Link>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Related links */}
      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <h3 className="mb-3 text-sm font-bold text-gray-800">関連メニュー</h3>
        <ul className="space-y-2 text-sm">
          <li>
            <Link
              href="/visit-records"
              className="flex items-center gap-2 text-blue-600 hover:underline"
            >
              <ArrowRight size={13} />
              サービス実施記録 — 訪問記録の入力・確認
            </Link>
          </li>
          <li>
            <Link
              href="/visit-billing"
              className="flex items-center gap-2 text-blue-600 hover:underline"
            >
              <ArrowRight size={13} />
              実績管理 — 月次実績の集計・CSV出力
            </Link>
          </li>
          <li>
            <Link
              href="/provision-confirm"
              className="flex items-center gap-2 text-blue-600 hover:underline"
            >
              <ArrowRight size={13} />
              提供票確認 — ケアマネからの提供票の確認
            </Link>
          </li>
          <li>
            <Link
              href="/reports"
              className="flex items-center gap-2 text-blue-600 hover:underline"
            >
              <ArrowRight size={13} />
              帳票作成（居宅介護支援） — ケアプラン・フェースシートなど
            </Link>
          </li>
        </ul>
      </div>

      {/* Footer note */}
      <div className="rounded-lg border border-gray-200 bg-gray-50 px-5 py-4 text-sm text-gray-600">
        <strong className="font-medium text-gray-800">使い方: </strong>
        帳票の種類を選択し、対象利用者・対象月を指定すると帳票がプレビュー表示されます。
        ブラウザの印刷機能またはページ内の印刷ボタンからA4用紙に印刷してください。
      </div>
    </div>
  );
}
