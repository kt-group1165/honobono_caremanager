"use client";

import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { BusinessTypeProvider } from "@/lib/business-type-context";

export default function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <BusinessTypeProvider>
      <div className="flex h-full print:block print:h-auto">
        <Sidebar />
        <div className="flex flex-1 flex-col overflow-hidden print:overflow-visible print:block">
          <Header />
          <main className="flex-1 overflow-y-auto p-6 print:overflow-visible print:p-0">{children}</main>
        </div>
      </div>
    </BusinessTypeProvider>
  );
}
