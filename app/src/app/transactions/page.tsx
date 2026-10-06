"use client";
import Link from "next/link";
import { useSquad } from "@/lib/squads/provider";
import { SquadDashboard } from "@/components/squads/live-squad";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { InitiateSettlement } from "@/components/dialogs";
import { PageHeader, Panel, StatusBadge } from "@/components/design";
import { mockTrades, number } from "@/lib/mock/data";
import { getPayoutStatus } from "@/lib/mock/settlement";
import { useMockSettlement } from "@/lib/mock/provider";

const filters = [
  "All transactions",
  "Needs approval",
  "Ready",
  "Executed",
  "Blocked",
] as const;
export default function TransactionsPage() {
  const { mode } = useSquad();
  const { payouts, now } = useMockSettlement();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<string>("All transactions");
  const shown = payouts.filter((p) => {
    const trade = mockTrades.find((t) => t.id === p.tradeId)!;
    const matchesQuery = (trade.id + " " + trade.counterparty + " " + p.id)
      .toLowerCase()
      .includes(query.toLowerCase());
    const status = getPayoutStatus(p, now, payouts);
    const matchesFilter =
      filter === "All transactions" ||
      filter === status ||
      (filter === "Executed" && status === "Settled") ||
      (filter === "Blocked" && status === "Expired");
    return p.id !== "unavailable" && matchesQuery && matchesFilter;
  });
  if (mode !== "sample") return <SquadDashboard transactions />;
  return (
    <div className="page-stack">
      <PageHeader
        title="Transactions"
        description="Trade-bound payout proposals, client payment evidence, and approvals."
      >
        <InitiateSettlement>
          <Button>+ Initiate settlement</Button>
        </InitiateSettlement>
      </PageHeader>
      <Tabs defaultValue="payouts" className="gap-6">
        <TabsList className="h-10 justify-start gap-3 bg-transparent p-0">
          {["Approved trades", "Payout proposals"].map((name, index) => (
            <TabsTrigger
              key={name}
              value={index === 0 ? "trades" : "payouts"}
              className="h-10 flex-none w-[172px] rounded-lg border-0 bg-secondary text-foreground shadow-none data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
            >
              {name}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="payouts" className="space-y-6">
          <div className="flex flex-wrap gap-3">
            <Input
              aria-label="Search payouts"
              placeholder="Search trade ID, counterparty, or payout"
              className="h-12 min-w-[220px] flex-1 bg-secondary"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {filters.map((f) => (
              <Button
                key={f}
                variant="secondary"
                className="h-12"
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
              >
                {f}
              </Button>
            ))}
          </div>
          <Panel>
            <div className="table-scroll">
              <table className="data-table min-w-[960px]">
                <thead>
                  <tr>
                    {[
                      "Trade / counterparty",
                      "Payout",
                      "Client payment",
                      "Guard",
                      "Votes",
                      "Status",
                      "",
                    ].map((h, i) => (
                      <th key={i} className={i === 0 ? "w-[24%]" : ""}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((p) => {
                    const t = mockTrades.find((t) => t.id === p.tradeId)!;
                    const status = getPayoutStatus(p, now, payouts);
                    const blocked =
                      status === "Blocked" || status === "Expired";
                    return (
                      <tr key={p.id} className="h-[88px]">
                        <td>
                          <p className="font-medium">{t.id}</p>
                          <p className="caption">
                            {t.counterparty} · Version {t.version}
                          </p>
                        </td>
                        <td>{number(t.payoutAmount)} USDC</td>
                        <td
                          className={
                            p.clientReceived
                              ? "text-success text-xs"
                              : "text-warning text-xs"
                          }
                        >
                          {p.clientReceived ? "Received" : "Not received"}
                        </td>
                        <td>
                          <StatusBadge
                            tone={
                              blocked
                                ? "danger"
                                : p.stage === "decoding"
                                  ? "info"
                                  : "success"
                            }
                          >
                            {blocked
                              ? status === "Expired"
                                ? "Expired"
                                : !p.destinationMatches
                                  ? "Mismatch"
                                  : !p.clientReceived
                                    ? "Missing proof"
                                    : "Blocked"
                              : p.stage === "decoding"
                                ? "Decoding"
                                : "Passed"}
                          </StatusBadge>
                        </td>
                        <td>{p.votes} / 3</td>
                        <td className="caption">{status}</td>
                        <td className="text-right">
                          <Button
                            asChild
                            variant="secondary"
                            className="w-[108px]"
                          >
                            <Link href={"/transactions/" + p.id}>Review</Link>
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {shown.length === 0 && (
                <p className="py-8 text-center text-muted-foreground">
                  No payouts match your search.
                </p>
              )}
            </div>
          </Panel>
          <p className="caption">
            Client payment, guard verdict, signer votes, and trade settlement
            status are tracked separately.
          </p>
        </TabsContent>
        <TabsContent value="trades" className="space-y-6">
          <Panel>
            <div className="table-scroll">
              <table className="data-table min-w-[960px]">
                <thead>
                  <tr>
                    {[
                      "Trade / counterparty",
                      "Client pays",
                      "Desk sends",
                      "Ticket status",
                      "",
                    ].map((h, i) => (
                      <th key={i}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {mockTrades
                    .filter((t) => t.id !== "OTC-10425")
                    .map((t) => {
                      const settled = payouts.some(
                        (p) => p.tradeId === t.id && p.tradeSettled,
                      );
                      return (
                        <tr key={t.id} className="h-[88px]">
                          <td>
                            <p className="font-medium">{t.id}</p>
                            <p className="caption">
                              {t.counterparty} · Version {t.version}
                            </p>
                          </td>
                          <td>
                            {number(t.clientAmount)} test USDT
                            <p className="caption">Client testnet</p>
                          </td>
                          <td>
                            {number(t.payoutAmount)} test USDC
                            <p className="caption">Solana Devnet</p>
                          </td>
                          <td
                            className={
                              t.status === "Approved"
                                ? "text-success text-xs"
                                : "caption"
                            }
                          >
                            {settled
                              ? "Settled"
                              : t.id === "OTC-10427"
                                ? "Approved · Payout #103"
                                : t.status}
                          </td>
                          <td className="text-right">
                            {settled || t.status !== "Approved" ? (
                              <Button
                                variant="secondary"
                                className="w-[204px]"
                                disabled
                              >
                                Unavailable
                              </Button>
                            ) : t.id === "OTC-10427" ? (
                              <Button
                                asChild
                                variant="secondary"
                                className="w-[204px]"
                              >
                                <Link href="/transactions/103">
                                  View payout
                                </Link>
                              </Button>
                            ) : (
                              <InitiateSettlement tradeId={t.id}>
                                <Button className="w-[204px]">
                                  Initiate settlement
                                </Button>
                              </InitiateSettlement>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </Panel>
          <p className="caption">
            Trade approval and client-payment verification are separate checks.
          </p>
        </TabsContent>
      </Tabs>
    </div>
  );
}
