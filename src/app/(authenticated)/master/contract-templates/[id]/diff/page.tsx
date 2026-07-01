import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import {
  diffArticles,
  diffFlatKeys,
  summarizeDiff,
  type ArticleDiff,
  type FlatKeyDiff,
  type LineDiff,
  type ParagraphDiff,
  type ItemDiff,
} from "@/lib/contract-structure/diff";
import type { ArticleNode } from "@/lib/contract-structure/types";
import {
  articleLabel,
  paragraphMarker,
  itemMarker,
} from "@/lib/contract-structure/numbering";

/**
 * /master/contract-templates/[id]/diff
 *  = 対象版 (id) と parent_version_id の diff を表示
 */
export default async function ContractTemplateDiffPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: current, error: e1 } = await supabase
    .from("kaigo_contract_templates")
    .select("id, kind, version_no, content, parent_version_id, notes, effective_from")
    .eq("id", id)
    .maybeSingle();
  if (e1 || !current) {
    return (
      <div className="p-6 text-sm text-red-600">
        版が見つかりません: {e1?.message ?? id}
      </div>
    );
  }
  const cur = current as {
    id: string;
    kind: string;
    version_no: number;
    content: Record<string, unknown>;
    parent_version_id: string | null;
    notes: string | null;
    effective_from: string;
  };

  let parent: typeof cur | null = null;
  if (cur.parent_version_id) {
    const { data: p } = await supabase
      .from("kaigo_contract_templates")
      .select("id, kind, version_no, content, parent_version_id, notes, effective_from")
      .eq("id", cur.parent_version_id)
      .maybeSingle();
    parent = (p as typeof cur | null) ?? null;
  }

  const parentContent = parent?.content ?? {};
  const parentArticles = Array.isArray(
    (parentContent as { articles?: ArticleNode[] }).articles,
  )
    ? ((parentContent as { articles: ArticleNode[] }).articles as ArticleNode[])
    : [];
  const currentArticles = Array.isArray(
    (cur.content as { articles?: ArticleNode[] }).articles,
  )
    ? ((cur.content as { articles: ArticleNode[] }).articles as ArticleNode[])
    : [];

  const articles = diffArticles(parentArticles, currentArticles);
  const flats = diffFlatKeys(parentContent, cur.content);
  const summary = summarizeDiff(articles, flats);

  return (
    <div className="space-y-4 p-4">
      <div>
        <Link
          href={`/master/contract-templates/${id}`}
          className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft size={16} /> 編集画面へ戻る
        </Link>
      </div>

      <div className="rounded border bg-white p-4 shadow-sm">
        <h1 className="text-xl font-bold">
          {cur.kind} <span className="ml-2 font-mono text-sm">v{cur.version_no}</span>
        </h1>
        <p className="mt-1 text-sm text-gray-600">
          比較元:{" "}
          {parent ? (
            <>
              <span className="font-mono">v{parent.version_no}</span>{" "}
              (effective_from={parent.effective_from})
            </>
          ) : (
            <span className="text-gray-500">なし (=初版)</span>
          )}
        </p>
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          <Badge kind="added" count={summary.added} label="追加" />
          <Badge kind="removed" count={summary.removed} label="削除" />
          <Badge kind="modified" count={summary.modified} label="変更" />
          <Badge kind="reordered" count={summary.reordered} label="順序変更" />
        </div>
      </div>

      {/* Articles diff */}
      <section className="rounded border bg-white shadow-sm">
        <header className="border-b bg-gray-50 px-4 py-2 text-sm font-bold text-gray-800">
          契約本文 (条・項・号)
        </header>
        <div className="divide-y">
          {articles.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-gray-500">
              条の登録がありません
            </div>
          )}
          {articles.map((a) => (
            <ArticleRow key={a.id} node={a} />
          ))}
        </div>
      </section>

      {/* Flat keys diff */}
      <section className="rounded border bg-white shadow-sm">
        <header className="border-b bg-gray-50 px-4 py-2 text-sm font-bold text-gray-800">
          別紙 / 前文 / その他 flat 項目
        </header>
        <div className="divide-y">
          {flats.filter((f) => f.kind !== "unchanged").length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-gray-500">
              変更なし
            </div>
          )}
          {flats
            .filter((f) => f.kind !== "unchanged")
            .map((f) => (
              <FlatRow key={f.key} node={f} />
            ))}
        </div>
      </section>
    </div>
  );
}

// ─────────────────────────────────────────────────────

function Badge({
  kind,
  count,
  label,
}: {
  kind: "added" | "removed" | "modified" | "reordered";
  count: number;
  label: string;
}) {
  const styles = {
    added: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    removed: "bg-rose-50 text-rose-700 ring-rose-200",
    modified: "bg-amber-50 text-amber-700 ring-amber-200",
    reordered: "bg-sky-50 text-sky-700 ring-sky-200",
  }[kind];
  return (
    <span className={`rounded px-2 py-0.5 ring-1 ${styles}`}>
      {label} {count}
    </span>
  );
}

function KindTag({ kind }: { kind: ArticleDiff["kind"] }) {
  const map = {
    unchanged: { label: "不変", cls: "bg-gray-50 text-gray-500 ring-gray-200" },
    added: { label: "追加", cls: "bg-emerald-50 text-emerald-700 ring-emerald-300" },
    removed: { label: "削除", cls: "bg-rose-50 text-rose-700 ring-rose-300" },
    modified: { label: "変更", cls: "bg-amber-50 text-amber-700 ring-amber-300" },
    reordered: { label: "順序変更", cls: "bg-sky-50 text-sky-700 ring-sky-300" },
  }[kind];
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] ring-1 ${map.cls}`}>
      {map.label}
    </span>
  );
}

function LineDiffView({ diff }: { diff: LineDiff[] }) {
  return (
    <pre className="whitespace-pre-wrap rounded bg-gray-50 p-2 text-xs leading-relaxed">
      {diff.map((d, i) => (
        <div
          key={i}
          className={
            d.kind === "add"
              ? "bg-emerald-100 text-emerald-900"
              : d.kind === "remove"
                ? "bg-rose-100 text-rose-900 line-through"
                : "text-gray-700"
          }
        >
          <span className="mr-1 text-gray-400">
            {d.kind === "add" ? "+" : d.kind === "remove" ? "−" : " "}
          </span>
          {d.text || " "}
        </div>
      ))}
    </pre>
  );
}

function ArticleRow({ node: a }: { node: ArticleDiff }) {
  if (a.kind === "unchanged" && !a.paragraphs?.some((p) => p.kind !== "unchanged"))
    return null;

  const label =
    a.currentIndex !== null
      ? articleLabel(a.currentIndex)
      : a.parentIndex !== null
        ? `(旧 ${articleLabel(a.parentIndex)})`
        : "?";

  const paraDiff = (a.paragraphs ?? []).filter((p) => p.kind !== "unchanged");

  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-bold text-indigo-900">{label}</span>
        <KindTag kind={a.kind} />
        {a.kind === "reordered" && a.parentIndex !== null && (
          <span className="text-xs text-sky-700">
            {articleLabel(a.parentIndex)} → {label}
          </span>
        )}
        {(a.currentNode?.title || a.parentNode?.title) && (
          <span className="text-xs text-gray-500">
            {a.currentNode?.title ?? a.parentNode?.title}
          </span>
        )}
      </div>

      {a.kind === "added" && a.currentNode && (
        <div className="mt-2 rounded bg-emerald-50 p-2 text-sm">
          <div className="text-xs font-semibold text-emerald-800">＋追加</div>
          <div className="mt-1 whitespace-pre-wrap">{a.currentNode.chapeau}</div>
        </div>
      )}
      {a.kind === "removed" && a.parentNode && (
        <div className="mt-2 rounded bg-rose-50 p-2 text-sm line-through">
          <div className="text-xs font-semibold text-rose-800">−削除</div>
          <div className="mt-1 whitespace-pre-wrap">{a.parentNode.chapeau}</div>
        </div>
      )}
      {a.chapeauDiff && (
        <div className="mt-2">
          <div className="text-xs text-gray-500">柱書 diff</div>
          <LineDiffView diff={a.chapeauDiff} />
        </div>
      )}
      {paraDiff.length > 0 && (
        <div className="mt-2 space-y-1 pl-4">
          {paraDiff.map((p) => (
            <ParagraphRow key={p.id} node={p} />
          ))}
        </div>
      )}
    </div>
  );
}

function ParagraphRow({ node: p }: { node: ParagraphDiff }) {
  const label =
    p.currentIndex !== null ? paragraphMarker(p.currentIndex) : "(旧)";
  const itemDiff = (p.items ?? []).filter((it) => it.kind !== "unchanged");
  return (
    <div>
      <div className="flex items-center gap-2 text-sm">
        <span className="font-bold">{label}</span>
        <KindTag kind={p.kind} />
      </div>
      {p.kind === "added" && p.currentNode && (
        <div className="mt-1 rounded bg-emerald-50 p-2 text-sm">
          <div className="text-xs font-semibold text-emerald-800">＋追加</div>
          <div className="mt-1 whitespace-pre-wrap">{p.currentNode.chapeau}</div>
        </div>
      )}
      {p.kind === "removed" && p.parentNode && (
        <div className="mt-1 rounded bg-rose-50 p-2 text-sm line-through">
          <div className="mt-1 whitespace-pre-wrap">{p.parentNode.chapeau}</div>
        </div>
      )}
      {p.chapeauDiff && (
        <div className="mt-1">
          <LineDiffView diff={p.chapeauDiff} />
        </div>
      )}
      {itemDiff.length > 0 && (
        <div className="mt-1 space-y-0.5 pl-4">
          {itemDiff.map((it) => (
            <ItemRow key={it.id} node={it} />
          ))}
        </div>
      )}
    </div>
  );
}

function ItemRow({ node: it }: { node: ItemDiff }) {
  const marker =
    it.currentIndex !== null
      ? itemMarker(it.currentIndex, it.currentNode?.marker ?? "nakaguro")
      : "(旧)";
  return (
    <div className="text-xs">
      <div className="flex items-center gap-2">
        <span>{marker}</span>
        <KindTag kind={it.kind} />
      </div>
      {it.kind === "added" && it.currentNode && (
        <div className="ml-4 rounded bg-emerald-50 p-1 text-xs">
          + {it.currentNode.text}
        </div>
      )}
      {it.kind === "removed" && it.parentNode && (
        <div className="ml-4 rounded bg-rose-50 p-1 text-xs line-through">
          − {it.parentNode.text}
        </div>
      )}
      {it.textDiff && (
        <div className="ml-4">
          <LineDiffView diff={it.textDiff} />
        </div>
      )}
    </div>
  );
}

function FlatRow({ node: f }: { node: FlatKeyDiff }) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2 text-sm">
        <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-700">
          {f.key}
        </code>
        <KindTag kind={f.kind} />
      </div>
      {f.kind === "added" && (
        <div className="mt-1 rounded bg-emerald-50 p-2 text-sm">
          <div className="whitespace-pre-wrap">{f.currentValue}</div>
        </div>
      )}
      {f.kind === "removed" && (
        <div className="mt-1 rounded bg-rose-50 p-2 text-sm line-through">
          <div className="whitespace-pre-wrap">{f.parentValue}</div>
        </div>
      )}
      {f.lineDiff && (
        <div className="mt-1">
          <LineDiffView diff={f.lineDiff} />
        </div>
      )}
    </div>
  );
}
