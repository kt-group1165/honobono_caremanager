"use client";

import { useTransition } from "react";
import { Plus } from "lucide-react";
import { createNewVersion } from "./_actions";

export function NewVersionButton({ kind }: { kind: string }) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (!confirm(`「${kind}」の新版を作成しますか？\n(現行版を複製 → 編集画面に遷移)`)) return;
        start(async () => {
          try {
            await createNewVersion(kind);
          } catch (e) {
            alert(String(e));
          }
        });
      }}
      className="inline-flex items-center gap-1 rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
    >
      <Plus size={12} /> {pending ? "作成中..." : "新版を作成"}
    </button>
  );
}
