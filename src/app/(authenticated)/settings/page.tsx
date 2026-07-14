"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Settings, Eye, EyeOff, Building2, ChevronRight, Copy, Database, Timer } from "lucide-react";
import Link from "next/link";
import { useBusinessType } from "@/lib/business-type-context";
import {
  getShogaiTimeBracketMode,
  setShogaiTimeBracketMode,
  SHOGAI_TIME_BRACKET_LABELS,
  type ShogaiTimeBracketMode,
} from "@/lib/shogai-time-bracket";

// ─── 年度別 居宅介護支援費 単位数 (廃止) ──────────────────────────────────
// 2026-07-08 総点検: レセプト生成は kaigo_care_support_rates (年度キー) を参照せず
// kaigo_service_codes の対象月有効世代 (validInMonth) から解決するようになったため、
// この画面の「年度別 居宅介護支援費 単位数」節は削除。単位の世代管理は
// /master/service-codes で行う。

// ─── 年度別特定事業所加算 (廃止) ──────────────────────────────────────────
// 2026-07-08 総点検: 特定事業所加算の単位は kaigo_tokutei_kassan_rates (年度キー) を
// やめ、kaigo_service_codes (434002〜434006) の対象月有効世代 (validInMonth) から
// 解決するようになったため、この画面の「年度別 特定事業所加算 単位数」節は削除。
// 単位の世代管理は /master/service-codes で行う。

// ─── Main ────────────────────────────────────────────────────────────────────

// ─── 自事業所切替 ──────────────────────────────────────────────────────────

function OfficeSwitcher() {
  const { offices, currentOfficeId, setCurrentOfficeId, currentOffice } = useBusinessType();
  const typeLabel = (bt: string) =>
    bt === "care_manager" || bt === "居宅介護支援" ? "居宅介護支援"
    : bt === "home_care" || bt === "訪問介護" ? "訪問介護"
    : bt === "day_service" || bt === "通所介護" ? "通所介護"
    : bt;
  const shareUrl = typeof window !== "undefined" && currentOfficeId
    ? `${window.location.origin}/dashboard?office=${currentOfficeId}`
    : "";

  if (offices.length === 0) {
    return (
      <div className="rounded-lg border bg-yellow-50 p-4 max-w-lg">
        <p className="text-sm text-yellow-800">自事業所が登録されていません。下の「自事業所管理」から追加してください。</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-white p-5 shadow-sm max-w-2xl">
      <div className="flex items-center gap-2 mb-3">
        <Building2 size={18} className="text-blue-600" />
        <h2 className="font-semibold text-gray-900">自事業所を選択</h2>
      </div>
      <p className="text-xs text-gray-500 mb-3">
        現在操作している自事業所を選択します。事業種別（居宅介護支援／訪問介護）は事業所ごとに設定され、切り替えると自動的に追従します。
        <br />
        <span className="text-gray-400">※ 事業種別を変更したい場合は「マスタ管理 → 自事業所管理」で事業所ごとに設定してください。</span>
      </p>
      {/* service_type 別にグループ化 */}
      <div className="space-y-4">
        {(() => {
          // 表示順序: 居宅介護支援 → 訪問介護 → 訪問入浴 → 訪問看護 → その他
          const groupOrder: string[] = ["居宅介護支援", "訪問介護", "訪問入浴", "訪問看護"];
          const grouped = new Map<string, typeof offices>();
          for (const o of offices) {
            const key = o.service_type ?? "その他";
            if (!grouped.has(key)) grouped.set(key, []);
            grouped.get(key)!.push(o);
          }
          const orderedKeys = [
            ...groupOrder.filter((k) => grouped.has(k)),
            ...Array.from(grouped.keys()).filter((k) => !groupOrder.includes(k)),
          ];
          return orderedKeys.map((typeKey) => {
            const list = grouped.get(typeKey) ?? [];
            return (
              <section key={typeKey}>
                <h3 className="text-xs font-semibold text-gray-500 mb-1.5 px-1">
                  {typeLabel(typeKey)}事業所 <span className="text-gray-400">({list.length})</span>
                </h3>
                <div className="space-y-2">
                  {list.map((o) => {
                    const isCurrent = o.id === currentOfficeId;
                    return (
                      <label
                        key={o.id}
                        className={`flex items-center gap-3 px-3 py-1.5 rounded-lg border cursor-pointer transition-all ${
                          isCurrent ? "border-blue-500 bg-blue-50" : "border-gray-200 hover:bg-gray-50"
                        }`}
                      >
                        <input
                          type="radio"
                          name="office"
                          checked={isCurrent}
                          onChange={() => setCurrentOfficeId(o.id)}
                          className="accent-blue-600"
                        />
                        <div className="flex-1 flex items-center gap-3 min-w-0">
                          <span className="text-sm font-semibold text-gray-900 truncate">{o.name || "(名称未設定)"}</span>
                          <span className="ml-auto flex items-center gap-2 text-xs text-gray-500 shrink-0 tabular-nums">
                            {!o.is_active && <span className="text-red-500">停止中</span>}
                            {o.business_number && <span>事業所番号: {o.business_number}</span>}
                          </span>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </section>
            );
          });
        })()}
      </div>
      {currentOffice && (
        <div className="mt-4 pt-3 border-t">
          <p className="text-xs text-gray-500 mb-1">共有用URL（別事業所として開く）</p>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={shareUrl}
              className="flex-1 text-xs bg-gray-50 border rounded px-2 py-1.5 text-gray-600"
            />
            <button
              onClick={() => { navigator.clipboard.writeText(shareUrl); toast.success("URLをコピーしました"); }}
              className="shrink-0 p-1.5 rounded hover:bg-gray-100"
            >
              <Copy size={14} className="text-gray-500" />
            </button>
          </div>
          <p className="text-[10px] text-gray-400 mt-1">このURLを開くと、選択中の自事業所として操作できます</p>
        </div>
      )}
    </div>
  );
}

// ─── 障害 時間区分判定モード ─────────────────────────────────────────────────
// 60分ちょうどの予定を 身体1.0 (ほのぼの互換) と 身体1.5 (告示準拠) の
// どちらの候補にするか。予定/実績のサービスコード選択の候補絞り込みに効く。

function ShogaiTimeBracketCard() {
  const [mode, setMode] = useState<ShogaiTimeBracketMode | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getShogaiTimeBracketMode(createClient()).then((m) => {
      if (!cancelled) setMode(m);
    });
    return () => { cancelled = true; };
  }, []);

  const save = async (next: ShogaiTimeBracketMode) => {
    const prev = mode;
    setMode(next);
    setSaving(true);
    try {
      await setShogaiTimeBracketMode(createClient(), next);
      toast.success(`障害の時間区分判定を「${SHOGAI_TIME_BRACKET_LABELS[next]}」に変更しました`);
    } catch (err) {
      setMode(prev);
      toast.error(`保存失敗: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border bg-white p-5 shadow-sm max-w-2xl">
      <div className="flex items-center gap-2 mb-1">
        <Timer size={18} className="text-emerald-600" />
        <h2 className="font-semibold text-gray-900">障害福祉: 時間区分の判定モード</h2>
      </div>
      <p className="text-xs text-gray-500 mb-3">
        60分ちょうどの予定 (例 19:00〜20:00) をどの時間区分コードの候補にするかを切り替えます。
        告示原文は「30分以上1時間未満=1.0 / 1時間以上=1.5」ですが、ほのぼのMORE は 60分→1.0 に自動割当していました。
        <br />
        <span className="text-gray-400">※ 介護保険 (訪問介護 身体介護N) の判定は従来どおり告示準拠のまま変わりません。</span>
      </p>
      <div className="space-y-2">
        {(["honobono", "kokuji"] as const).map((m) => (
          <label
            key={m}
            className={`flex items-center gap-3 px-3 py-2 rounded-lg border cursor-pointer transition-all ${
              mode === m ? "border-emerald-500 bg-emerald-50" : "border-gray-200 hover:bg-gray-50"
            } ${mode === null || saving ? "opacity-60 pointer-events-none" : ""}`}
          >
            <input
              type="radio"
              name="shogai-time-bracket"
              checked={mode === m}
              onChange={() => save(m)}
              className="accent-emerald-600"
            />
            <div className="min-w-0">
              <span className="text-sm font-semibold text-gray-900">
                {SHOGAI_TIME_BRACKET_LABELS[m]}
                {m === "honobono" && <span className="ml-2 text-[10px] font-normal text-gray-400">デフォルト</span>}
              </span>
              <p className="text-[11px] text-gray-500">
                {m === "honobono"
                  ? "ほのぼのと同じ単位数で請求が続く (現行踏襲・安全側)"
                  : "告示の文言どおり。同じ60分予定で1区分上がる (増収方向。切替前に市町村へ照会推奨)"}
              </p>
            </div>
          </label>
        ))}
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const supabase = createClient();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!currentPassword) {
      toast.error("現在のパスワードを入力してください");
      return;
    }
    if (newPassword.length < 6) {
      toast.error("新しいパスワードは6文字以上で入力してください");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("新しいパスワードが一致しません");
      return;
    }

    setLoading(true);
    try {
      // Verify current password by attempting sign-in
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user?.email) {
        toast.error("ユーザー情報の取得に失敗しました");
        return;
      }

      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: user.email,
        password: currentPassword,
      });
      if (signInError) {
        toast.error("現在のパスワードが正しくありません");
        return;
      }

      // Update password
      const { error: updateError } = await supabase.auth.updateUser({
        password: newPassword,
      });
      if (updateError) {
        toast.error(`パスワードの変更に失敗しました: ${updateError.message}`);
        return;
      }

      toast.success("パスワードを変更しました");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "エラーが発生しました";
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">設定</h1>
        <p className="mt-1 text-sm text-gray-500">
          アカウント設定・事業所設定・パスワード変更
        </p>
      </div>

      {/* 自事業所切替 */}
      <OfficeSwitcher />

      {/* 障害 時間区分判定モード */}
      <ShogaiTimeBracketCard />

      {/* Office Settings Link */}
      <Link
        href="/master/offices?tab=group"
        className="flex items-center justify-between rounded-lg border bg-white p-5 shadow-sm hover:shadow-md transition-shadow max-w-lg"
      >
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-purple-50 p-2.5">
            <Building2 size={20} className="text-purple-600" />
          </div>
          <div>
            <h2 className="font-semibold text-gray-900">自事業所管理</h2>
            <p className="text-xs text-gray-500">複数の自事業所の登録・編集・切替</p>
          </div>
        </div>
        <ChevronRight size={18} className="text-gray-400" />
      </Link>

      {/* Data Export Link */}
      <Link
        href="/settings/data-export"
        className="flex items-center justify-between rounded-lg border bg-white p-5 shadow-sm hover:shadow-md transition-shadow max-w-lg"
      >
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-blue-50 p-2.5">
            <Database size={20} className="text-blue-600" />
          </div>
          <div>
            <h2 className="font-semibold text-gray-900">データエクスポート</h2>
            <p className="text-xs text-gray-500">全データを CSV / JSON で一括出力 (移行容易性・BCP バックアップ)</p>
          </div>
        </div>
        <ChevronRight size={18} className="text-gray-400" />
      </Link>

      {/* Password Change Card */}
      <div className="rounded-lg border bg-white p-6 shadow-sm max-w-lg">
        <div className="flex items-center gap-2 mb-6">
          <Settings size={20} className="text-gray-600" />
          <h2 className="text-lg font-semibold text-gray-900">
            パスワード変更
          </h2>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Current Password */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              現在のパスワード
            </label>
            <div className="relative">
              <input
                type={showCurrent ? "text" : "password"}
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="w-full rounded-md border px-3 py-2 pr-10 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="現在のパスワードを入力"
              />
              <button
                type="button"
                onClick={() => setShowCurrent(!showCurrent)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                {showCurrent ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          {/* New Password */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              新しいパスワード
            </label>
            <div className="relative">
              <input
                type={showNew ? "text" : "password"}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full rounded-md border px-3 py-2 pr-10 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="6文字以上の新しいパスワード"
              />
              <button
                type="button"
                onClick={() => setShowNew(!showNew)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                {showNew ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          {/* Confirm Password */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              新しいパスワード（確認）
            </label>
            <div className="relative">
              <input
                type={showConfirm ? "text" : "password"}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full rounded-md border px-3 py-2 pr-10 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="新しいパスワードを再入力"
              />
              <button
                type="button"
                onClick={() => setShowConfirm(!showConfirm)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                {showConfirm ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          {/* Submit */}
          <div className="pt-2">
            <button
              type="submit"
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? "変更中..." : "パスワードを変更"}
            </button>
          </div>
        </form>
      </div>

    </div>
  );
}
