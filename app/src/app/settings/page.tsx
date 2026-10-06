"use client";
import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { PageHeader, Panel, StatusBadge } from "@/components/design";
import {
  CopyButton,
  InfrastructureDialog,
  SampleDetails,
} from "@/components/dialogs";
import { mockDesk } from "@/lib/mock/data";

export default function SettingsPage() {
  const [theme, setTheme] = useState("dark");
  const [connected, setConnected] = useState(true);
  const changeTheme = (value: string) => {
    setTheme(value);
    document.documentElement.dataset.theme = value;
  };
  return (
    <div className="page-stack">
      <PageHeader
        title="Settings"
        description="Desk information, policy verification, and display preferences."
      />
      <div className="grid items-start gap-6 xl:grid-cols-2">
        <div className="space-y-6">
          <Panel className="gap-4">
            <h2>Treasury information</h2>
            <div className="h-px bg-border" />
            {[
              ["Name", mockDesk.name],
              ["Network", "Solana Devnet"],
            ].map(([label, value]) => (
              <div key={label}>
                <p className="caption mb-1">{label}</p>
                <p>{value}</p>
              </div>
            ))}
            <div>
              <p className="caption mb-1">Vault address</p>
              <div className="flex items-center gap-3">
                <p>7nYp…8qLm</p>
                <CopyButton
                  value={mockDesk.vault}
                  label="Copy"
                  className="h-auto bg-transparent p-0"
                />
                <SampleDetails
                  title="Vault record"
                  content={<p className="break-all">{mockDesk.vault}</p>}
                >
                  <Button variant="ghost" className="h-auto p-0">
                    Explorer
                  </Button>
                </SampleDetails>
              </div>
            </div>
            <div>
              <p className="caption mb-1">Multisig address</p>
              <div className="flex items-center gap-3">
                <p>{mockDesk.multisig}</p>
                <SampleDetails
                  title="Multisig record"
                  content={
                    <p>
                      Replace sample addresses with deployments/devnet.json
                      during integration.
                    </p>
                  }
                >
                  <Button variant="ghost" className="h-auto p-0">
                    Copy / Explorer
                  </Button>
                </SampleDetails>
              </div>
            </div>
            <div>
              <p className="caption mb-1">Approval threshold</p>
              <p>3 of 3 human signers</p>
            </div>
          </Panel>
          <Panel className="gap-4">
            <h2>Your preferences</h2>
            <div className="flex items-center justify-between gap-3">
              <p>Appearance</p>
              <div className="flex gap-3">
                {["dark", "light"].map((value) => (
                  <Button
                    key={value}
                    variant="secondary"
                    className="w-28 capitalize"
                    aria-pressed={theme === value}
                    onClick={() => changeTheme(value)}
                  >
                    {value}
                  </Button>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between gap-3">
              <p>Default explorer</p>
              <SampleDetails
                title="Default explorer"
                content={
                  <p>
                    Solana Explorer is selected. Explorer links will use
                    deployed addresses when the backend is connected.
                  </p>
                }
              >
                <Button variant="secondary">Solana Explorer</Button>
              </SampleDetails>
            </div>
            <div className="h-px bg-border" />
            <div className="flex items-center justify-between gap-3">
              <p>
                {connected
                  ? "Connected as Zhi Jian"
                  : "Sample wallet disconnected"}
              </p>
              <Button
                variant="secondary"
                className="w-40"
                onClick={() => setConnected(!connected)}
              >
                {connected ? "Disconnect" : "Connect"}
              </Button>
            </div>
          </Panel>
        </div>
        <div className="space-y-6">
          <Panel className="gap-4">
            <h2>Settlement policy</h2>
            <StatusBadge className="min-w-0 w-24">Read only</StatusBadge>
            <p className="text-muted-foreground">
              Every payout must match its approved trade.
            </p>
            <div className="h-px bg-border" />
            {[
              [
                "Trade binding",
                "Exact asset, amount, destination, and trade version",
              ],
              [
                "Proof before payout",
                "Client payment received and sufficiently confirmed",
              ],
              [
                "Counterparty verification",
                "Registered settlement wallet · Status checks",
              ],
              [
                "Instruction restrictions",
                "No authority changes, delegates, or unexpected actions",
              ],
              [
                "Confidential checks",
                "Risk and exposure rules are evaluated privately",
              ],
            ].map(([label, value]) => (
              <div key={label}>
                <p className="caption mb-1">{label}</p>
                <p>{value}</p>
              </div>
            ))}
            <p className="caption">
              Policy version {mockDesk.policyVersion} · Hash{" "}
              {mockDesk.policyHash}
            </p>
          </Panel>
          <Panel className="gap-4">
            <h2>Guard configuration</h2>
            <p className="caption">
              Policy version {mockDesk.policyVersion} · Hash{" "}
              {mockDesk.policyHash}
            </p>
            <p className="text-muted-foreground">
              Forwarder and policy hash are fixed at setup.
            </p>
            <div className="h-px bg-border" />
            <p className="caption">Guard program · {mockDesk.guard}</p>
            <p className="caption">Executor · {mockDesk.executor}</p>
            <p className="caption">
              RPC infrastructure · Helius / Alchemy / QuickNode
            </p>
            <InfrastructureDialog>
              <Button
                variant="link"
                className="h-auto justify-start p-0 text-xs text-muted-foreground"
              >
                Provider and network health &nbsp; ›
              </Button>
            </InfrastructureDialog>
          </Panel>
        </div>
      </div>
      <Link href="/status" className="caption w-fit hover:text-foreground">
        Verification status &nbsp; ›
      </Link>
    </div>
  );
}
