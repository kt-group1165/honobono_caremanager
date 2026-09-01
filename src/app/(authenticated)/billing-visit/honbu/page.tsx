import { createClient } from "@/lib/supabase/server";
import { aggregateHonbu, type HonbuResult } from "@/lib/honbu-seikyu/aggregate-honbu";
import { HonbuContent } from "./honbu-content";

/**
 * /billing-visit/honbu — 本部請求 (本部集計)
 * 自社全事業所 (訪問介護/看護/入浴) の月次請求を法人ごとに横断集計するレポート。
 */
export default async function HonbuPage() {
  const supabase = await createClient();
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  let initialResult: HonbuResult | null = null;
  let initialError: string | null = null;
  try {
    initialResult = await aggregateHonbu(supabase, { year, month });
  } catch (e) {
    initialError = e instanceof Error ? e.message : String(e);
  }

  return (
    <HonbuContent
      initialYear={year}
      initialMonth={month}
      initialResult={initialResult}
      initialError={initialError}
    />
  );
}
