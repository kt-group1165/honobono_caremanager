"use client";

/**
 * サービス開始ゲート (個別予定の登録用)
 *
 * 個別予定を保存する前に、その利用者 × 自事業所のサービスが「開始」
 * (client_office_assignments に end_date IS NULL の行がある) かを確認し、
 * 未開始なら confirm → 開始日入力モーダル → 開始登録 → 保存続行、の流れを担う。
 *
 * 開始登録の書き方は users/[id] の「利用中の自事業所サービス」(toggleOffice) と
 * 同じ: 終了済みの既存行があれば再開 (end_date を NULL に戻す)、無ければ新規 INSERT。
 */

import { useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * サービス開始済みか。
 * true = 開始済 / false = 未開始 / null = 判定不能 (取得失敗。ゲートはスキップ推奨)
 */
export async function isServiceStarted(
  supabase: SupabaseClient,
  clientId: string,
  officeId: string,
): Promise<boolean | null> {
  const { data, error } = await supabase
    .from("client_office_assignments")
    .select("id")
    .eq("client_id", clientId)
    .eq("office_id", officeId)
    .is("end_date", null)
    .limit(1);
  if (error) {
    console.warn("サービス開始状態の確認に失敗 (ゲートをスキップ):", error.message);
    return null;
  }
  return (data ?? []).length > 0;
}

/**
 * サービスを開始する。成功なら null、失敗ならエラーメッセージを返す。
 * 終了済みの既存行があれば最新行を再開 (start_date 更新 + end_date クリア)、
 * 無ければ新規 INSERT (tenant_id は clients から引く)。
 */
export async function startService(
  supabase: SupabaseClient,
  clientId: string,
  officeId: string,
  startDate: string,
): Promise<string | null> {
  const { data: existing, error: exErr } = await supabase
    .from("client_office_assignments")
    .select("id")
    .eq("client_id", clientId)
    .eq("office_id", officeId)
    .order("end_date", { ascending: false })
    .limit(1);
  if (exErr) return exErr.message;

  if (existing && existing.length > 0) {
    const { error } = await supabase
      .from("client_office_assignments")
      .update({ start_date: startDate, end_date: null })
      .eq("id", existing[0].id);
    return error ? error.message : null;
  }

  const { data: clientRow, error: cErr } = await supabase
    .from("clients")
    .select("tenant_id")
    .eq("id", clientId)
    .single();
  if (cErr) return cErr.message;

  const { error } = await supabase.from("client_office_assignments").insert({
    tenant_id: clientRow?.tenant_id ?? "kt-group",
    client_id: clientId,
    office_id: officeId,
    start_date: startDate,
  });
  return error ? error.message : null;
}

/** 開始日入力モーダル。OK でその日付を親に返す (開始登録は親が行う) */
export function ServiceStartModal({
  open,
  userName,
  defaultDate,
  saving,
  onOk,
  onCancel,
}: {
  open: boolean;
  /** 表示用 (null なら省略) */
  userName?: string | null;
  /** 初期値 = 登録しようとしている予定の利用日 */
  defaultDate: string;
  saving: boolean;
  onOk: (startDate: string) => void;
  onCancel: () => void;
}) {
  const [date, setDate] = useState(defaultDate);
  // 開くたびに初期値へ戻す (render 時調整。effect での setState を避ける)
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setDate(defaultDate);
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-lg bg-white p-4 shadow-xl">
        <h3 className="text-sm font-bold text-gray-800">サービス開始日の登録</h3>
        <p className="mt-2 text-xs text-gray-600">
          {userName ? `${userName} さんは` : "この利用者は"}
          自事業所でサービスが開始になっていません。開始日を入力してサービスを開始します。
        </p>
        <label className="mt-3 flex items-center gap-2 text-xs">
          <span className="text-gray-500 shrink-0">開始日:</span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="rounded border border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={() => date && onOk(date)}
            disabled={saving || !date}
            className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? "登録中..." : "開始して予定を保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
