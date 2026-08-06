/**
 * 売上集計結果の端末キャッシュ (localStorage)。
 *
 * ダッシュボードの売上内訳は請求エンジンをそのまま回すので、自事業所で数十往復、
 * 全事業所 (48 事業所) だと数百往復かかる。毎回スピナーで待たされるのを避けるため、
 * **前回の集計結果を即座に描画してから裏で再集計する** (stale-while-revalidate)。
 *
 * ⚠ 金額なので「いつ時点の集計か」を必ず UI に出すこと (cachedAt を返している)。
 *   キャッシュは表示の先出しだけに使い、請求・伝送の判断には使わない。
 */

import type { UriageBreakdown, AllOfficesUriage } from "./aggregate-uriage";

const STORAGE_KEY = "kaigo:uriage-cache:v1";
/** 保持する最大エントリ数 (古い順に捨てる) */
const MAX_ENTRIES = 24;
/** これより古いキャッシュは読まない (7 日) */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface Entry<T> {
  at: number;
  data: T;
}

type Store = Record<string, Entry<unknown>>;

function readStore(): Store {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Store;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // 壊れた JSON / localStorage 無効 — キャッシュ無しとして続行する
    return {};
  }
}

function writeStore(store: Store): void {
  if (typeof window === "undefined") return;
  try {
    // 件数上限: 新しい順に MAX_ENTRIES 件だけ残す
    const kept = Object.entries(store)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX_ENTRIES);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // 容量超過等。キャッシュは無くても動くので握って続行する (機能に影響しない)
  }
}

/** 自事業所 1 ヶ月分のキー */
export function selfUriageKey(officeId: string, year: number, month: number): string {
  return `self:${officeId}:${year}-${String(month).padStart(2, "0")}`;
}

/** 全事業所 1 ヶ月分のキー */
export function allUriageKey(year: number, month: number): string {
  return `all:${year}-${String(month).padStart(2, "0")}`;
}

export function readUriageCache<T>(key: string): { data: T; at: number } | null {
  const e = readStore()[key] as Entry<T> | undefined;
  if (!e || typeof e.at !== "number") return null;
  if (Date.now() - e.at > MAX_AGE_MS) return null;
  return { data: e.data, at: e.at };
}

export function writeUriageCache<T>(key: string, data: T): void {
  const store = readStore();
  store[key] = { at: Date.now(), data };
  writeStore(store);
}

/** 自事業所: 売上 (予定+実績) と 実績確定分 をまとめて 1 エントリで持つ */
export interface SelfUriageCache {
  uriage: UriageBreakdown;
  jisseki: UriageBreakdown;
}

export type AllUriageCache = AllOfficesUriage;

/** 「hh:mm 時点」表記 (同日でなければ M/d hh:mm) */
export function cachedAtLabel(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay ? `${hm} 時点` : `${d.getMonth() + 1}/${d.getDate()} ${hm} 時点`;
}
