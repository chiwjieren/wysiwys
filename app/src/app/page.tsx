"use client";
import Link from "next/link";
import { useSquad } from "@/lib/squads/provider";
import { SquadDashboard } from "@/components/squads/live-squad";
import {
  AssetIcon,
  Avatar,
  PageHeader,
  Panel,
  SectionTitle,
  StatusBadge,
  commonIcons,
} from "@/components/design";
import { Button } from "@/components/ui/button";
import { InitiateSettlement, ReceiveAssets } from "@/components/dialogs";
import {
  mockActivity,
  mockHoldings,
  mockTrades,
  number,
} from "@/lib/mock/data";
import { getPayoutStatus } from "@/lib/mock/settlement";
import { useMockSettlement } from "@/lib/mock/provider";

export default function DashboardPage() {
  const { mode } = useSquad();
  const { payouts, now } = useMockSettlement();
  const visible = payouts.filter(
    (p) => p.id !== "unavailable" && p.stage !== "executed",
  );
  const approvals = visible.filter(
    (p) => getPayoutStatus(p, now, payouts) === "Needs approval",
  ).length;
  const missing = visible.filter((p) => !p.clientReceived).length;
  if (mode !== "sample") return <SquadDashboard />;
  return (
    <div className="page-stack gap-4">
      <PageHeader
        title="Dashboard"
        description="Monitor incoming client payments and outgoing settlement approvals."
      >
        <div className="flex gap-4">
          <ReceiveAssets>
            <Button variant="secondary" className="w-28">
              Receive
            </Button>
          </ReceiveAssets>
          <InitiateSettlement>
            <Button>+ Initiate settlement</Button>
          </InitiateSettlement>
        </div>
      </PageHeader>
      <div className="grid gap-4 md:grid-cols-[1.94fr_1fr_1fr]">
        {[
          ["Settlement vault", "$2,025,400.00", "Sample balances · USD"],
          [
            "Awaiting approval",
            String(approvals),
            "Review settlement evidence",
          ],
          ["Awaiting client payment", String(missing), "No proof, no payout"],
        ].map(([label, value, note]) => (
          <Panel key={label} className="gap-2.5">
            <p className="text-muted-foreground">{label}</p>
            <p className="text-4xl leading-[44px] font-semibold tabular-nums">
              {value}
            </p>
            <p className="caption">{note}</p>
          </Panel>
        ))}
      </div>
      <Panel className="gap-3">
        <SectionTitle>Token holdings</SectionTitle>
        <div className="table-scroll">
          <table className="data-table min-w-[540px] [&_th]:pb-3 [&_td]:py-3 [&_tbody_tr]:h-[87px] [&_tbody_tr:last-child]:h-[74px] [&_tbody_tr:last-child_td]:pb-0">
            <thead>
              <tr>
                <th className="w-[40%]">Asset</th>
                <th>Balance</th>
                <th>Sample value</th>
              </tr>
            </thead>
            <tbody>
              {mockHoldings.map((h) => (
                <tr key={h.name}>
                  <td>
                    <div className="flex items-center gap-3">
                      <Avatar initials={h.symbol} />
                      <div>
                        <p>{h.name}</p>
                        <p className="caption">{h.detail}</p>
                      </div>
                    </div>
                  </td>
                  <td>{h.balance}</td>
                  <td>{h.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel className="gap-3">
        <SectionTitle
          action={
            <Button asChild variant="secondary" className="w-24">
              <Link href="/transactions">View all</Link>
            </Button>
          }
        >
          Pending approvals
        </SectionTitle>
        <div className="border-t table-scroll">
          <table className="w-full min-w-[720px] [&_td]:pt-3">
            <tbody>
              {visible
                .filter((p) => p.id !== "101")
                .slice(0, 3)
                .map((p) => {
                  const t = mockTrades.find((t) => t.id === p.tradeId)!;
                  const status = getPayoutStatus(p, now, payouts);
                  const passed =
                    status === "Needs approval" || status === "Ready";
                  return (
                    <tr key={p.id} className="h-[68px]">
                      <td className="w-[39%]">
                        <p className="font-medium">
                          {t.id} · {t.counterparty}
                        </p>
                        <p className="caption">Today · Proposed by Jun Heng</p>
                      </td>
                      <td className="w-[17%]">{number(t.payoutAmount)} USDC</td>
                      <td>
                        <StatusBadge
                          tone={
                            passed
                              ? "success"
                              : status === "Blocked" && p.clientReceived
                                ? "danger"
                                : "info"
                          }
                        >
                          {status === "Decoding"
                            ? "Decoding"
                            : passed
                              ? "Policy passed"
                              : !p.clientReceived
                                ? "Awaiting deposit"
                                : status}
                        </StatusBadge>
                      </td>
                      <td className="caption">
                        {p.clientReceived
                          ? p.votes + " / 3 approvals"
                          : "Client payment missing"}
                      </td>
                      <td className="text-right">
                        <Button
                          asChild
                          variant="secondary"
                          className="w-[108px]"
                        >
                          <Link href={"/transactions/" + p.id}>
                            {p.clientReceived ? "Review" : "Details"}
                          </Link>
                        </Button>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
          {visible.length === 0 && (
            <p className="py-6 text-muted-foreground">
              All payouts are complete. Initiate settlement from an approved
              trade.
            </p>
          )}
        </div>
      </Panel>
      <Panel className="gap-3">
        <SectionTitle>Recent activity</SectionTitle>
        <div className="space-y-3">
          {mockActivity.map((activity) => (
            <div key={activity.text} className="flex items-center gap-3">
              <AssetIcon src={commonIcons.clock} size={16} />
              <p className="flex-1">{activity.text}</p>
              <p className="caption">{activity.time}</p>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
