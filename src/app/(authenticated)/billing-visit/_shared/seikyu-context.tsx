"use client";

/**
 * 請求画面 (介護請求 / 利用請求 / 国保請求 / 月次情報) の共通 Context。
 *
 * これまで各 content が useSeikyuData() を個別に呼んでいたため、タブ切替のたびに
 * 月 state が別々・fetch も別々だった。SeikyuProvider で 1 回だけ useSeikyuData() を
 * 呼び、その戻り値を Context で全タブに配る。これで 4 タブが同じ月・同じ集計結果を
 * 共有し、fetch も 1 回で済む。
 *
 * use-seikyu-data.ts 自体は変更しない (Provider が中で呼ぶだけ)。
 */

import { createContext, useContext, type ReactNode } from "react";
import { useSeikyuData } from "./use-seikyu-data";

type SeikyuContextValue = ReturnType<typeof useSeikyuData>;

const SeikyuContext = createContext<SeikyuContextValue | null>(null);

export function SeikyuProvider({ children }: { children: ReactNode }) {
  // 集計 hook は Provider で 1 回だけ呼ぶ (全タブが同じ結果を共有)
  const value = useSeikyuData();
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
