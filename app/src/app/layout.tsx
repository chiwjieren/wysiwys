import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/components/shell";

export const metadata: Metadata = {
  title: "OmniCounter",
  description: "No proof, no payout. OTC settlement firewall.",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
