"use client";

/**
 * 請求画面 (介護請求 / 利用請求 / 国保請求 / 月次情報) の共通 Context。
 *
 * これまで各 content が useSeikyuData() を個別に呼んでいたため、タブ切替のたびに
 * 月 state が別々・fetch も別々だった。SeikyuProvider で 1 回だけ useSeikyuData() を
 * 呼び、その戻り値を Context で全タブに配る。これで 4 タブが同じ月・同じ集計結果を
 * 共有し、fetch も 1 回で済む。
 *
 * 加えて order-app の請求画面と同じ「あかさたな索引」カナフィルタを Context で持ち、
 * filteredRows を全タブ共通のカナ絞込済み行として配る
 * (カナ判定 map は order-app MonthlyInfoTab の実装を踏襲)。
 *
 * use-seikyu-data.ts 自体は変更しない (Provider が中で呼ぶだけ)。
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useSeikyuData } from "./use-seikyu-data";
import type { UserSeikyuRow } from "@/lib/visit-seikyu/aggregate";

// ── かな行フィルター (order-app MonthlyInfoTab と同じ判定 map) ────────────────
export const SEIKYU_KANA_ROWS = ["あ", "か", "さ", "た", "な", "は", "ま", "や", "ら", "わ", "他"];
const SEIKYU_KANA_MAP: Record<string, string[]> = {
  "あ": ["ア", "イ", "ウ", "エ", "オ"],
  "か": ["カ", "キ", "ク", "ケ", "コ", "ガ", "ギ", "グ", "ゲ", "ゴ"],
  "さ": ["サ", "シ", "ス", "セ", "ソ", "ザ", "ジ", "ズ", "ゼ", "ゾ"],
  "た": ["タ", "チ", "ツ", "テ", "ト", "ダ", "ヂ", "ヅ", "デ", "ド"],
  "な": ["ナ", "ニ", "ヌ", "ネ", "ノ"],
  "は": ["ハ", "ヒ", "フ", "ヘ", "ホ", "バ", "ビ", "ブ", "ベ", "ボ", "パ", "ピ", "プ", "ペ", "ポ"],
  "ま": ["マ", "ミ", "ム", "メ", "モ"],
  "や": ["ヤ", "ユ", "ヨ"],
  "ら": ["ラ", "リ", "ル", "レ", "ロ"],
  "わ": ["ワ", "ヲ", "ン"],
};
const SEIKYU_ALL_KANA = Object.values(SEIKYU_KANA_MAP).flat();
// ひらがな→カタカナ正規化 (order-app monthlyInfoToKana と同じ)
const seikyuToKana = (s: string) =>
  s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));

type SeikyuContextValue = ReturnType<typeof useSeikyuData> & {
  /** 選択中のかな行 (null = 全) */
  kanaFilter: string | null;
  setKanaFilter: (k: string | null) => void;
  /** 行がカナフィルタに合致するか (再請求行など rows 外の行にも使う) */
  kanaMatches: (r: { user_name_kana: string | null; user_name: string }) => boolean;
  /** カナ絞込済みの rows (各タブはこちらを表示に使う) */
  filteredRows: UserSeikyuRow[];
  /** カナ絞込済みの総合事業 rows (7112/様式(予))。介護給付とは別様式 */
  filteredSougouRows: UserSeikyuRow[];
};

const SeikyuContext = createContext<SeikyuContextValue | null>(null);

export function SeikyuProvider({ children }: { children: ReactNode }) {
  // 集計 hook は Provider で 1 回だけ呼ぶ (全タブが同じ結果を共有)
  const data = useSeikyuData();
  const [kanaFilter, setKanaFilter] = useState<string | null>(null);

  const kanaMatches = useCallback(
    (r: { user_name_kana: string | null; user_name: string }) => {
      if (!kanaFilter) return true;
      const first = seikyuToKana((r.user_name_kana ?? r.user_name).charAt(0));
      return kanaFilter === "他"
        ? !SEIKYU_ALL_KANA.includes(first)
        : (SEIKYU_KANA_MAP[kanaFilter] ?? []).includes(first);
    },
    [kanaFilter],
  );

  const filteredRows = useMemo(
    () => data.rows.filter(kanaMatches),
    [data.rows, kanaMatches],
  );
  const filteredSougouRows = useMemo(
    () => data.sougouRows.filter(kanaMatches),
    [data.sougouRows, kanaMatches],
  );

  const value: SeikyuContextValue = {
    ...data,
    kanaFilter,
    setKanaFilter,
    kanaMatches,
    filteredRows,
    filteredSougouRows,
  };

  return (
    <SeikyuContext.Provider value={value}>{children}</SeikyuContext.Provider>
  );
}

export function useSeikyuContext(): SeikyuContextValue {
  const ctx = useContext(SeikyuContext);
  if (ctx === null) {
    throw new Error(
      "useSeikyuContext は <SeikyuProvider> の内側で呼び出してください",
    );
  }
  return ctx;
}

// ── 左端「あかさたな索引」縦バー (order-app の カナサイドバー と同一クラス) ──
export function SeikyuKanaSidebar() {
  const { kanaFilter, setKanaFilter } = useSeikyuContext();
  return (
    <div className="w-10 shrink-0 border-r border-gray-200 bg-gray-50 flex flex-col items-center py-1 gap-0.5 overflow-y-auto">
      <button
        type="button"
        onClick={() => setKanaFilter(null)}
        className={`w-8 py-1 rounded text-sm font-bold transition-colors ${kanaFilter === null ? "bg-blue-500 text-white" : "hover:bg-gray-200 text-gray-600"}`}
      >
        全
      </button>
      {SEIKYU_KANA_ROWS.map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => setKanaFilter(kanaFilter === k ? null : k)}
          className={`w-8 py-1 rounded text-sm font-medium transition-colors ${kanaFilter === k ? "bg-blue-500 text-white" : "hover:bg-gray-200 text-gray-600"}`}
        >
          {k}
        </button>
      ))}
    </div>
  );
}

// ── 月ナビ (order-app のツールバー月ナビと同一クラス) ────────────────────────
//   square: 月次情報タブの「◀ 2026年 7月 ▶」四角ボタン型
//   box:    介護請求タブの「(◀ R8/6 ▶)」枠ボックス型
export function SeikyuMonthNav({ variant = "box" }: { variant?: "box" | "square" }) {
  const { year, month, onMonthChange } = useSeikyuContext();
  const prev = () =>
    month === 1 ? onMonthChange(year - 1, 12) : onMonthChange(year, month - 1);
  const next = () =>
    month === 12 ? onMonthChange(year + 1, 1) : onMonthChange(year, month + 1);

  if (variant === "square") {
    return (
      <>
        <button
          type="button"
          onClick={prev}
          className="px-2 py-1 rounded bg-white border border-gray-300 hover:bg-gray-50 text-xs"
        >
          ◀
        </button>
        <span className="text-sm font-semibold text-gray-700">
          {year}年 {month}月
        </span>
        <button
          type="button"
          onClick={next}
          className="px-2 py-1 rounded bg-white border border-gray-300 hover:bg-gray-50 text-xs"
        >
          ▶
        </button>
      </>
    );
  }
  return (
    <div className="flex items-center gap-0.5 border border-gray-300 rounded bg-white px-2 py-1">
      <button type="button" onClick={prev} className="text-gray-500 hover:text-gray-800">
        <ChevronLeft size={14} />
      </button>
      <span className="font-semibold text-gray-800 px-1.5">
        R{year - 2018}/{month}
      </span>
      <button type="button" onClick={next} className="text-gray-500 hover:text-gray-800">
        <ChevronRight size={14} />
      </button>
    </div>
  );
}
