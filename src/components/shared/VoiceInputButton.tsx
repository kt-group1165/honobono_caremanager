"use client";

/**
 * 音声入力ボタン (Web Speech API / SpeechRecognition)
 *
 * textarea の隣に置くと 🎤 押下で音声認識 (ja-JP・継続認識) を開始し、
 * 確定した認識結果をカーソル位置に追記する。
 *
 * - 対応: Chrome / Edge / Android Chrome / iOS Safari 14.5+ (webkitSpeechRecognition)
 * - 非対応ブラウザ (SpeechRecognition が無い環境) では null を返し自動非表示
 * - SSR とのハイドレーション整合のため、対応判定は effect で行う
 * - controlled textarea 前提: value / onChange を渡す (親 state に追記して返す)
 */

import { useEffect, useRef, useState } from "react";
import { Mic, Square } from "lucide-react";
import { toast } from "sonner";

// ─── Web Speech API 最小型 (lib.dom に無い環境向けの自前定義) ────────────────

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: {
      isFinal: boolean;
      length: number;
      [index: number]: { transcript: string };
    };
  };
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

// ブラウザは同時に 1 つの認識しか動かせないため、別ボタンの開始時に前のを止める
let stopActiveRecognition: (() => void) | null = null;

// ─── Component ───────────────────────────────────────────────────────────────

export function VoiceInputButton({
  targetRef,
  value,
  onChange,
  disabled,
  className,
}: {
  /** 追記先 textarea の ref (カーソル位置の取得に使用) */
  targetRef: React.RefObject<HTMLTextAreaElement | null>;
  /** 現在のテキスト値 (controlled) */
  value: string;
  /** 追記後のテキストを返す setter */
  onChange: (next: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  // 最新 value / onChange を認識コールバックから参照するための ref
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    valueRef.current = value;
    onChangeRef.current = onChange;
  });
  // 直近の挿入終了位置 (textarea が非フォーカスの間の連続追記用)
  const lastPosRef = useRef<number | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only の機能判定 (SSR ハイドレーション整合のため effect で設定)
    setSupported(getSpeechRecognitionCtor() !== null);
    return () => {
      // unmount 時に認識中なら止める
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    };
  }, []);

  // 確定した認識テキストをカーソル位置 (非フォーカス時は前回挿入位置 or 末尾) に追記
  const insertTranscript = (text: string) => {
    if (!text) return;
    const el = targetRef.current;
    const base = valueRef.current;
    let pos: number;
    if (el && document.activeElement === el && el.selectionStart != null) {
      pos = Math.min(el.selectionStart, base.length);
    } else if (lastPosRef.current != null) {
      pos = Math.min(lastPosRef.current, base.length);
    } else {
      pos = base.length;
    }
    const next = base.slice(0, pos) + text + base.slice(pos);
    lastPosRef.current = pos + text.length;
    valueRef.current = next; // 同一結果イベント内の連続 final に備え即時更新
    onChangeRef.current(next);
    // controlled 更新後にカーソルを挿入末尾へ (フォーカス中のみ)
    if (el && document.activeElement === el) {
      const caret = pos + text.length;
      requestAnimationFrame(() => {
        try {
          el.selectionStart = el.selectionEnd = caret;
        } catch {
          /* 非表示化等で失敗しても無害 */
        }
      });
    }
  };

  const stopListening = () => {
    recognitionRef.current?.stop();
    setListening(false);
  };

  const startListening = () => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    // 他のボタンで認識中なら止める (ブラウザは同時 1 認識)
    stopActiveRecognition?.();
    const rec = new Ctor();
    rec.lang = "ja-JP";
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (ev) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const result = ev.results[i];
        if (result.isFinal && result[0]) {
          insertTranscript(result[0].transcript);
        }
      }
    };
    rec.onend = () => {
      setListening(false);
      if (recognitionRef.current === rec) recognitionRef.current = null;
      if (stopActiveRecognition === myStop) stopActiveRecognition = null;
    };
    rec.onerror = (ev) => {
      const code = ev.error ?? "";
      if (code === "not-allowed" || code === "service-not-allowed") {
        toast.error("マイクの使用が許可されていません。ブラウザの設定を確認してください。");
      } else if (code !== "aborted" && code !== "no-speech") {
        console.warn("speech recognition error:", code);
      }
      setListening(false);
    };
    const myStop = () => {
      rec.abort();
      setListening(false);
    };
    stopActiveRecognition = myStop;
    recognitionRef.current = rec;
    // 開始時点のカーソル位置を追記開始点として記憶
    const el = targetRef.current;
    lastPosRef.current =
      el && document.activeElement === el && el.selectionStart != null
        ? el.selectionStart
        : valueRef.current.length;
    try {
      rec.start();
      setListening(true);
    } catch (err) {
      console.warn("speech recognition start failed:", err);
      toast.error("音声入力を開始できませんでした");
      recognitionRef.current = null;
    }
  };

  if (!supported) return null;

  return (
    <button
      type="button"
      onClick={() => (listening ? stopListening() : startListening())}
      disabled={disabled}
      aria-label={listening ? "音声入力を停止" : "音声入力を開始"}
      title={listening ? "音声入力を停止" : "音声入力 (認識結果をカーソル位置に追記)"}
      className={
        className ??
        `inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-50 ${
          listening
            ? "border-red-300 bg-red-50 text-red-600 animate-pulse"
            : "border-gray-300 bg-white text-gray-600 hover:bg-gray-50"
        }`
      }
    >
      {listening ? <Square size={12} /> : <Mic size={12} />}
      {listening ? "停止" : "音声"}
    </button>
  );
}
