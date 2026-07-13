"use client";

/**
 * 過誤申立ブロック — 介護請求タブ右ペイン (明細情報) 内
 *
 * 過誤 = 一度支払われたレセプトを事後に取り下げる手続き。
 *   事業所 → 保険者へ過誤申立 (様式は保険者ごと) → 保険者 → 国保連 (1731)
 *   → 国保連が過誤決定 (支払控除。1711) → 必要なら正しい内容で再請求。
 *
 * このブロックで「申立を登録」すると kago=true + kokuho_target=false (取下げ)
 * となり、翌月以降の請求画面に再請求候補として合流する (re-seikyu と同じ流れ)。
 *   - 通常過誤: 過誤決定 (支払控除) を確認してから国保対象化 (翌月以降に再請求)
 *   - 同月過誤: 過誤申立と同月に再請求を伝送 (保険者が対応している場合のみ)
 *
 * 再請求行 (過去月からの合流) では読み取り専用の申立サマリを表示する。
 */

import { useState } from "react";
import { AlertCircle, Loader2, Undo2 } from "lucide-react";
import {
  KAGO_DEFAULT_RIYU,
  KAGO_DEFAULT_YOSHIKI,
  KAGO_RIYU_CODES,
  KAGO_YOSHIKI_CODES,
  kagoJiyuCodeLabel,
  splitKagoJiyuCode,
  toggleDougetsuRiyu,
  type KagoInfo,
} from "@/lib/visit-seikyu/kago";

export interface KagoSaveFields {
  moushitateDate: string; // YYYY-MM-DD
  jiyuCode: string; // 4桁
  dougetsu: boolean;
}

interface Props {
  /** この行の提供月 (YYYY-MM) */
  targetMonth: string;
  /** 現在の過誤状態 (kago フラグ + 付帯情報)。行レコード無しは null */
  kago: boolean;
  kagoInfo: KagoInfo | null;
  /** 現在 国保対象 (kokuho_target=true) か — 申立登録で解除される旨の案内用 */
  kokuhoTarget: boolean;
  /** kago_* 列が未適用 (migrations/kago_saiseikyu.sql 未実行) */
  colsMissing: boolean;
  /** 再請求行 (元提供月データ) は読み取り専用 */
  readOnly: boolean;
  onSave: (f: KagoSaveFields) => Promise<void>;
  onClear: () => Promise<void>;
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function KagoBlock({
  targetMonth,
  kago,
  kagoInfo,
  kokuhoTarget,
  colsMissing,
  readOnly,
  onSave,
  onClear,
}: Props) {
  // 親から key={selectedKey} で remount されるため、初期値は useState 初期化子で十分
  const initial = splitKagoJiyuCode(kagoInfo?.jiyuCode);
  const [date, setDate] = useState(kagoInfo?.moushitateDate ?? today());
  const [yoshiki, setYoshiki] = useState(initial?.yoshiki ?? KAGO_DEFAULT_YOSHIKI);
  const [riyu, setRiyu] = useState(initial?.riyu ?? KAGO_DEFAULT_RIYU);
  const [dougetsu, setDougetsu] = useState(kagoInfo?.dougetsu ?? false);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  // ── 再請求行: 読み取り専用サマリ + 再請求タイミングの案内 ──
  if (readOnly) {
    if (!kago) return null; // 月遅れ/返戻のみの再請求行には出さない
    return (
      <div className="border-t border-red-300 bg-red-50 shrink-0 px-2 py-1.5 text-[11px]">
        <p className="font-bold text-red-700">過誤の再請求 (提供月 {targetMonth})</p>
        <div className="mt-0.5 text-gray-700 space-y-0.5">
          <p>
            申立日:{" "}
            <span className="font-mono">{kagoInfo?.moushitateDate ?? "未登録"}</span>
            {" / "}
            事由: <span className="font-mono">{kagoInfo?.jiyuCode ?? "未登録"}</span>
            {kagoInfo?.jiyuCode && (
              <span className="text-gray-500"> {kagoJiyuCodeLabel(kagoInfo.jiyuCode)}</span>
            )}
            {kagoInfo?.dougetsu && (
              <span className="ml-1 rounded bg-red-200 px-1 py-0.5 text-[10px] font-bold text-red-800">
                同月過誤
              </span>
            )}
          </p>
          <p className="text-red-700">
            {kagoInfo?.dougetsu
              ? "同月過誤: 過誤申立と同月に再請求を伝送します (保険者が同月過誤に対応している場合のみ)。"
              : "通常過誤: 保険者の過誤決定 (支払控除) を確認してから国保対象化してください (決定の翌月以降に再請求)。"}
          </p>
        </div>
      </div>
    );
  }

  // ── 当月行: 申立の登録・解除フォーム ──
  return (
    <div className="border-t border-gray-300 bg-gray-50 shrink-0 px-2 py-1.5 text-[11px]">
      <div className="flex items-center gap-2">
        <span className="font-bold text-gray-700">過誤申立</span>
        {colsMissing && (
          <span
            title="migrations/kago_saiseikyu.sql を Supabase SQL Editor で適用すると申立日・事由コード・同月過誤を記録できます"
            className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700"
          >
            SQL未適用
          </span>
        )}
        {kago && (
          <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-bold text-red-700">
            過誤申立中
          </span>
        )}
      </div>

      {kago && kagoInfo && (kagoInfo.moushitateDate || kagoInfo.jiyuCode) && (
        <p className="mt-0.5 text-gray-600">
          登録済: 申立日 <span className="font-mono">{kagoInfo.moushitateDate ?? "-"}</span>
          {" / "}事由 <span className="font-mono">{kagoInfo.jiyuCode ?? "-"}</span>
          {kagoInfo.dougetsu ? " / 同月過誤" : ""}
        </p>
      )}

      <div className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1 text-gray-700">
        <span>申立日</span>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          disabled={busy || colsMissing}
          className="border border-gray-300 bg-white px-1 py-0.5 text-[11px] leading-4 disabled:opacity-50"
        />
        <span>様式番号</span>
        <select
          value={yoshiki}
          onChange={(e) => setYoshiki(e.target.value)}
          disabled={busy || colsMissing}
          title="取下げを行う請求明細書の様式番号 (サービス種類コードではありません)"
          className="border border-gray-300 bg-white px-1 py-0.5 text-[11px] leading-4 disabled:opacity-50"
        >
          {KAGO_YOSHIKI_CODES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.code}: {c.label}
            </option>
          ))}
        </select>
        <span>申立理由</span>
        <select
          value={riyu}
          onChange={(e) => {
            const next = e.target.value;
            setRiyu(next);
            // 選んだ理由が同月系/通常系なら同月チェックも追従させる
            const def = KAGO_RIYU_CODES.find((c) => c.code === next);
            if (def) setDougetsu(def.dougetsu);
          }}
          disabled={busy || colsMissing}
          title="申立理由番号 (保険者ごとに使用範囲が異なります。提出前に保険者の一覧で確認してください)"
          className="border border-gray-300 bg-white px-1 py-0.5 text-[11px] leading-4 disabled:opacity-50"
        >
          {KAGO_RIYU_CODES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.code}: {c.label}
            </option>
          ))}
        </select>
        <span>同月過誤</span>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={dougetsu}
            onChange={(e) => {
              const next = e.target.checked;
              setDougetsu(next);
              // 02↔12 / 45↔4C / 46↔4D の対応コードに付け替え (対応が無ければ据置)
              setRiyu((cur) => toggleDougetsuRiyu(cur, next));
            }}
            disabled={busy || colsMissing}
          />
          <span className="text-gray-500">
            申立と再請求を同月処理 (保険者が対応している場合のみ)
          </span>
        </label>
      </div>

      <div className="mt-1.5 flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            if (!window.confirm(`提供月 ${targetMonth} の過誤申立を登録します。\nこの行は国保対象から外れます (取下げ)。よろしいですか？`)) return;
            run(() => onSave({ moushitateDate: date, jiyuCode: `${yoshiki}${riyu}`, dougetsu }));
          }}
          disabled={busy || colsMissing || !date}
          title="過誤フラグを立て、国保対象から外します (取下げ)。翌月以降の請求画面に再請求候補として合流します"
          className="border border-red-500 rounded bg-red-500 px-2.5 py-1 text-white font-semibold hover:bg-red-600 flex items-center gap-1 disabled:opacity-50"
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : <AlertCircle size={11} />}
          申立を登録 (取下げ)
        </button>
        {kago && (
          <button
            type="button"
            onClick={() => {
              if (!window.confirm("過誤申立を解除します (フラグと申立情報を消去)。よろしいですか？")) return;
              run(onClear);
            }}
            disabled={busy}
            title="過誤フラグと申立情報を解除します (国保対象は自動では戻しません。必要ならツールバーの「国保対象」で再度対象化してください)"
            className="border border-gray-400 rounded bg-white px-2.5 py-1 text-gray-700 hover:bg-gray-50 flex items-center gap-1 disabled:opacity-50"
          >
            <Undo2 size={11} />
            解除
          </button>
        )}
      </div>

      <p className="mt-1 text-[10px] text-gray-500 leading-relaxed">
        過誤 = 支払済レセプトの取下げ。保険者へ過誤申立 (様式は保険者ごと) →
        国保連が過誤決定 (支払額から控除) → 正しい内容で再請求。
        登録するとこの行は国保対象から外れ、
        <strong className="text-gray-700">翌月以降の請求画面に「過誤」バッジ付きで合流</strong>します。
        通常過誤は過誤決定通知を確認してから、同月過誤は申立と同月に、国保対象化 (再請求の伝送) してください。
        {kokuhoTarget && (
          <span className="text-red-600"> ※ この行は現在 国保対象です。登録すると解除されます。</span>
        )}
      </p>
    </div>
  );
}
