import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/components/shell";
import { WalletProvider } from "@/lib/auth/provider";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "wysiwys",
  description: "What you see is what you sign. Shared Solana treasuries.",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <WalletProvider>
          <AppShell>{children}</AppShell>
        </WalletProvider>
      </body>
    </html>
  );
}
