"use client";

// 利用者ごとの「優先ヘルパー」設定モーダル (最小限 UI)。
// シフト管理 > 利用者カレンダーのヘッダーにある小さな ★ ボタンから開く。
// 保存先: client_office_assignments.preferred_staff (利用者 × 自事業所、優先順の members.id 配列)。
// migration (migrations/preferred_staff.sql) 未適用の環境では保存不可の案内を出す。

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Loader2, Save, Star, X } from "lucide-react";
import { StaffCombobox } from "@/components/shared/staff-combobox";
import {
  fetchPreferredStaffIds,
  savePreferredStaffIds,
  PREFERRED_STAFF_MAX,
} from "@/lib/staff-suggest";
import type { KaigoStaff } from "./_shared";

interface PreferredStaffModalProps {
  userId: string;
  userName: string;
  staff: KaigoStaff[];
  onClose: () => void;
}

export function PreferredStaffModal({ userId, userName, staff, onClose }: PreferredStaffModalProps) {
  const supabase = useMemo(() => createClient(), []);
  const { currentOfficeId } = useBusinessType();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // 列未適用 (migration 未実行) なら保存不可の案内
  const [supported, setSupported] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ids, setIds] = useState<string[]>([]);
  const [addId, setAddId] = useState("");

  useEffect(() => {
    if (!currentOfficeId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- office 未確定時の表示切替
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const res = await fetchPreferredStaffIds(supabase, userId, currentOfficeId);
      if (cancelled) return;
      setSupported(res.supported);
      if (res.error) {
        console.error("preferred_staff fetch failed:", res.error);
        setLoadError(res.error);
      }
      setIds(res.ids);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [supabase, userId, currentOfficeId]);

  const nameOf = (id: string) =>
    staff.find((s) => s.id === id)?.name ?? "(他事業所/退職済みの職員)";

  const move = (index: number, dir: -1 | 1) => {
    setIds((prev) => {
      const next = [...prev];
      const j = index + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[index], next[j]] = [next[j], next[index]];
      return next;
    });
  };

  const handleAdd = (id: string) => {
    setAddId("");
    if (!id || ids.includes(id)) return;
    if (ids.length >= PREFERRED_STAFF_MAX) {
      toast.error(`優先ヘルパーは最大${PREFERRED_STAFF_MAX}名までです`);
      return;
    }
    setIds((prev) => [...prev, id]);
  };

  const handleSave = async () => {
    if (!currentOfficeId) {
      toast.error("保存には事業所の選択 (?office=) が必要です");
      return;
    }
    setSaving(true);
    const res = await savePreferredStaffIds(supabase, userId, currentOfficeId, ids);
    setSaving(false);
    if (res.error) {
      toast.error("保存に失敗しました: " + res.error);
      return;
    }
    if (res.updated === 0) {
      // active な assignment 行が無い (= 自事業所に未割当) と UPDATE が空振りする
      toast.error("保存できませんでした (この利用者は自事業所に割り当てられていません)");
      return;
    }
    toast.success("優先ヘルパーを保存しました");
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b px-5 py-4">
          <h2 className="flex items-center gap-1.5 font-semibold text-gray-900">
            <Star size={16} className="text-amber-500" />
            優先ヘルパー — {userName}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>
        <div className="p-5 space-y-3">
          <p className="text-xs text-gray-500 leading-relaxed">
            割当サジェストで優先的に候補表示する職員を優先順に登録します (自動割当はしません)。
          </p>
          {!supported && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              優先ヘルパー列が DB 未適用です。migrations/preferred_staff.sql を適用すると設定できます。
            </div>
          )}
          {loadError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              現在の設定の取得に失敗しました: {loadError}
            </div>
          )}
          {loading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 size={18} className="animate-spin text-blue-500" />
            </div>
          ) : (
            <>
              {ids.length === 0 ? (
                <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-gray-400">
                  未設定 (下のセレクトから追加)
                </p>
              ) : (
                <ul className="space-y-1">
                  {ids.map((id, i) => (
                    <li key={id} className="flex items-center gap-2 rounded-lg border px-2 py-1.5">
                      <span className="w-8 shrink-0 text-center text-xs font-bold text-amber-600">{i + 1}位</span>
                      <span className="flex-1 truncate text-sm text-gray-800">{nameOf(id)}</span>
                      <button
                        type="button"
                        onClick={() => move(i, -1)}
                        disabled={i === 0}
                        className="rounded border p-0.5 text-gray-400 hover:text-gray-700 disabled:opacity-30"
                        title="上へ"
                      >
                        <ArrowUp size={12} />
                      </button>
                      <button
                        type="button"
                        onClick={() => move(i, 1)}
                        disabled={i === ids.length - 1}
                        className="rounded border p-0.5 text-gray-400 hover:text-gray-700 disabled:opacity-30"
                        title="下へ"
                      >
                        <ArrowDown size={12} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setIds((prev) => prev.filter((v) => v !== id))}
                        className="rounded border border-red-200 p-0.5 text-red-400 hover:text-red-600"
                        title="削除"
                      >
                        <X size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">職員を追加</label>
                <StaffCombobox
                  value={addId}
                  onChange={handleAdd}
                  placeholder="職員を選択して追加..."
                  options={staff
                    .filter((s) => !ids.includes(s.id))
                    .map((s) => ({
                      id: s.id,
                      name: s.name,
                      furigana: (s as unknown as { furigana?: string | null }).furigana ?? null,
                    }))}
                />
              </div>
            </>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t px-5 py-4">
          <button
            onClick={onClose}
            className="rounded-lg border px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            キャンセル
          </button>
          <button
            onClick={handleSave}
            disabled={saving || loading || !supported || !currentOfficeId}
            className="flex items-center gap-1 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
