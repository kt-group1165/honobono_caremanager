"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";

const DEFAULT_TTL_SECONDS = 60 * 60; // 1 時間

/**
 * Storage path から signed URL を動的に発行する hook (単一 path 用)。
 * 1 年期限の signed URL を DB に直接保存していた v1 の問題を回避するため、表示時に都度発行する。
 *
 * @param path bucket 内 relative path (例: "kt-group/kaigo_visit_records/<uuid>.png")。null の場合は何もしない。
 * @param bucket bucket 名 (default: "signatures")
 * @param ttlSeconds signed URL の有効期限 (default: 3600 = 1 時間)
 * @returns signed URL or null (loading 中 / 失敗時)
 */
export function useSignedUrl(
  path: string | null | undefined,
  bucket = "signatures",
  ttlSeconds: number = DEFAULT_TTL_SECONDS
): string | null {
  // path をキーに保持し、(path, url) ペアで state を持つ。
  // path 切替時に古い url を返さないよう state を path とセットで管理。
  const [state, setState] = useState<{ path: string | null; url: string | null }>({
    path: null,
    url: null,
  });

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { data, error } = await supabase.storage
        .from(bucket)
        .createSignedUrl(path, ttlSeconds);
      if (cancelled) return;
      if (error || !data?.signedUrl) {
        setState({ path, url: null });
        return;
      }
      setState({ path, url: data.signedUrl });
    })();
    return () => {
      cancelled = true;
    };
  }, [path, bucket, ttlSeconds]);

  // path が一致する場合のみ cached url を返す (path 切替後の古い url 漏出を防ぐ)
  return state.path === path ? state.url : null;
}

/**
 * 複数 path を一括で signed URL に変換する hook。Map<path, signedUrl> を返す。
 * 一覧 / 印刷で record 配列に対して使う想定。
 *
 * - 同じ path が複数回呼ばれても 1 回で済むよう dedup する
 * - 失敗した path は Map に entry が無いまま (= 呼出側で fallback 判定可能)
 */
export function useSignedUrls(
  paths: (string | null | undefined)[],
  bucket = "signatures",
  ttlSeconds: number = DEFAULT_TTL_SECONDS
): Map<string, string> {
  // dedup + null 除去
  const uniquePaths = useMemo(() => {
    const set = new Set<string>();
    for (const p of paths) {
      if (p) set.add(p);
    }
    return Array.from(set).sort();
  }, [paths]);

  // dependency stable key
  const key = uniquePaths.join("\n");

  // (key, map) ペアで保持し、key 切替時に古い map を返さないようにする。
  const [state, setState] = useState<{ key: string; map: Map<string, string> }>({
    key: "",
    map: new Map(),
  });

  useEffect(() => {
    if (uniquePaths.length === 0) return;
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const next = new Map<string, string>();
      // Supabase JS には createSignedUrls (複数) もあるが、bucket policy で error になる path 1 個で全体が失敗する
      // ケースを避けるため個別呼出 (Promise.all で並列)
      await Promise.all(
        uniquePaths.map(async (p) => {
          const { data, error } = await supabase.storage
            .from(bucket)
            .createSignedUrl(p, ttlSeconds);
          if (!error && data?.signedUrl) {
            next.set(p, data.signedUrl);
          }
        })
      );
      if (cancelled) return;
      setState({ key, map: next });
    })();
    return () => {
      cancelled = true;
    };
    // key で uniquePaths 変化を検知 (uniquePaths の参照は毎回新しいが内容同じケースの再 fetch を避ける)
  }, [key, bucket, ttlSeconds, uniquePaths]);

  // 現在の key と一致しない場合は空 Map を返す (path 集合が変わった瞬間の古い map 漏出を防ぐ)
  return useMemo(() => {
    if (uniquePaths.length === 0) return new Map<string, string>();
    return state.key === key ? state.map : new Map<string, string>();
  }, [state, key, uniquePaths.length]);
}
