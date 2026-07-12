"use client";

/**
 * 審査結果取込 — 国保連からの審査結果・返戻・支払通知ファイルの取込 UI
 * (ほのぼの「返戻管理くん」+「審査結果取込」相当)
 *
 * 訪問側 (billing-visit/kokuho-seikyu) と居宅側 (billing/seikyu 国保請求タブ) の
 * 両ツールバーから共通利用する。
 *
 * フロー (careplan-import の preview→確定 パターンを踏襲):
 *   1. ファイル選択 (Shift_JIS / 複数可) → パース + 被保険者番号突合 → プレビュー
 *   2. 「取込を確定」→ raw 保存 (kokuho_shinsa_notice_files/_rows)
 *      + 返戻(7411)は kaigo_billing_status.henrei 自動セット
 *      + 支払決定(7511/7513)は kokuho_nyukin_records.kettei_amount 取込
 *      + 増減表(7211)・内訳書(7521)は保存・一覧表示のみ (フラグは立てない)
 *   突合不能行は「未突合」として保存・表示する (silent skip 禁止)
 *
 * migration (migrations/kokuho_shinsa_notices.sql) 未適用時はガイダンス表示のみ。
 *
 * ⚠ 実ファイル未検証:
 *   パーサはインタフェース仕様書 (居宅版/サービス事業所版) のみを根拠に実装している。
 *   国保連からの実ファイルでの列位置検証がまだのため、初回取込時はプレビューの
 *   内容 (氏名・提供年月・単位数・金額) を必ず目視確認してから確定すること。
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  FileText,
  Inbox,
  Loader2,
  Upload,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  decodeNoticeSjis,
  parseNoticeFileText,
  NOTICE_KIND_LABEL,
  HENREI_JIYU_LABEL,
  type ParsedNoticeFile,
} from "@/lib/kokuho-tsuchi/parse";
import {
  applyHenreiFlags,
  applyShiharaiKettei,
  checkNoticeTables,
  loadMissedReSeikyu,
  markRowsApplied,
  resolveClientsByInsuredNumber,
  saveNoticeFile,
  type HenreiApplyEntry,
  type MatchedClient,
  type MissedReSeikyuRow,
} from "@/lib/kokuho-tsuchi/apply";

interface LoadedFile {
  parsed: ParsedNoticeFile;
  rawContent: string;
  /** 被保険者番号 → 利用者 (7411 明細の突合結果) */
  matches: Map<string, MatchedClient>;
}

interface Props {
  officeId: string | null;
  tenantId: string | null;
  /** 自事業所の事業所番号 (ヘッダの事業所番号との不一致警告用) */
  officeNumber?: string | null;
  /** 再請求漏れ一覧から請求画面 (当タブ) の該当月へ移動する */
  onNavigateMonth?: (year: number, month: number) => void;
  /** 確定後に親の請求状態を再読込させる */
  onApplied?: () => void;
}

const fmtAmount = (n: number | null | undefined) =>
  n == null ? "-" : n.toLocaleString("ja-JP");

export function ShinsaKekkaImport({
  officeId,
  tenantId,
  officeNumber,
  onNavigateMonth,
  onApplied,
}: Props) {
  const supabase = useMemo(() => createClient(), []);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [open, setOpen] = useState(false);
  const [tableStatus, setTableStatus] = useState<"checking" | "ready" | "missing">("checking");
  const [files, setFiles] = useState<LoadedFile[]>([]);
  const [parsing, setParsing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [resultLines, setResultLines] = useState<string[]>([]);
  const [missed, setMissed] = useState<MissedReSeikyuRow[] | null>(null);

  /* ── ダイアログを開く: テーブル存在チェック + 再請求漏れ一覧 ── */
  const refreshMissed = useCallback(async () => {
    if (!officeId) return;
    try {
      setMissed(await loadMissedReSeikyu(supabase, officeId));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      setMissed([]);
    }
  }, [supabase, officeId]);

  const handleOpen = useCallback(async () => {
    setOpen(true);
    setFiles([]);
    setResultLines([]);
    setTableStatus("checking");
    const { exists, error } = await checkNoticeTables(supabase);
    if (error) toast.error("取込テーブルの確認に失敗: " + error);
    setTableStatus(exists ? "ready" : "missing");
    refreshMissed();
  }, [supabase, refreshMissed]);

  /* ── ファイル選択 → パース + 突合 (プレビュー段階。DB には書かない) ── */
  const handleFiles = useCallback(
    async (list: FileList | null) => {
      if (!list || list.length === 0) return;
      setParsing(true);
      try {
        const loaded: LoadedFile[] = [];
        for (const file of Array.from(list)) {
          if (files.some((f) => f.parsed.fileName === file.name)) {
            toast.warning(`${file.name} は選択済みのためスキップしました`);
            continue;
          }
          const buf = await file.arrayBuffer();
          const text = decodeNoticeSjis(new Uint8Array(buf));
          const parsed = parseNoticeFileText(text, file.name);
          if (parsed.rawRecords.length === 0) {
            toast.error(`${file.name}: データレコードがありません (国保連通知ファイルか確認してください)`);
            continue;
          }
          // 7411 明細の被保険者番号 → 利用者突合
          const insured = parsed.henreiRows.map((r) => r.insuredNumber).filter(Boolean);
          const matches =
            insured.length > 0
              ? await resolveClientsByInsuredNumber(supabase, insured)
              : new Map<string, MatchedClient>();
          loaded.push({ parsed, rawContent: text, matches });
        }
        if (loaded.length > 0) {
          setFiles((prev) => [...prev, ...loaded]);
          setResultLines([]);
        }
      } catch (e) {
        toast.error("ファイルの読込に失敗: " + (e instanceof Error ? e.message : String(e)));
      } finally {
        setParsing(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [supabase, files],
  );

  /* ── 確定: raw 保存 + 自動処理 ── */
  const handleApply = useCallback(async () => {
    if (!officeId || !tenantId) {
      toast.error("事業所が選択されていません");
      return;
    }
    if (files.length === 0) return;
    setApplying(true);
    const lines: string[] = [];
    try {
      for (const f of files) {
        const { fileId, rowCount } = await saveNoticeFile(supabase, {
          tenantId,
          officeId,
          parsed: f.parsed,
          rawContent: f.rawContent,
          matches: f.matches,
        });
        lines.push(`${f.parsed.fileName}: ${rowCount} レコードを保存しました`);

        // 返戻 (7411) → henrei フラグ
        const entries: HenreiApplyEntry[] = [];
        let unmatched = 0;
        let noYm = 0;
        for (const row of f.parsed.henreiRows) {
          const m = f.matches.get(row.insuredNumber);
          if (!m) {
            unmatched += 1;
            continue;
          }
          if (!row.serviceYm) {
            noYm += 1;
            continue;
          }
          entries.push({
            clientId: m.clientId,
            clientName: m.name,
            targetMonth: row.serviceYm,
            row,
          });
        }
        if (entries.length > 0) {
          const res = await applyHenreiFlags(supabase, {
            tenantId,
            officeId,
            shinsaYm: f.parsed.shinsaYm,
            entries,
          });
          lines.push(
            `　返戻フラグを ${res.applied} 件 (利用者×提供月) にセットしました` +
              (res.alreadyFlagged > 0 ? ` (うち ${res.alreadyFlagged} 件は既に返戻フラグ済み)` : ""),
          );
        }
        if (unmatched > 0) {
          lines.push(
            `　⚠ 返戻 ${unmatched} 行は被保険者番号から利用者を特定できず「未突合」として保存しました (フラグ未反映。利用者マスタの被保険者番号を確認後、介護請求タブで手動フラグしてください)`,
          );
        }
        if (noYm > 0) {
          lines.push(`　⚠ 返戻 ${noYm} 行は提供年月が読み取れずフラグ未反映です (取込明細に保存済み)`);
        }

        // 支払決定額通知 (7511/7513) → kokuho_nyukin_records
        if (f.parsed.shiharaiKettei.length > 0) {
          const res = await applyShiharaiKettei(supabase, {
            tenantId,
            officeId,
            notices: f.parsed.shiharaiKettei,
          });
          lines.push(
            `　支払決定額を入金管理に反映しました (更新 ${res.updated} / 新規 ${res.inserted})` +
              (res.inserted > 0 ? " — 新規分は請求額スナップショット未登録のため国保入金管理タブで請求額を確認してください" : ""),
          );
        }

        // 増減表 (7211) / 内訳書 (7521) は保存のみ
        if (f.parsed.zougenRows.length > 0) {
          lines.push(`　審査決定増減表 ${f.parsed.zougenRows.length} 行を査定減一覧として保存しました (フラグは立てません)`);
        }
        if (f.parsed.uchiwakeRows.length > 0) {
          lines.push(`　支払決定額内訳書 ${f.parsed.uchiwakeRows.length} 行を保存しました`);
        }
        for (const u of f.parsed.unsupported) {
          lines.push(`　⚠ 未対応種別 ${u.exchangeNumber}: ${u.count} 行は raw 保存のみ (自動処理なし)`);
        }

        await markRowsApplied(supabase, fileId);
      }
      setFiles([]);
      setResultLines(lines);
      toast.success("審査結果の取込が完了しました");
      refreshMissed();
      onApplied?.();
    } catch (e) {
      // 途中失敗時もそれまでの結果を表示する (どこまで反映されたかを隠さない)
      lines.push(`✗ エラー: ${e instanceof Error ? e.message : String(e)}`);
      setResultLines(lines);
      toast.error("取込に失敗しました: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setApplying(false);
    }
  }, [supabase, files, officeId, tenantId, refreshMissed, onApplied]);

  const totalHenrei = files.reduce((s, f) => s + f.parsed.henreiRows.length, 0);

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        title="国保連からの審査結果・返戻・支払通知ファイル (7411/7511/7521/7211) を取り込み、返戻フラグ・支払決定額を自動反映します"
        className="border border-amber-500 rounded bg-white px-2.5 py-1 text-amber-700 hover:bg-amber-50 flex items-center gap-1.5"
      >
        <Inbox size={13} />
        審査結果取込
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto text-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Inbox size={16} />
              審査結果取込 (国保連通知ファイル)
            </DialogTitle>
            <DialogDescription>
              国保連からの返戻（保留）一覧表 (7411)・支払決定額通知書 (7511/7513)・
              支払決定額内訳書 (7521)・審査決定増減表 (7211) を取り込みます。
            </DialogDescription>
          </DialogHeader>

          {/* ⚠ 実ファイル未検証の注記 (常時表示) */}
          <div className="border border-amber-300 bg-amber-50 rounded px-3 py-2 text-xs text-amber-800 flex items-start gap-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>
              本取込はインタフェース仕様書ベースの実装で、国保連の実ファイルでは未検証です。
              初回取込時はプレビューの内容 (氏名・提供年月・単位数・金額の列ずれが無いか) を
              必ず確認してから確定してください。
            </span>
          </div>

          {tableStatus === "checking" && (
            <div className="flex items-center gap-2 text-gray-500 py-6 justify-center">
              <Loader2 size={16} className="animate-spin" /> 取込テーブルを確認中…
            </div>
          )}

          {/* ── migration 未適用: ガイダンスのみ ── */}
          {tableStatus === "missing" && (
            <div className="border border-red-300 bg-red-50 rounded px-3 py-3 text-xs text-red-800 space-y-2">
              <p className="font-semibold flex items-center gap-1.5">
                <AlertCircle size={14} /> 取込テーブルが未適用です
              </p>
              <p>
                審査結果取込を使うには、先に migration を適用してください:
              </p>
              <ol className="list-decimal ml-5 space-y-1">
                <li>
                  <code className="bg-white border border-red-200 rounded px-1">
                    migrations/kokuho_shinsa_notices.sql
                  </code>{" "}
                  を Supabase SQL Editor に全文貼付けて Run (BEGIN〜COMMIT 一括)
                </li>
                <li>このダイアログを開き直す</li>
              </ol>
              <p>適用までは取込・自動フラグ反映は行われません (既存機能には影響ありません)。</p>
            </div>
          )}

          {tableStatus === "ready" && (
            <div className="space-y-3">
              {/* ── ファイル選択 ── */}
              <div className="flex items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".csv,.txt,.dat,.CSV,.TXT,.DAT"
                  className="hidden"
                  onChange={(e) => handleFiles(e.target.files)}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={parsing || applying}
                  className="border border-gray-400 rounded bg-white px-3 py-1.5 text-gray-700 hover:bg-gray-50 flex items-center gap-1.5 disabled:opacity-50"
                >
                  {parsing ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                  通知ファイルを選択 (Shift_JIS / 複数可)
                </button>
                <span className="text-xs text-gray-500">
                  例: 74110000.CSV (返戻一覧) / 75100000.CSV (支払決定)
                </span>
              </div>

              {/* ── プレビュー (ファイルごと) ── */}
              {files.map((f) => {
                const p = f.parsed;
                const officeMismatch =
                  officeNumber && p.headerOfficeNumber && p.headerOfficeNumber !== officeNumber;
                const kindBadges = [
                  p.henreiRows.length > 0 && `${NOTICE_KIND_LABEL.henrei} ${p.henreiRows.length}件`,
                  p.shiharaiKettei.length > 0 &&
                    `${NOTICE_KIND_LABEL.shiharai_kettei} ${p.shiharaiKettei.length}件`,
                  p.uchiwakeRows.length > 0 &&
                    `${NOTICE_KIND_LABEL.shiharai_uchiwake} ${p.uchiwakeRows.length}件`,
                  p.zougenRows.length > 0 && `${NOTICE_KIND_LABEL.zougen} ${p.zougenRows.length}件`,
                ].filter(Boolean) as string[];
                const matchedCount = p.henreiRows.filter((r) => f.matches.has(r.insuredNumber)).length;
                return (
                  <div key={p.fileName} className="border border-gray-300 rounded">
                    {/* ファイルヘッダ */}
                    <div className="bg-gray-50 border-b border-gray-200 px-3 py-2 flex items-center gap-2 flex-wrap text-xs">
                      <FileText size={14} className="text-gray-500" />
                      <span className="font-semibold">{p.fileName}</span>
                      {p.shinsaYm && (
                        <span className="border border-gray-300 rounded bg-white px-1.5 py-0.5">
                          審査年月 {p.shinsaYm}
                        </span>
                      )}
                      {kindBadges.map((b) => (
                        <span key={b} className="border border-indigo-300 rounded bg-indigo-50 text-indigo-700 px-1.5 py-0.5">
                          {b}
                        </span>
                      ))}
                      {p.henreiRows.length > 0 && (
                        <span
                          className={`rounded px-1.5 py-0.5 border ${
                            matchedCount === p.henreiRows.length
                              ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                              : "border-red-300 bg-red-50 text-red-700"
                          }`}
                        >
                          突合 {matchedCount}/{p.henreiRows.length}
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          setFiles((prev) => prev.filter((x) => x.parsed.fileName !== p.fileName))
                        }
                        className="ml-auto text-gray-400 hover:text-red-600"
                        title="このファイルを取込対象から外す"
                      >
                        除外
                      </button>
                    </div>

                    <div className="p-3 space-y-2 text-xs">
                      {/* 警告 */}
                      {officeMismatch && (
                        <p className="text-red-700 flex items-start gap-1.5">
                          <AlertCircle size={13} className="mt-0.5 shrink-0" />
                          通知の事業所番号 ({p.headerOfficeNumber}) が選択中の事業所 ({officeNumber})
                          と一致しません。別事業所宛のファイルの可能性があります。
                        </p>
                      )}
                      {p.warnings.map((w) => (
                        <p key={w} className="text-amber-700 flex items-start gap-1.5">
                          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                          {w}
                        </p>
                      ))}
                      {p.unsupported.map((u) => (
                        <p key={u.exchangeNumber} className="text-red-700 flex items-start gap-1.5">
                          <AlertCircle size={13} className="mt-0.5 shrink-0" />
                          未対応種別 {u.exchangeNumber}: {u.count} 行 — raw
                          保存のみで自動処理は行いません
                        </p>
                      ))}

                      {/* 7411 返戻一覧 */}
                      {p.henreiRows.length > 0 && (
                        <div className="overflow-x-auto">
                          <table className="w-full border-collapse whitespace-nowrap">
                            <thead>
                              <tr className="bg-gray-100 text-gray-600">
                                <th className="border border-gray-200 px-1.5 py-1 text-left">提供年月</th>
                                <th className="border border-gray-200 px-1.5 py-1 text-left">被保険者番号</th>
                                <th className="border border-gray-200 px-1.5 py-1 text-left">カナ氏名</th>
                                <th className="border border-gray-200 px-1.5 py-1 text-left">種別</th>
                                <th className="border border-gray-200 px-1.5 py-1 text-left">サービス</th>
                                <th className="border border-gray-200 px-1.5 py-1 text-right">単位数</th>
                                <th className="border border-gray-200 px-1.5 py-1 text-left">事由</th>
                                <th className="border border-gray-200 px-1.5 py-1 text-left">内容</th>
                                <th className="border border-gray-200 px-1.5 py-1 text-left">備考</th>
                                <th className="border border-gray-200 px-1.5 py-1 text-left">突合</th>
                              </tr>
                            </thead>
                            <tbody>
                              {p.henreiRows.map((r) => {
                                const m = f.matches.get(r.insuredNumber);
                                return (
                                  <tr key={r.rowIndex} className={m ? "" : "bg-red-50"}>
                                    <td className="border border-gray-200 px-1.5 py-1">{r.serviceYm ?? "?"}</td>
                                    <td className="border border-gray-200 px-1.5 py-1 font-mono">{r.insuredNumber}</td>
                                    <td className="border border-gray-200 px-1.5 py-1">{r.kanaName}</td>
                                    <td className="border border-gray-200 px-1.5 py-1">{r.shubetsu}</td>
                                    <td className="border border-gray-200 px-1.5 py-1">{r.serviceKindCode}</td>
                                    <td className="border border-gray-200 px-1.5 py-1 text-right">{fmtAmount(r.tanisu)}</td>
                                    <td
                                      className="border border-gray-200 px-1.5 py-1"
                                      title={HENREI_JIYU_LABEL[r.jiyuCode] ?? ""}
                                    >
                                      {r.jiyuCode}
                                    </td>
                                    <td className="border border-gray-200 px-1.5 py-1 max-w-[16rem] truncate" title={r.jiyuNaiyo}>
                                      {r.jiyuNaiyo}
                                    </td>
                                    <td className="border border-gray-200 px-1.5 py-1">{r.biko}</td>
                                    <td className="border border-gray-200 px-1.5 py-1">
                                      {m ? (
                                        <span className="text-emerald-700">{m.name}</span>
                                      ) : (
                                        <span className="text-red-700 font-semibold">未突合</span>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}

                      {/* 7511/7513 支払決定額通知書 */}
                      {p.shiharaiKettei.map((k) => (
                        <div key={k.rowIndex} className="border border-gray-200 rounded px-2.5 py-2 bg-gray-50">
                          <p className="font-semibold text-gray-700 mb-1">
                            支払決定額通知書 ({k.exchangeNumber}) — 審査年月 {k.shinsaYm ?? "?"}
                          </p>
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1">
                            <span>振込金額: <b>{fmtAmount(k.furikomiAmount)}円</b></span>
                            <span>介護給付費支払額: {fmtAmount(k.kaigoKyufuhiAmount)}円</span>
                            <span>合計金額: {fmtAmount(k.goukeiAmount)}円</span>
                            <span>振込日: {k.furikomiDate || "-"}</span>
                            <span className="col-span-2">
                              振込先: {k.bankName} {k.branchName}
                            </span>
                            <span className="col-span-2">事業所: {k.officeName} ({k.officeNumber})</span>
                          </div>
                          <p className="text-gray-500 mt-1">
                            → 確定すると入金管理 (対象月 {k.shinsaYm ?? "?"}) の支払決定額に反映され、請求額スナップショットとの差額表示に乗ります
                          </p>
                        </div>
                      ))}

                      {/* 7211 増減表 (査定減の一覧) */}
                      {p.zougenRows.length > 0 && (
                        <div className="overflow-x-auto">
                          <p className="font-semibold text-gray-700 mb-1">
                            審査決定増減表 (7211) — 査定減として保存します (フラグは立てません)
                          </p>
                          <table className="w-full border-collapse whitespace-nowrap">
                            <thead>
                              <tr className="bg-gray-100 text-gray-600">
                                <th className="border border-gray-200 px-1.5 py-1 text-left">保険者番号</th>
                                <th className="border border-gray-200 px-1.5 py-1 text-left">提供年月</th>
                                <th className="border border-gray-200 px-1.5 py-1 text-right">返戻 件数</th>
                                <th className="border border-gray-200 px-1.5 py-1 text-right">返戻 単位数</th>
                                <th className="border border-gray-200 px-1.5 py-1 text-right">査定増減 件数</th>
                                <th className="border border-gray-200 px-1.5 py-1 text-right">査定増減 単位数</th>
                                <th className="border border-gray-200 px-1.5 py-1 text-right">保留 件数</th>
                                <th className="border border-gray-200 px-1.5 py-1 text-right">保留復活 件数</th>
                              </tr>
                            </thead>
                            <tbody>
                              {p.zougenRows.map((z) => (
                                <tr key={z.rowIndex}>
                                  <td className="border border-gray-200 px-1.5 py-1 font-mono">{z.insurerNumber}</td>
                                  <td className="border border-gray-200 px-1.5 py-1">{z.serviceYm ?? "?"}</td>
                                  <td className="border border-gray-200 px-1.5 py-1 text-right">{fmtAmount(z.henrei.kensuKaigo)}</td>
                                  <td className="border border-gray-200 px-1.5 py-1 text-right">{fmtAmount(z.henrei.tanisuKaigo)}</td>
                                  <td className="border border-gray-200 px-1.5 py-1 text-right">{fmtAmount(z.satei.kensuKaigo)}</td>
                                  <td className="border border-gray-200 px-1.5 py-1 text-right">{fmtAmount(z.satei.tanisuKaigo)}</td>
                                  <td className="border border-gray-200 px-1.5 py-1 text-right">{fmtAmount(z.horyu.kensuKaigo)}</td>
                                  <td className="border border-gray-200 px-1.5 py-1 text-right">{fmtAmount(z.horyuFukkatsu.kensuKaigo)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}

                      {/* 7521 内訳書 */}
                      {p.uchiwakeRows.length > 0 && (
                        <div className="overflow-x-auto">
                          <p className="font-semibold text-gray-700 mb-1">支払決定額内訳書 (7521)</p>
                          <table className="w-full border-collapse whitespace-nowrap">
                            <thead>
                              <tr className="bg-gray-100 text-gray-600">
                                <th className="border border-gray-200 px-1.5 py-1 text-left">保険者番号</th>
                                <th className="border border-gray-200 px-1.5 py-1 text-left">提供年月</th>
                                <th className="border border-gray-200 px-1.5 py-1 text-left">サービス種類</th>
                                <th className="border border-gray-200 px-1.5 py-1 text-right">件数</th>
                                <th className="border border-gray-200 px-1.5 py-1 text-right">単位数</th>
                                <th className="border border-gray-200 px-1.5 py-1 text-right">金額</th>
                                <th className="border border-gray-200 px-1.5 py-1 text-right">介護給付費</th>
                              </tr>
                            </thead>
                            <tbody>
                              {p.uchiwakeRows.map((u) => (
                                <tr key={u.rowIndex}>
                                  <td className="border border-gray-200 px-1.5 py-1 font-mono">{u.insurerNumber}</td>
                                  <td className="border border-gray-200 px-1.5 py-1">{u.serviceYm ?? "?"}</td>
                                  <td className="border border-gray-200 px-1.5 py-1">
                                    {u.serviceKindCode} {u.serviceKindName}
                                  </td>
                                  <td className="border border-gray-200 px-1.5 py-1 text-right">{fmtAmount(u.kensu)}</td>
                                  <td className="border border-gray-200 px-1.5 py-1 text-right">{fmtAmount(u.tanisu)}</td>
                                  <td className="border border-gray-200 px-1.5 py-1 text-right">{fmtAmount(u.kingaku)}</td>
                                  <td className="border border-gray-200 px-1.5 py-1 text-right">{fmtAmount(u.kyufuhi)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {/* ── 確定ボタン ── */}
              {files.length > 0 && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleApply}
                    disabled={applying || !officeId || !tenantId}
                    className="border border-indigo-500 rounded bg-indigo-500 px-4 py-1.5 text-white font-semibold hover:bg-indigo-600 flex items-center gap-1.5 disabled:opacity-50"
                  >
                    {applying ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                    取込を確定 ({files.length} ファイル
                    {totalHenrei > 0 ? ` / 返戻 ${totalHenrei} 行` : ""})
                  </button>
                  <span className="text-xs text-gray-500">
                    確定すると raw 保存 + 返戻フラグ/支払決定額の自動反映を行います
                  </span>
                </div>
              )}

              {/* ── 取込結果 ── */}
              {resultLines.length > 0 && (
                <div className="border border-emerald-300 bg-emerald-50 rounded px-3 py-2 text-xs text-emerald-900 space-y-0.5">
                  {resultLines.map((l, i) => (
                    <p key={i} className={l.startsWith("✗") ? "text-red-700 font-semibold" : ""}>
                      {l}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── 返戻 × 再請求未実施 の突合リスト ── */}
          <div className="border-t border-gray-200 pt-3">
            <p className="font-semibold text-gray-700 text-xs mb-1.5 flex items-center gap-1.5">
              <AlertCircle size={13} className="text-red-600" />
              返戻のうち再請求未実施
              {missed != null && (
                <span className={missed.length > 0 ? "text-red-600" : "text-emerald-600"}>
                  {missed.length} 件
                </span>
              )}
            </p>
            {missed == null ? (
              <p className="text-xs text-gray-400">読込中…</p>
            ) : missed.length === 0 ? (
              <p className="text-xs text-gray-500">
                再請求待ちの返戻はありません (返戻フラグあり × 国保未対象の行が対象)
              </p>
            ) : (
              <div className="overflow-x-auto max-h-56 overflow-y-auto">
                <table className="w-full border-collapse text-xs whitespace-nowrap">
                  <thead>
                    <tr className="bg-gray-100 text-gray-600 sticky top-0">
                      <th className="border border-gray-200 px-1.5 py-1 text-left">提供月</th>
                      <th className="border border-gray-200 px-1.5 py-1 text-left">利用者</th>
                      <th className="border border-gray-200 px-1.5 py-1 text-left">フラグ</th>
                      <th className="border border-gray-200 px-1.5 py-1 text-left">メモ (返戻事由)</th>
                      <th className="border border-gray-200 px-1.5 py-1"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {missed.map((r) => (
                      <tr key={`${r.clientId}-${r.targetMonth}`}>
                        <td className="border border-gray-200 px-1.5 py-1">{r.targetMonth}</td>
                        <td className="border border-gray-200 px-1.5 py-1">{r.clientName}</td>
                        <td className="border border-gray-200 px-1.5 py-1">
                          返戻{r.tsukiokure ? " / 月遅れ" : ""}
                          {r.kago ? " / 過誤" : ""}
                        </td>
                        <td className="border border-gray-200 px-1.5 py-1 max-w-[18rem] truncate" title={r.notes ?? ""}>
                          {r.notes ?? ""}
                        </td>
                        <td className="border border-gray-200 px-1.5 py-1">
                          {onNavigateMonth && (
                            <button
                              type="button"
                              onClick={() => {
                                // 再請求は「翌月以降の請求」に合流するため翌月の請求画面へ移動する
                                const [y, m] = r.targetMonth.split("-").map(Number);
                                const next = new Date(y, m, 1); // m は 1-origin → そのまま翌月 1 日
                                onNavigateMonth(next.getFullYear(), next.getMonth() + 1);
                                setOpen(false);
                              }}
                              className="text-indigo-600 hover:underline"
                              title="再請求は元提供月の翌月以降の請求に合流します"
                            >
                              請求画面へ
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-[11px] text-gray-400 mt-1">
              判定: kaigo_billing_status で 返戻=あり かつ 国保対象化 (再請求の伝送) 未実施の行。
              再請求すると国保請求画面で国保対象化され、この一覧から消えます。
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
