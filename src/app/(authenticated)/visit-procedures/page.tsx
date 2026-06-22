"use client";

/**
 * 訪問介護 手順書: 利用者一覧 page (v2)
 *
 * v2 変更:
 *  - 設定ボタン (⚙️) で step 所要時間プルダウン上限を変更
 *  - 各 利用者行に「📋」(= 直近版を複製するため、まずバージョン一覧へ誘導)
 *
 * 表示: 過去に手順書を作成した利用者 (DISTINCT client_name) + バージョン数
 * 操作:
 *  - 利用者名 click → /visit-procedures/clients/[name] (バージョン一覧)
 *  - 「新規利用者」 → モーダルで名前入力 → 新規 doc 作成画面へ
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useMemo } from "react";
import { BookOpen, Plus, AlertCircle, Loader2, User, Settings, Save } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import {
  getClients,
  getStepDurationMax,
  setStepDurationMax,
  getMaxStepMinutesForTenant,
} from "@/lib/visit-procedure/queries";
import type { VisitProcedureClient } from "@/lib/visit-procedure/types";

export default function VisitProceduresClientListPage() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const { businessType, currentOffice, loading: btLoading } = useBusinessType();
  const [clients, setClients] = useState<VisitProcedureClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [showSettings, setShowSettings] = useState(false);

  const tenantId = currentOffice?.tenant_id ?? null;
  const officeQuery = currentOffice ? `?office=${encodeURIComponent(currentOffice.id)}` : "";

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- mount-time async fetch (HANDOVER §2) */
    if (btLoading) return;
    if (!tenantId) {
      setLoading(false);
      setClients([]);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const rows = await getClients(supabase, tenantId);
        if (!cancelled) setClients(rows);
      } catch (err) {
        console.error(err);
        toast.error("利用者一覧の読込失敗: " + (err instanceof Error ? err.message : String(err)));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [supabase, tenantId, btLoading]);

  const handleAdd = () => {
    const name = newName.trim();
    if (!name) {
      toast.error("利用者名を入力してください");
      return;
    }
    const sep = officeQuery ? "&" : "?";
    router.push(`/visit-procedures/clients/${encodeURIComponent(name)}/new${officeQuery}${sep}name=${encodeURIComponent(name)}`);
  };

  if (!btLoading && businessType !== "訪問介護") {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-gray-900">手順書</h1>
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-amber-800 flex items-start gap-3">
          <AlertCircle size={20} className="shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">この機能は訪問介護モード専用です</p>
            <p className="text-sm mt-1">サイドバー下部の事業所セレクタから訪問介護の自事業所を選択してください。</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900 flex items-center gap-2">
            <BookOpen size={22} className="text-green-600 shrink-0" />
            手順書
          </h1>
          <p className="mt-1 text-xs sm:text-sm text-gray-500">利用者を選んでバージョン一覧へ</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setShowSettings(true)}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            title="設定"
          >
            <Settings size={16} />
            設定
          </button>
          <button
            onClick={() => { setNewName(""); setShowAdd(true); }}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-green-600 px-3 py-2 text-sm font-medium text-white hover:bg-green-700"
          >
            <Plus size={16} />
            新規利用者
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 text-gray-400">
          <Loader2 size={20} className="animate-spin mr-2" />
          読込中...
        </div>
      ) : clients.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-12 text-center">
          <User size={40} className="mx-auto mb-3 text-gray-300" />
          <p className="text-sm text-gray-500">利用者が登録されていません</p>
          <p className="text-xs text-gray-400 mt-1">右上の「新規利用者」から追加してください</p>
        </div>
      ) : (
        <div className="space-y-2">
          {clients.map((c) => (
            <Link
              key={c.client_name}
              href={`/visit-procedures/clients/${encodeURIComponent(c.client_name)}${officeQuery}`}
              className="block rounded-lg border border-gray-200 bg-white px-3 sm:px-4 py-3 hover:border-green-400 hover:shadow-sm transition"
            >
              {/* 1 行目: 名前 + 版数 (常に表示) */}
              <div className="flex items-center gap-2">
                <User size={16} className="text-gray-400 shrink-0" />
                <span className="font-medium text-gray-900 truncate flex-1 min-w-0">{c.client_name}</span>
                <span className="shrink-0 text-xs rounded-full bg-green-50 text-green-700 px-2 py-0.5">
                  {c.version_count} 版
                </span>
              </div>
              {/* 2 行目: 最新計画日 (右寄せ、小さめ) */}
              <div className="mt-1 text-[11px] text-gray-500 text-right">
                最新計画: {c.latest_plan_start_date}
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* 新規利用者 modal */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setShowAdd(false)}>
          <div className="bg-white rounded-lg p-5 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold text-gray-900 mb-3">新規利用者</h2>
            <label className="text-xs text-gray-500 mb-1 block">利用者名 *</label>
            <input
              type="text"
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
              className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
              placeholder="例: 溝渕 幸子"
            />
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setShowAdd(false)} className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded">
                キャンセル
              </button>
              <button onClick={handleAdd} className="inline-flex items-center gap-1 rounded bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-700">
                <Plus size={14} />
                作成して編集へ
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 設定 modal */}
      {showSettings && (
        <SettingsModal supabase={supabase} tenantId={tenantId} onClose={() => setShowSettings(false)} />
      )}
    </div>
  );
}

// =====================================================================
// 設定 modal (step 所要時間プルダウン上限)
// =====================================================================
function SettingsModal({
  supabase,
  tenantId,
  onClose,
}: {
  supabase: ReturnType<typeof createClient>;
  tenantId: string | null;
  onClose: () => void;
}) {
  const [currentMax, setCurrentMax] = useState<number>(60);
  const [usedMax, setUsedMax] = useState<number>(0);
  const [draftMax, setDraftMax] = useState<number>(60);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
     
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const max = await getStepDurationMax(supabase);
        if (!cancelled) {
          setCurrentMax(max);
          setDraftMax(max);
        }
        if (tenantId) {
          const used = await getMaxStepMinutesForTenant(supabase, tenantId);
          if (!cancelled) setUsedMax(used);
        }
      } catch (err) {
        console.error(err);
        toast.error("設定読込失敗: " + (err instanceof Error ? err.message : String(err)));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
     
  }, [supabase, tenantId]);

  // 5, 10, ..., 240 まで選択肢 (= 4 時間)
  const ALL_OPTIONS: number[] = (() => {
    const out: number[] = [];
    for (let m = 5; m <= 240; m += 5) out.push(m);
    return out;
  })();

  const handleSave = async () => {
    if (draftMax < usedMax) {
      toast.error(`既存値の最大 ${usedMax} 分より低い値には変更できません`);
      return;
    }
    setSaving(true);
    try {
      await setStepDurationMax(supabase, draftMax);
      toast.success("設定を保存しました");
      onClose();
    } catch (err) {
      console.error(err);
      toast.error("保存失敗: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-lg p-5 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-gray-900 mb-3 flex items-center gap-2">
          <Settings size={18} className="text-gray-600" />
          手順書 設定
        </h2>

        {loading ? (
          <div className="flex items-center justify-center py-8 text-gray-400">
            <Loader2 size={18} className="animate-spin mr-2" />
            読込中...
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium text-gray-700 mb-1 block">
                step 所要時間プルダウン 上限
              </label>
              <p className="text-[11px] text-gray-500 mb-2">
                各サービスの step 行で選べる「所要時間 (分)」の最大値。5 分刻み。<br />
                現在使われている最大値: <span className="font-medium tabular-nums">{usedMax} 分</span>
                {usedMax > 0 && <span className="ml-1 text-gray-400">(これ未満には変更できません)</span>}
              </p>
              <select
                value={draftMax}
                onChange={(e) => setDraftMax(Number(e.target.value))}
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm bg-white"
              >
                {ALL_OPTIONS.map((m) => {
                  const disabled = m < usedMax;
                  return (
                    <option key={m} value={m} disabled={disabled}>
                      {m} 分 {disabled ? "(既存値より低いため無効)" : ""}
                    </option>
                  );
                })}
              </select>
              <p className="text-[11px] text-gray-400 mt-1">
                現在の保存値: {currentMax} 分
              </p>
            </div>
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
            onClick={handleSave}
            disabled={saving || loading || draftMax < usedMax}
            className="inline-flex items-center gap-1 rounded bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
