import { redirect } from "next/navigation";

/**
 * レセプト画面は 給付管理 と統合 (「レセプト・給付管理」= /billing/benefits の
 * レセプトタブ) したため、旧 URL / 既存リンク (請求画面の「レセプト編集」等) は
 * ここでリダイレクトして受ける。実体は benefits/_tabs.tsx + claims-content.tsx。
 */
export default async function ClaimsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const sp = await searchParams;
  const q = new URLSearchParams({ tab: "claims" });
  if (sp.month && /^\d{4}-\d{2}$/.test(sp.month)) q.set("month", sp.month);
  redirect(`/billing/benefits?${q.toString()}`);
}
