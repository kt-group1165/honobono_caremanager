"use client";

import { useTransition } from "react";
import { activateVersion } from "./_actions";

export function ActivateButton({ id, kind }: { id: string; kind: string }) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (!confirm(`この版を「${kind}」の有効版に切替えますか？\n(以降の新規契約はこの版で締結されます)`)) return;
        start(async () => {
          try {
            await activateVersion(id, kind);
          } catch (e) {
            alert(String(e));
          }
        });
      }}
      className="inline-flex items-center gap-1 rounded border border-emerald-300 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
    >
      {pending ? "..." : "有効化"}
    </button>
  );
}
