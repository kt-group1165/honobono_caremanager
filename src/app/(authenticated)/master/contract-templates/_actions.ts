"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/**
 * 新版作成 (= 現行版を複製、version_no + 1、is_active=false)
 * 対象 kind の最新 version の content を base にする。
 * 対象 kind の版がまだ無ければ空 content で v1 を作る。
 */
export async function createNewVersion(kind: string): Promise<void> {
  const supabase = await createClient();

  const { data: latest, error: e1 } = await supabase
    .from("kaigo_contract_templates")
    .select("id, version_no, content")
    .eq("kind", kind)
    .order("version_no", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (e1) throw new Error(`最新版取得失敗: ${e1.message}`);

  const nextVer = latest ? latest.version_no + 1 : 1;
  const baseContent = latest?.content ?? {};

  const { data: inserted, error: e2 } = await supabase
    .from("kaigo_contract_templates")
    .insert({
      kind,
      version_no: nextVer,
      effective_from: new Date().toISOString().slice(0, 10),
      is_active: false,
      content: baseContent,
      notes: `v${nextVer} (v${latest?.version_no ?? "?"} から複製)`,
    })
    .select("id")
    .single();

  if (e2) throw new Error(`INSERT 失敗: ${e2.message}`);

  revalidatePath("/master/contract-templates");
  redirect(`/master/contract-templates/${inserted.id}`);
}

/**
 * 有効化 (= 同 kind の他行を is_active=false にしてから対象を is_active=true)
 */
export async function activateVersion(id: string, kind: string): Promise<void> {
  const supabase = await createClient();

  // 同 kind の全 template の is_active を false にする
  const { error: e1 } = await supabase
    .from("kaigo_contract_templates")
    .update({ is_active: false })
    .eq("kind", kind)
    .neq("id", id);
  if (e1) throw new Error(`他版 deactivate 失敗: ${e1.message}`);

  // 対象を is_active=true
  const { error: e2 } = await supabase
    .from("kaigo_contract_templates")
    .update({ is_active: true, effective_from: new Date().toISOString().slice(0, 10) })
    .eq("id", id);
  if (e2) throw new Error(`activate 失敗: ${e2.message}`);

  revalidatePath("/master/contract-templates");
}

/**
 * template content の一括更新
 * = 編集画面 (client) から呼ばれる
 */
export async function updateTemplateContent(
  id: string,
  content: Record<string, unknown>,
  notes: string | null,
): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("kaigo_contract_templates")
    .update({ content, notes })
    .eq("id", id);
  if (error) throw new Error(`UPDATE 失敗: ${error.message}`);
  revalidatePath("/master/contract-templates");
  revalidatePath(`/master/contract-templates/${id}`);
}
