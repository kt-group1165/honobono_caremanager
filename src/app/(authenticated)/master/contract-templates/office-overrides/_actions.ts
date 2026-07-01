"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

/**
 * 事業所別 override を丸ごと update (partial merge ではなく全置換)。
 * empty string / null は保存しない (=削除相当) にすることで
 * 「上書き解除」= 空にする、で表現できる。
 */
export async function updateOfficeContractOverrides(
  officeId: string,
  overrides: Record<string, string>,
): Promise<void> {
  const supabase = await createClient();

  // 空文字/undefined を除いた map
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (typeof v === "string" && v.trim().length > 0) clean[k] = v;
  }

  const { error } = await supabase
    .from("offices")
    .update({ contract_overrides: clean })
    .eq("id", officeId);
  if (error) throw new Error(`UPDATE 失敗: ${error.message}`);

  revalidatePath("/master/contract-templates/office-overrides");
  revalidatePath(`/master/contract-templates/office-overrides/${officeId}`);
}
