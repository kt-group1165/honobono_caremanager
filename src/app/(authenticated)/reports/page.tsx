"use client";

import Link from "next/link";
import {
  User,
  FileText,
  ClipboardList,
  CalendarDays,
  Truck,
} from "lucide-react";

type ReportCard = {
  type: string;
  titleJa: string;
  titleEn: string;
  description: string;
  icon: React.ReactNode;
  color: string;
  bgColor: string;
  borderColor: string;
};

const REPORT_CARDS: ReportCard[] = [
  {
    type: "face-sheet",
    titleJa: "フェースシート",
    titleEn: "Face Sheet",
    description:
      "利用者の基本情報、介護認定、医療保険、ADLスコア、既往歴、家族連絡先、健康記録をまとめた総合情報シートです。",
    icon: <User size={28} />,
    color: "text-blue-600",
    bgColor: "bg-blue-50",
    borderColor: "border-blue-100",
  },
  {
    type: "care-plan-1",
    titleJa: "居宅サービス計画書（第1表）",
    titleEn: "Care Plan Table 1",
    description:
      "利用者情報、介護度、総合的な援助の方針、長期目標など、ケアプランの概要を記載した第1表です。",
    icon: <FileText size={28} />,
    color: "text-emerald-600",
    bgColor: "bg-emerald-50",
    borderColor: "border-emerald-100",
  },
  {
    type: "care-plan-2",
    titleJa: "居宅サービス計画書（第2表）",
    titleEn: "Care Plan Table 2",
    description:
      "長期目標・短期目標および各サービスの内容・頻度・提供者を記載したケアプラン第2表です。",
    icon: <ClipboardList size={28} />,
    color: "text-violet-600",
    bgColor: "bg-violet-50",
    borderColor: "border-violet-100",
  },
  {
    type: "care-plan-3",
    titleJa: "週間サービス計画表（第3表）",
    titleEn: "Care Plan Table 3",
    description:
      "週間の曜日別サービススケジュールを時間帯ごとに表示する計画表です。",
    icon: <CalendarDays size={28} />,
    color: "text-cyan-600",
    bgColor: "bg-cyan-50",
    borderColor: "border-cyan-100",
  },
  {
    type: "service-usage",
    titleJa: "サービス利用票",
    titleEn: "Service Usage Sheet",
    description:
      "月次カレンダー形式で、利用者がどの日にどのサービスを利用したかを表示する利用票です。",
    icon: <CalendarDays size={28} />,
    color: "text-orange-600",
    bgColor: "bg-orange-50",
    borderColor: "border-orange-100",
  },
  {
    type: "service-provision",
    titleJa: "サービス提供票",
    titleEn: "Service Provision Sheet",
    description:
      "事業者視点で計画と実績を対比表示するサービス提供票です。予定と実際の提供状況を確認できます。",
    icon: <Truck size={28} />,
    color: "text-teal-600",
    bgColor: "bg-teal-50",
    borderColor: "border-teal-100",
  },
  {
    type: "service-usage-detail",
    titleJa: "サービス利用票別表",
    titleEn: "Service Usage Detail (Table 7)",
    description:
      "区分支給限度管理・利用者負担計算、種類別支給限度管理、短期入所利用日数を記載するサービス利用票別表（第7表）です。",
    icon: <CalendarDays size={28} />,
    color: "text-cyan-600",
    bgColor: "bg-cyan-50",
    borderColor: "border-cyan-100",
  },
];

export default function ReportsPage() {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">帳票作成</h1>
        <p className="mt-1 text-sm text-gray-500">
          各種公式帳票・書類を作成・印刷できます
        </p>
      </div>

      {/* Report Cards Grid */}
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
        {REPORT_CARDS.map((card) => (
          <div
            key={card.type}
            className={`flex flex-col rounded-xl border bg-white shadow-sm hover:shadow-md transition-shadow overflow-hidden ${card.borderColor}`}
          >
            <div className={`flex items-center gap-4 p-5 ${card.bgColor}`}>
              <div className={`shrink-0 ${card.color}`}>{card.icon}</div>
              <div className="min-w-0">
                <h2 className="font-bold text-gray-900 leading-tight">
                  {card.titleJa}
                </h2>
                <p className="text-xs text-gray-500 mt-0.5">{card.titleEn}</p>
              </div>
            </div>
            <div className="flex flex-1 flex-col justify-between p-5 pt-4">
              <p className="text-sm text-gray-600 leading-relaxed">
                {card.description}
              </p>
              <Link
                href={`/reports/${card.type}`}
                className={`mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium text-white transition-colors ${
                  card.type === "face-sheet"
                    ? "bg-blue-600 hover:bg-blue-700"
                    : card.type === "care-plan-1"
                      ? "bg-emerald-600 hover:bg-emerald-700"
                      : card.type === "care-plan-2"
                        ? "bg-violet-600 hover:bg-violet-700"
                        : card.type === "service-usage"
                          ? "bg-orange-600 hover:bg-orange-700"
                          : card.type === "service-provision"
                            ? "bg-teal-600 hover:bg-teal-700"
                            : card.type === "service-usage-detail"
                              ? "bg-cyan-600 hover:bg-cyan-700"
                              : "bg-gray-600 hover:bg-gray-700"
                }`}
              >
                <FileText size={15} />
                帳票を作成する
              </Link>
            </div>
          </div>
        ))}
      </div>

      {/* Info note */}
      <div className="rounded-lg border border-gray-200 bg-gray-50 px-5 py-4 text-sm text-gray-600">
        <strong className="font-medium text-gray-800">使い方: </strong>
        帳票の種類を選択し、利用者・対象期間を指定すると帳票がプレビュー表示されます。
        ブラウザの印刷機能またはページ内の印刷ボタンからA4用紙に印刷してください。
      </div>
    </div>
  );
}
