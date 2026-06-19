"use client";

// 利用者 (clients.service_category) / 記録 (kaigo_visit_records.service_category 等) を
// 視覚的に区別する小さな chip。
// 介護=blue / 障害=violet / 両方=teal (= 中間色) で色分け。
//
// migration 未適用環境では category undefined / null になりうるため、
// その場合は null を返し非表示にする (== 既存「介護」利用者の表示を壊さない後方互換)。

import type { Client } from "@/types/database";

export type ServiceCategoryValue = "kaigo" | "shougai" | "both" | null | undefined;

export function getCategoryLabel(cat: ServiceCategoryValue): string | null {
  switch (cat) {
    case "kaigo":
      return "介護";
    case "shougai":
      return "障害";
    case "both":
      return "両方";
    default:
      return null;
  }
}

export function ServiceCategoryBadge({
  category,
  size = "sm",
}: {
  category: ServiceCategoryValue;
  size?: "xs" | "sm";
}) {
  const label = getCategoryLabel(category);
  if (!label) return null;

  const colors: Record<string, string> = {
    kaigo: "bg-blue-100 text-blue-700 border-blue-200",
    shougai: "bg-violet-100 text-violet-700 border-violet-200",
    both: "bg-teal-100 text-teal-700 border-teal-200",
  };
  const sizeCls = size === "xs" ? "text-[10px] px-1.5 py-0" : "text-xs px-2 py-0.5";

  return (
    <span
      className={`inline-flex items-center rounded-full border font-medium ${colors[category as string]} ${sizeCls}`}
    >
      {label}
    </span>
  );
}

/** 利用者が障害福祉サービス対象か (= 'shougai' | 'both') */
export function isShougaiClient(client: Pick<Client, "service_category">): boolean {
  return client.service_category === "shougai" || client.service_category === "both";
}

/** 利用者が介護保険対象か (= 'kaigo' | 'both' | undefined (= migration 前は介護扱い)) */
export function isKaigoClient(client: Pick<Client, "service_category">): boolean {
  const c = client.service_category;
  return c == null || c === "kaigo" || c === "both";
}
