"use client";

/**
 * 訪問介護 手順書 まるごと複製 modal (v2)
 *
 * 2 モード:
 *   ○ 同じ利用者の新バージョン (= 計画開始日を指定)
 *   ○ 別の利用者にコピー (= 既存利用者 select または 新規利用者名入力)
 */

import { useEffect, useMemo, useState } from "react";
import { Loader2, Copy, X } from "lucide-react";
import { toast } from "sonner";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  duplicateDocumentToNewVersion,
  duplicateDocumentToAnotherClient,
  getClients,
} from "@/lib/visit-procedure/queries";
import type { VisitProcedureClient } from "@/lib/visit-procedure/types";

type Mode = "new_version" | "other_client";

export function DuplicateDocumentModal({
  supabase,
  sourceId,
  tenantId,
  onClose,
  onDuplicated,
}: {
  supabase: SupabaseClient;
  sourceId: string;
  tenantId: string | null;
  onClose: () => void;
  onDuplicated: (newId: string) => void;
}) {
  const [mode, setMode] = useState<Mode>("new_version");
  const [clients, setClients] = useState<VisitProcedureClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // new_version 用
  const today = useMemo(() => {
    const t = new Date();
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  }, []);
  const [newPlanStart, setNewPlanStart] = useState<string>(today);

  // other_client 用
  const [targetClientName, setTargetClientName] = useState<string>("");
  const [newClientName, setNewClientName] = useState<string>("");
  const [useExisting, setUseExisting] = useState<boolean>(true);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    if (!tenantId) { setLoading(false); return; }
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const rows = await getClients(supabase, tenantId);
        if (!cancelled) setClients(rows);
      } catch (err) {
        console.error(err);
        toast.error("利用者一覧の取得失敗: " + (err instanceof Error ? err.message : String(err)));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [supabase, tenantId]);

  const handleSubmit = async () => {
    setSaving(true);
    try {
      if (mode === "new_version") {
        if (!newPlanStart) {
          toast.error("計画開始日を入力してください");
          return;
        }
        const newId = await duplicateDocumentToNewVersion(supabase, sourceId, newPlanStart);
        toast.success("新バージョンとして複製しました");
        onDuplicated(newId);
      } else {
        const target = useExisting ? targetClientName.trim() : newClientName.trim();
        if (!target) {
          toast.error("コピー先の利用者を選択または入力してください");
          return;
        }
        const newId = await duplicateDocumentToAnotherClient(supabase, sourceId, target);
        toast.success(`「${target}」にコピーしました`);
        onDuplicated(newId);
      }
    } catch (err) {
      console.error(err);
      toast.error("複製失敗: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-lg p-5 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <Copy size={18} className="text-blue-600" />
            手順書を複製
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>

        {/* モード select */}
        <div className="flex gap-2 mb-4">
          <button
            type="button"
            onClick={() => setMode("new_version")}
            className={`flex-1 rounded border px-3 py-2 text-xs ${
              mode === "new_version" ? "border-blue-500 bg-blue-50 text-blue-700 font-medium" : "border-gray-300 text-gray-600 hover:bg-gray-50"
            }`}
          >
            同じ利用者の<br />新バージョン
          </button>
          <button
            type="button"
            onClick={() => setMode("other_client")}
            className={`flex-1 rounded border px-3 py-2 text-xs ${
              mode === "other_client" ? "border-blue-500 bg-blue-50 text-blue-700 font-medium" : "border-gray-300 text-gray-600 hover:bg-gray-50"
            }`}
          >
            別の利用者に<br />コピー
          </button>
        </div>

        {/* 本体 */}
        {mode === "new_version" ? (
          <div className="space-y-2">
            <label className="text-xs text-gray-500 block">新バージョンの計画開始日 *</label>
            <input
              type="date"
              value={newPlanStart}
              onChange={(e) => setNewPlanStart(e.target.value)}
              className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            />
            <p className="text-[11px] text-gray-500">
              元の手順書の内容 (サービス / step / 週次表 / 特記) を丸ごとコピーします。
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex gap-2 text-xs">
              <button
                type="button"
                onClick={() => setUseExisting(true)}
                className={`flex-1 rounded border px-2 py-1 ${
                  useExisting ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-300 text-gray-600"
                }`}
              >
                既存利用者
              </button>
              <button
                type="button"
                onClick={() => setUseExisting(false)}
                className={`flex-1 rounded border px-2 py-1 ${
                  !useExisting ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-300 text-gray-600"
                }`}
              >
                新規利用者名
              </button>
            </div>
            {useExisting ? (
              <div>
                <label className="text-xs text-gray-500 block mb-1">コピー先 利用者 *</label>
                {loading ? (
                  <div className="text-xs text-gray-400 py-2 flex items-center gap-1">
                    <Loader2 size={12} className="animate-spin" />
                    読込中...
                  </div>
                ) : (
                  <select
                    value={targetClientName}
                    onChange={(e) => setTargetClientName(e.target.value)}
                    className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm bg-white"
                  >
                    <option value="">-- 選択 --</option>
                    {clients.map((c) => (
                      <option key={c.client_name} value={c.client_name}>
                        {c.client_name} ({c.version_count} 版)
                      </option>
                    ))}
                  </select>
                )}
              </div>
            ) : (
              <div>
                <label className="text-xs text-gray-500 block mb-1">新しい利用者名 *</label>
                <input
                  type="text"
                  value={newClientName}
                  onChange={(e) => setNewClientName(e.target.value)}
                  placeholder="例: 山田 太郎"
                  className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
                />
              </div>
            )}
            <p className="text-[11px] text-gray-500">
              元の手順書の内容を、指定した利用者の新規手順書としてコピーします。
            </p>
          </div>
        )}

        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded"
            disabled={saving}
          >
            キャンセル
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving}
            className="inline-flex items-center gap-1 rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Copy size={14} />}
            複製を作成
          </button>
        </div>
      </div>
    </div>
  );
}
