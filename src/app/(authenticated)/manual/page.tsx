import type { Metadata } from "next";
import { ManualContent } from "./manual-content";

export const metadata: Metadata = {
  title: "操作マニュアル | 介護管理システム",
};

export default function ManualPage() {
  return <ManualContent />;
}
