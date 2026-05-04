"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { FileText, X } from "lucide-react";
import { cn } from "@/lib/utils";

type Template = { id: string; category: string; label: string; content: string };

interface TemplatePickerProps {
  // どのカテゴリのテンプレートを出すか
  category: "visit_record" | "support_record";
  // 現在のテキスト値（参考）
  currentText?: string;
  // 選択時のコールバック（新テキスト全体を返す）
  onInsert: (newText: string) => void;
  // ボタンの外観オプション
  buttonClassName?: string;
  /**
   * 未認証経路（/support/[token] / /staff-availability/[token] 等）から
   * service_role API 経由で取得する場合の URL。
   * 例: `/api/support/${token}/templates`
   * 指定された場合 `${fetchUrl}?category=${category}` に GET し、
   * `{ templates: Template[] }` を期待する。
   */
  fetchUrl?: string;
  /**
   * @deprecated kaigo_record_templates は Phase 2-5-09 以降 authenticated 限定。
   * anon=true 経路は 0 件しか返らない既存バグ。fetchUrl を使うこと。
   * Phase 2-6c で staff-availability/[token]/page.tsx を移行したら削除。
   */
  anon?: boolean;
}

// モジュールレベルキャッシュ（全箇所で共有、fetchUrl 別にキャッシュ）
const __templatesCache = new Map<string, Template[]>();
const __templatesLoading = new Map<string, Promise<void>>();

async function loadTemplates(opts: { anon: boolean; fetchUrl?: string; category: string }): Promise<Template[]> {
  const cacheKey = opts.fetchUrl ? `${opts.fetchUrl}?category=${opts.category}` : (opts.anon ? "__anon__" : "__authed__");
  const cached = __templatesCache.get(cacheKey);
  if (cached) return cached;
  const inflight = __templatesLoading.get(cacheKey);
  if (inflight) { await inflight; return __templatesCache.get(cacheKey) ?? []; }

  const promise = (async () => {
    let templates: Template[];
    if (opts.fetchUrl) {
      const url = `${opts.fetchUrl}?category=${encodeURIComponent(opts.category)}`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        templates = [];
      } else {
        const json = (await res.json()) as { templates?: Template[] };
        templates = json.templates ?? [];
      }
    } else {
      let client;
      if (opts.anon) {
        const { createBrowserClient } = await import("@supabase/ssr");
        client = createBrowserClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
        );
      } else {
        client = createClient();
      }
      const { data } = await client.from("kaigo_record_templates")
        .select("id, category, label, content")
        .order("sort_order");
      templates = (data || []) as Template[];
    }
    __templatesCache.set(cacheKey, templates);
  })();
  __templatesLoading.set(cacheKey, promise);
  await promise;
  __templatesLoading.delete(cacheKey);
  return __templatesCache.get(cacheKey) ?? [];
}

export function clearTemplateCache() { __templatesCache.clear(); }

export function TemplatePicker({
  category,
  currentText = "",
  onInsert,
  buttonClassName,
  fetchUrl,
  anon = false,
}: TemplatePickerProps) {
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<Template[]>([]);

  useEffect(() => {
    if (open && templates.length === 0) {
      loadTemplates({ anon, fetchUrl, category }).then(setTemplates);
    }
  }, [open, templates.length, anon, fetchUrl, category]);

  // カテゴリ一致 + common
  const filtered = useMemo(
    () => templates.filter((t) => t.category === category || t.category === "common"),
    [templates, category]
  );

  const handleSelect = useCallback((tpl: Template) => {
    // 既存テキストの末尾に追加（空ならそのまま置換）
    const newText = currentText.trim() ? `${currentText}\n${tpl.content}` : tpl.content;
    onInsert(newText);
    setOpen(false);
  }, [currentText, onInsert]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "inline-flex items-center gap-1 px-2 py-0.5 rounded border border-blue-200 bg-blue-50 text-xs font-medium text-blue-700 hover:bg-blue-100 active:scale-95 transition-all",
          buttonClassName
        )}
      >
        <FileText size={11} />
        定型文
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-t-2xl sm:rounded-2xl bg-white shadow-xl max-h-[70vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b px-4 py-3 sticky top-0 bg-white">
              <h3 className="text-base font-bold text-gray-900">定型文を選択</h3>
              <button onClick={() => setOpen(false)} className="text-gray-400 active:text-gray-600 p-1">
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-3">
              {filtered.length === 0 ? (
                <p className="text-center text-sm text-gray-400 py-6">定型文が登録されていません</p>
              ) : (
                <div className="space-y-2">
                  {filtered.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => handleSelect(t)}
                      className="w-full text-left px-3 py-2.5 rounded-xl border border-gray-200 hover:bg-blue-50 hover:border-blue-300 active:scale-98 transition-all"
                    >
                      <div className="text-xs font-bold text-blue-700 mb-0.5">{t.label}</div>
                      <div className="text-sm text-gray-800 whitespace-pre-wrap">{t.content}</div>
                    </button>
                  ))}
                </div>
              )}
              <p className="text-xs text-gray-400 text-center mt-3">
                マスタ管理 → 定型文 で追加・編集できます
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
