"use client";

// 利用者確認サイン用の自前 canvas 署名パッド (外部ライブラリ不使用)。
// - pointer events でマウス / タッチ / ペン対応
// - 描画のたびに onChange で PNG dataURL を返す (未署名 / クリア時は null)
// - 内部解像度は 600×200 固定 (PNG で数十 KB に収まるサイズ)、表示は width 100% で伸縮
//
// 既存の SignaturePadModal (signature_pad ライブラリ + Storage 保存) とは役割が異なり、
// こちらは「記録フォーム内にインライン埋込」する軽量版。保存処理は持たず dataURL を親に渡すだけ。

import { useRef, useEffect, useCallback } from "react";
import { RotateCcw } from "lucide-react";

const CANVAS_W = 600;
const CANVAS_H = 200;

export interface SignaturePadProps {
  /** 現在の署名 dataURL (親 state)。null にリセットされたら canvas もクリアする */
  value: string | null;
  /** 描画確定 (pointerup) / クリア時に呼ばれる。クリア時は null */
  onChange: (dataUrl: string | null) => void;
  disabled?: boolean;
}

export function SignaturePad({ value, onChange, disabled }: SignaturePadProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const lastRef = useRef<{ x: number; y: number } | null>(null);
  const hasStrokeRef = useRef(false);

  const clearCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.fillStyle = "#ffffff"; // PNG 出力時の背景白を保証
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    hasStrokeRef.current = false;
  }, []);

  // 初期化 (白背景)
  useEffect(() => {
    clearCanvas();
  }, [clearCanvas]);

  // 親が value を null に戻したら (フォーム再オープン等) canvas もクリア
  useEffect(() => {
    if (value === null && hasStrokeRef.current) {
      clearCanvas();
    }
  }, [value, clearCanvas]);

  // 表示サイズ → 内部座標 (600×200) への変換
  const toCanvasPoint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * CANVAS_W,
      y: ((e.clientY - rect.top) / rect.height) * CANVAS_H,
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    const p = toCanvasPoint(e);
    lastRef.current = p;
    // タップだけでも点が残るように dot を打つ
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#111827";
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1, 0, Math.PI * 2);
      ctx.fill();
    }
    hasStrokeRef.current = true;
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || disabled) return;
    e.preventDefault();
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    const last = lastRef.current;
    if (!canvas || !ctx || !last) return;
    const p = toCanvasPoint(e);
    ctx.strokeStyle = "#111827";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    lastRef.current = p;
  };

  const endStroke = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    lastRef.current = null;
    const canvas = canvasRef.current;
    if (canvas?.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
    if (canvas && hasStrokeRef.current) {
      onChange(canvas.toDataURL("image/png"));
    }
  };

  const handleClear = () => {
    clearCanvas();
    onChange(null);
  };

  return (
    <div>
      <div className="relative rounded-lg border-2 border-dashed border-gray-300 bg-gray-50">
        <canvas
          ref={canvasRef}
          width={CANVAS_W}
          height={CANVAS_H}
          className={`block w-full touch-none rounded-lg bg-white ${disabled ? "opacity-60" : "cursor-crosshair"}`}
          style={{ aspectRatio: `${CANVAS_W} / ${CANVAS_H}` }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endStroke}
          onPointerCancel={endStroke}
        />
        {!value && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-gray-300">
            ここにサインしてください
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={handleClear}
        disabled={disabled || !value}
        className="mt-2 inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
      >
        <RotateCcw size={12} />
        書き直す
      </button>
    </div>
  );
}
