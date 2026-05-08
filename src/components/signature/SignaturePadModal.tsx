"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import SignaturePad from "signature_pad";
import { X, RotateCcw, Loader2, PenLine } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { resolvePreferredTenantId } from "@/lib/tenant-resolver";

export interface SignaturePadModalProps {
  /** 署名を保存する record table 名 (例: kaigo_visit_records) */
  recordTable: string;
  /** 署名対象の record id */
  recordId: string;
  /** 署名者氏名 default 値 (利用者本人なら client.name) */
  defaultSignerName?: string;
  onClose: () => void;
  /**
   * 確定時 callback。Storage path / 署名取得日時 / 署名者名 を返す。
   * v2: signed URL は保存せず path のみ返す (表示時に毎回 createSignedUrl で動的発行)。
   */
  onSubmit: (result: {
    signatureImagePath: string;
    signedAt: string;
    signerName: string;
  }) => void;
}

export function SignaturePadModal({
  recordTable,
  recordId,
  defaultSignerName,
  onClose,
  onSubmit,
}: SignaturePadModalProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const padRef = useRef<SignaturePad | null>(null);
  const [signerName, setSignerName] = useState(defaultSignerName ?? "");
  const [submitting, setSubmitting] = useState(false);

  // canvas を高 DPI 対応で resize し、ratio を再適用
  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    canvas.width = canvas.offsetWidth * ratio;
    canvas.height = canvas.offsetHeight * ratio;
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.scale(ratio, ratio);
    padRef.current?.clear();
  }, []);

  useEffect(() => {
    if (!canvasRef.current) return;
    padRef.current = new SignaturePad(canvasRef.current, {
      minWidth: 1,
      maxWidth: 2.5,
      penColor: "#111827",
      backgroundColor: "rgba(255,255,255,1)", // PNG 出力時に背景白を保証
    });
    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);
    return () => {
      window.removeEventListener("resize", resizeCanvas);
      padRef.current?.off();
      padRef.current = null;
    };
  }, [resizeCanvas]);

  const handleClear = () => {
    padRef.current?.clear();
  };

  const handleSubmit = async () => {
    const pad = padRef.current;
    if (!pad) return;
    if (pad.isEmpty()) {
      toast.error("署名が描かれていません");
      return;
    }
    if (!signerName.trim()) {
      toast.error("署名者氏名を入力してください");
      return;
    }

    setSubmitting(true);
    try {
      const canvas = canvasRef.current;
      if (!canvas) throw new Error("canvas 取得失敗");

      // canvas → blob (PNG)
      const blob: Blob = await new Promise((resolve, reject) => {
        canvas.toBlob((b) => {
          if (b) resolve(b);
          else reject(new Error("PNG 変換に失敗しました"));
        }, "image/png");
      });

      const supabase = createClient();
      const tenant = await resolvePreferredTenantId(supabase);
      if (!tenant.ok) {
        throw new Error(tenant.error);
      }

      const path = `${tenant.tenantId}/${recordTable}/${recordId}.png`;
      const { error: uploadErr } = await supabase.storage
        .from("signatures")
        .upload(path, blob, {
          contentType: "image/png",
          upsert: true, // 再署名対応
        });
      if (uploadErr) throw uploadErr;

      // v2: signed URL は発行せず path のみ返す。
      // 表示側で useSignedUrl(path) により表示直前に動的発行する (1 年期限の URL 失効問題を回避)。
      onSubmit({
        signatureImagePath: path,
        signedAt: new Date().toISOString(),
        signerName: signerName.trim(),
      });
    } catch (err: unknown) {
      toast.error(
        "署名保存に失敗しました: " +
          (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={submitting ? undefined : onClose}
      />
      <div className="relative w-full max-w-md rounded-xl bg-white shadow-2xl flex flex-col">
        <div className="flex items-center justify-between border-b px-5 py-3">
          <h2 className="flex items-center gap-2 text-base font-bold text-gray-900">
            <PenLine size={18} className="text-blue-600" />
            電子署名
          </h2>
          <button
            onClick={onClose}
            disabled={submitting}
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-50"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">
              署名者氏名 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={signerName}
              onChange={(e) => setSignerName(e.target.value)}
              placeholder="本人 or 代理者氏名"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <p className="mt-1 text-[11px] text-gray-500">
              利用者本人または代理人の氏名を入力してください
            </p>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">
              署名 <span className="text-red-500">*</span>
            </label>
            <div className="relative rounded-lg border-2 border-dashed border-gray-300 bg-gray-50">
              <canvas
                ref={canvasRef}
                className="block h-48 w-full touch-none rounded-lg bg-white"
              />
            </div>
            <button
              onClick={handleClear}
              type="button"
              className="mt-2 inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
            >
              <RotateCcw size={12} />
              書き直す
            </button>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t bg-gray-50 px-5 py-3">
          <button
            onClick={onClose}
            disabled={submitting}
            className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            キャンセル
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {submitting ? (
              <>
                <Loader2 size={14} className="animate-spin" /> 保存中...
              </>
            ) : (
              <>確定</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
