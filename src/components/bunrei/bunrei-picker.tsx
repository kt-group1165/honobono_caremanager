"use client";

/**
 * 文例ピッカー — bunrei_master (文例データベース) からフィールド単位の短文を挿入する。
 *
 * 位置づけ:
 *   - 文例 = フィールド単位の短文 (この component / bunrei_master)
 *   - 定型文 = 記録全体の雛形 (既存 TemplatePicker / kaigo_record_templates)
 *
 * 機能:
 *   - テキストエリア横の小さな「文例」ボタン → カテゴリ絞込済みのポップオーバー
 *   - 検索 box + 一覧 (usage_count 降順) + クリックで末尾追記 (空なら置換)
 *   - 挿入時に usage_count++ (RPC bunrei_increment_usage、エラーは check して通知)
 *   - 「この内容を文例に保存」で自前蓄積 (is_builtin = false)
 *
 * フォールバック:
 *   - bunrei_master 未作成 (migration 未適用) の場合は案内文を表示して壊れない
 */

import { useState, useEffect, useMemo, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { BookOpen, Loader2, Search, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useBusinessType } from "@/lib/business-type-context";

export type BunreiCategory =
  | "計画1-意向"
  | "計画1-方針"
  | "計画2-課題"
  | "計画2-長期目標"
  | "計画2-短期目標"
  | "計画2-サービス内容"
  | "モニタリング"
  | "支援経過"
  | "アセスメント";

type BunreiRow = {
  id: string;
  category: string;
  care_level: string | null;
  text: string;
  usage_count: number;
  is_builtin: boolean;
};

interface BunreiPickerProps {
  /** どのカテゴリの文例を出すか (= 挿入先フィールド種別) */
  category: BunreiCategory;
  /** 現在のテキスト値 (末尾追記・「文例に保存」に使用) */
  currentText?: string;
  /** 選択時のコールバック (新テキスト全体を返す) */
  onInsert: (newText: string) => void;
  /** 挿入先が複数行 (textarea) か。false の場合は空白で連結する */
  multiline?: boolean;
  /** ボタンの外観オプション */
  buttonClassName?: string;
}

/** migration 未適用 (table 無し) の検出 */
function isMissingTable(err: { code?: string; message?: string }): boolean {
  return err.code === "42P01" || /bunrei_master/.test(err.message ?? "");
}

export function BunreiPicker({
  category,
  currentText = "",
  onInsert,
  multiline = true,
  buttonClassName,
}: BunreiPickerProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<BunreiRow[]>([]);
  const [query, setQuery] = useState("");
  const [tableMissing, setTableMissing] = useState(false);
  const [saving, setSaving] = useState(false);
  const { currentOffice } = useBusinessType();
  const supabase = useMemo(() => createClient(), []);
  const tenantId = currentOffice?.tenant_id ?? null;

  // 開くたびに fetch (usage_count 順が変わるためキャッシュしない)
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      let q = supabase
        .from("bunrei_master")
        .select("id, category, care_level, text, usage_count, is_builtin")
        .eq("category", category)
        .order("usage_count", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(500);
      if (tenantId) q = q.eq("tenant_id", tenantId);
      const { data, error } = await q;
      if (cancelled) return;
      setLoading(false);
      if (error) {
        if (isMissingTable(error)) {
          setTableMissing(true);
          return;
        }
        console.error("文例の取得に失敗:", error.message);
        toast.error(`文例の取得に失敗: ${error.message}`);
        return;
      }
      setTableMissing(false);
      setRows((data ?? []) as BunreiRow[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, category, tenantId, supabase]);

  const filtered = useMemo(() => {
    const kw = query.trim();
    if (!kw) return rows;
    return rows.filter(
      (r) => r.text.includes(kw) || (r.care_level ?? "").includes(kw)
    );
  }, [rows, query]);

  const handleSelect = useCallback(
    async (row: BunreiRow) => {
      // 末尾追記 (空ならそのまま置換)。単一行フィールドは空白で連結。
      const sep = multiline ? "\n" : " ";
      const newText = currentText.trim() ? `${currentText}${sep}${row.text}` : row.text;
      onInsert(newText);
      setOpen(false);
      // usage_count++ (エラーは握りつぶさず通知。挿入自体は成功しているので継続)
      const { error } = await supabase.rpc("bunrei_increment_usage", { p_id: row.id });
      if (error) {
        console.error("文例の使用回数更新に失敗:", error.message);
        toast.error(`文例の使用回数更新に失敗: ${error.message}`);
      }
    },
    [currentText, multiline, onInsert, supabase]
  );

  const handleSaveAsBunrei = useCallback(async () => {
    const text = currentText.trim();
    if (!text) {
      toast.error("保存する内容が空です");
      return;
    }
    if (!tenantId) {
      toast.error("事業所情報が取得できないため保存できません");
      return;
    }
    setSaving(true);
    const { data, error } = await supabase
      .from("bunrei_master")
      .insert({
        tenant_id: tenantId,
        category,
        care_level: null,
        text,
        is_builtin: false,
      })
      .select("id, category, care_level, text, usage_count, is_builtin")
      .single();
    setSaving(false);
    if (error) {
      if (error.code === "23505") {
        toast.error("同じ文例が既に登録されています");
      } else {
        console.error("文例の保存に失敗:", error.message);
        toast.error(`文例の保存に失敗: ${error.message}`);
      }
      return;
    }
    setRows((prev) => [data as BunreiRow, ...prev]);
    toast.success("文例に保存しました");
  }, [currentText, tenantId, category, supabase]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`文例データベースから挿入 (${category})`}
        className={cn(
          "inline-flex items-center gap-1 px-2 py-0.5 rounded border border-amber-200 bg-amber-50 text-xs font-medium text-amber-700 hover:bg-amber-100 active:scale-95 transition-all",
          buttonClassName
        )}
      >
        <BookOpen size={11} />
        文例
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-lg rounded-t-2xl sm:rounded-2xl bg-white shadow-xl max-h-[75vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b px-4 py-3 sticky top-0 bg-white space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-bold text-gray-900">
                  文例を選択
                  <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700">
                    {category}
                  </span>
                </h3>
                <button
                  onClick={() => setOpen(false)}
                  className="text-gray-400 active:text-gray-600 p-1"
                >
                  <X size={18} />
                </button>
              </div>
              <div className="relative">
                <Search
                  size={14}
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"
                />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="文例を検索 (本文・要介護度)"
                  className="w-full rounded-lg border border-gray-300 pl-8 pr-2 py-1.5 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
                />
              </div>
            </div>

            <div className="flex-1 overflow-auto p-3">
              {tableMissing ? (
                <p className="text-center text-sm text-gray-500 py-6">
                  文例データベースが未セットアップです。
                  <br />
                  <span className="text-xs text-gray-400">
                    (migrations/bunrei_master.sql を適用し、seed_bunrei.mjs で初期文例を投入してください)
                  </span>
                </p>
              ) : loading ? (
                <div className="flex justify-center py-6">
                  <Loader2 size={18} className="animate-spin text-gray-400" />
                </div>
              ) : filtered.length === 0 ? (
                <p className="text-center text-sm text-gray-400 py-6">
                  {query.trim() ? "検索に一致する文例がありません" : "このカテゴリの文例がありません"}
                </p>
              ) : (
                <div className="space-y-2">
                  {filtered.map((r) => (
                    <button
                      key={r.id}
                      onClick={() => handleSelect(r)}
                      className="w-full text-left px-3 py-2.5 rounded-xl border border-gray-200 hover:bg-amber-50 hover:border-amber-300 active:scale-98 transition-all"
                    >
                      <div className="text-sm text-gray-800 whitespace-pre-wrap">{r.text}</div>
                      <div className="mt-1 flex items-center gap-2">
                        {r.care_level && (
                          <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">
                            {r.care_level}
                          </span>
                        )}
                        {!r.is_builtin && (
                          <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                            自事業所
                          </span>
                        )}
                        {r.usage_count > 0 && (
                          <span className="text-[10px] text-gray-400">
                            使用 {r.usage_count} 回
                          </span>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {!tableMissing && (
              <div className="border-t px-4 py-2.5 bg-gray-50 flex items-center justify-between gap-2">
                <p className="text-[11px] text-gray-400">
                  クリックで末尾に挿入します
                </p>
                <button
                  type="button"
                  onClick={handleSaveAsBunrei}
                  disabled={saving || !currentText.trim()}
                  title="現在入力中の内容をこのカテゴリの文例として保存"
                  className="inline-flex items-center gap-1 rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-40 transition-all"
                >
                  {saving ? <Loader2 size={11} className="animate-spin" /> : <BookOpen size={11} />}
                  この内容を文例に保存
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
