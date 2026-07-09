"use client";

// ─── 追加職員セクション (2人体制 + 同行、最大10名) ──────────────────────────
// 主担当を除く「追加職員」を最大9名まで、各自の個別時間つきで登録する共有 UI。
// shift-management (user-calendar / pageEdit) と provision-tickets の両モーダルで再利用。
//
// 折りたたみ UX: 追加が0なら折りたたみ (「＋2人目を追加」ボタン)。1件以上で行リスト表示。
// 各行: 職員セレクタ + 個別時間チェック + 行削除。
//
// 警告: 先頭 (index0=職員2) のみ twoPersonMismatchWarning / staffTimeRelationWarning
//   (障害は抑止) を出す。3人目以降は請求 (2人加算=最大2人) に影響しないため制度警告なし。

import { AlertTriangle, Plus, X } from "lucide-react";
import { StaffCombobox, type StaffOption } from "@/components/shared/staff-combobox";
import {
  staffTimeRelationWarning,
  twoPersonMismatchWarning,
} from "./_shared";

/** フォームが持つ追加職員 1 行の状態 */
export interface AdditionalStaffRow {
  staff_id: string;
  custom: boolean;
  start: string; // "HH:MM"
  end: string; // "HH:MM"
}

export const EMPTY_ADDITIONAL_ROW: AdditionalStaffRow = {
  staff_id: "",
  custom: false,
  start: "",
  end: "",
};

/** 追加職員の最大数 (主1 + 追加9 = 合計10名) */
export const MAX_ADDITIONAL_STAFF = 9;

interface Props {
  /** 追加職員の行配列 (index0=職員2, index1=職員3, …) */
  rows: AdditionalStaffRow[];
  onChange: (rows: AdditionalStaffRow[]) => void;
  /** 選択肢 (呼出側で主担当を除いておく必要はない。内部で重複除外する) */
  staffOptions: StaffOption[];
  /** 主担当の staff_id (選択肢から除外) */
  mainStaffId: string;
  /** 本体時間 (個別時間 ON 時の初期値 + 職員2 の時間関係警告に使用)。"HH:MM" */
  mainStart: string;
  mainEnd: string;
  /** サービス名 (「２人」コード整合チェック用) */
  serviceName: string;
  /** 障害福祉なら時間関係警告を抑止 (制度上 各従業者を別算定) */
  isShogai: boolean;
  /** 個別時間 UI を出すか (staff2_*_time 列が適用済みか)。false でも職員追加は可 */
  showCustomTime: boolean;
  /**
   * 熟練同行 (重度訪問介護の同行支援) チェックの状態。
   * 障害の重訪で 2 人以上のときのみ表示する。未配線 (undefined) なら非表示。
   */
  doukou?: boolean;
  onDoukouChange?: (v: boolean) => void;
  /** 選択中サービスが重度訪問介護か (同行チェック表示条件) */
  serviceIsJudoHoumon?: boolean;
}

export function AdditionalStaffSection({
  rows,
  onChange,
  staffOptions,
  mainStaffId,
  mainStart,
  mainEnd,
  serviceName,
  isShogai,
  showCustomTime,
  doukou,
  onDoukouChange,
  serviceIsJudoHoumon,
}: Props) {
  const addRow = () => {
    if (rows.length >= MAX_ADDITIONAL_STAFF) return;
    onChange([...rows, { ...EMPTY_ADDITIONAL_ROW }]);
  };
  const removeRow = (idx: number) => {
    onChange(rows.filter((_, i) => i !== idx));
  };
  const patchRow = (idx: number, patch: Partial<AdditionalStaffRow>) => {
    onChange(rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  // 折りたたみ: 追加が 0 なら「＋2人目を追加」だけ
  if (rows.length === 0) {
    return (
      <button
        type="button"
        onClick={addRow}
        className="text-xs text-blue-600 hover:underline"
      >
        ＋ 2人目を追加（2人体制）
      </button>
    );
  }

  // 職員2 (先頭) のコード整合警告
  const codeWarn = twoPersonMismatchWarning(serviceName, rows[0]?.staff_id || null);

  // 熟練同行 (重度訪問介護の同行支援): 障害の重訪で 2 人以上のときのみ表示
  const showDoukou = !!(isShogai && serviceIsJudoHoumon && onDoukouChange && rows.length > 0);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="block text-xs font-medium text-gray-500">
          追加職員（2人体制・同行。主 + 最大{MAX_ADDITIONAL_STAFF}名）
        </label>
        <span className="text-[10px] text-gray-400">
          ※ 2人加算は最大2人（3人目以降は記録用）
        </span>
      </div>

      {rows.map((row, idx) => {
        // 同じ職員 (主 + 他の追加行) を選択肢から除外
        const takenIds = new Set<string>([
          mainStaffId,
          ...rows.filter((_, i) => i !== idx).map((r) => r.staff_id),
        ]);
        const options = staffOptions.filter((s) => !takenIds.has(s.id) || s.id === row.staff_id);
        // 職員2 (idx===0) のみ 個別時間の時間関係警告
        const timeWarn =
          idx === 0 && row.custom
            ? staffTimeRelationWarning(mainStart, mainEnd, row.start, row.end, serviceName, isShogai)
            : null;
        return (
          <div
            key={idx}
            className="space-y-2 rounded-lg border border-indigo-100 bg-indigo-50/30 p-3"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-gray-600">職員{idx + 2}</span>
              <button
                type="button"
                onClick={() => removeRow(idx)}
                className="flex items-center gap-0.5 text-xs text-gray-400 hover:text-red-500"
              >
                <X size={12} /> 削除
              </button>
            </div>
            <StaffCombobox
              value={row.staff_id}
              onChange={(id) => patchRow(idx, { staff_id: id })}
              options={options}
            />
            {showCustomTime && row.staff_id && (
              <div className="space-y-2">
                <label className="flex cursor-pointer items-center gap-1.5 text-xs text-gray-600">
                  <input
                    type="checkbox"
                    checked={row.custom}
                    onChange={(e) =>
                      patchRow(
                        idx,
                        e.target.checked
                          ? { custom: true, start: row.start || mainStart, end: row.end || mainEnd }
                          : { custom: false },
                      )
                    }
                    className="h-3.5 w-3.5 accent-indigo-600"
                  />
                  個別時間（この職員の担当時間が本体と異なる）
                </label>
                {row.custom && (
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      type="time"
                      value={row.start}
                      onChange={(e) => patchRow(idx, { start: e.target.value })}
                      className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
                      title={`職員${idx + 2}の開始時間`}
                    />
                    <input
                      type="time"
                      value={row.end}
                      onChange={(e) => patchRow(idx, { end: e.target.value })}
                      className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
                      title={`職員${idx + 2}の終了時間`}
                    />
                  </div>
                )}
                {timeWarn && (
                  <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                    {timeWarn}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      {showDoukou && (
        <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          <input
            type="checkbox"
            checked={!!doukou}
            onChange={(e) => onDoukouChange?.(e.target.checked)}
            className="mt-0.5 h-3.5 w-3.5 accent-emerald-600"
          />
          <span>
            熟練同行（同行支援・2人。所定90%で2人算定）
            <br />
            <span className="text-[10px] text-emerald-700">
              ※ 熟練従業者が新任に同行して重訪提供時。保存時にサービスコードを同行コードへ差し替えます（120時間上限は手動運用）
            </span>
          </span>
        </label>
      )}

      {codeWarn && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          {codeWarn}
        </div>
      )}

      {rows.length < MAX_ADDITIONAL_STAFF && (
        <button
          type="button"
          onClick={addRow}
          className="flex items-center gap-1 text-xs text-blue-600 hover:underline"
        >
          <Plus size={12} /> 職員を追加
        </button>
      )}
    </div>
  );
}

/** VisitSchedule 相当の行から AdditionalStaffRow[] を復元 (編集モーダルの初期値用) */
export function additionalRowsFromSchedule(sched: {
  staff_id_2?: string | null;
  staff_id_3?: string | null;
  staff2_start_time?: string | null;
  staff2_end_time?: string | null;
  staff3_start_time?: string | null;
  staff3_end_time?: string | null;
  additional_staff?: Array<{ staff_id: string; start_time: string | null; end_time: string | null }> | null;
}): AdditionalStaffRow[] {
  const rows: AdditionalStaffRow[] = [];
  if (Array.isArray(sched.additional_staff) && sched.additional_staff.length > 0) {
    for (const a of sched.additional_staff) {
      if (a && a.staff_id) {
        rows.push({
          staff_id: a.staff_id,
          custom: !!a.start_time,
          start: a.start_time?.slice(0, 5) ?? "",
          end: a.end_time?.slice(0, 5) ?? "",
        });
      }
    }
    return rows;
  }
  // フォールバック: 従来列から復元
  if (sched.staff_id_2) {
    rows.push({
      staff_id: sched.staff_id_2,
      custom: !!sched.staff2_start_time,
      start: sched.staff2_start_time?.slice(0, 5) ?? "",
      end: sched.staff2_end_time?.slice(0, 5) ?? "",
    });
  }
  if (sched.staff_id_3) {
    rows.push({
      staff_id: sched.staff_id_3,
      custom: !!sched.staff3_start_time,
      start: sched.staff3_start_time?.slice(0, 5) ?? "",
      end: sched.staff3_end_time?.slice(0, 5) ?? "",
    });
  }
  return rows;
}
