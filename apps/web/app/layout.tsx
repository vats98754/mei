import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";
import { ConnectButton, ErrorBanner, WalletProvider } from "./wallet";

export const metadata: Metadata = {
  title: "mei",
  description: "Give your AI agent a capped USDC budget, without handing over your card or identity.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WalletProvider>
          <header className="topbar">
            <nav>
              <Link href="/" className="brand">
                mei
              </Link>
              <Link href="/">Wallet</Link>
              <Link href="/agents">Agents</Link>
            </nav>
            <ConnectButton />
          </header>
          <main>
            <ErrorBanner />
            {children}
          </main>
        </WalletProvider>
      </body>
    </html>
  );
}
