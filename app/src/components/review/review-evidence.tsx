"use client";
import { AssetIcon, Panel, StatusBadge } from "@/components/design";
import { Button } from "@/components/ui/button";
import { SampleDetails } from "@/components/dialogs";
import { figmaAssets } from "@/lib/figma-assets";
import { number, shorten } from "@/lib/mock/data";
import type { PayoutView, TradeView } from "@/lib/mock/types";

export function ReviewProgress({ unavailable }: { unavailable: boolean }) {
  const assets = figmaAssets.decoding;
  const steps = [
    "Fetch and cross-check transaction",
    "Decode payout instructions",
    "Match approved trade and version",
    "Verify client payment",
    "Check settlement policy",
    "Record on-chain verdict",
  ];
  return (
    <Panel className="gap-6">
      <h2>Independent settlement review</h2>
      {steps.map((label, index) => (
        <div key={label} className="flex items-center gap-4">
          <AssetIcon
            size={24}
            src={
              unavailable
                ? index === 0
                  ? figmaAssets.unavailable.imgIconClock
                  : figmaAssets.unavailable.imgIconClock1
                : index === 0
                  ? assets.imgIconCheck
                  : index === 1
                    ? assets.imgIconScan
                    : assets.imgIconClock
            }
          />
          <p className="flex-1 font-medium">{label}</p>
          <p
            className={
              index === 0
                ? unavailable
                  ? "text-warning text-xs"
                  : "text-success text-xs"
                : index === 1 && !unavailable
                  ? "text-info text-xs"
                  : "caption"
            }
          >
            {index === 0
              ? unavailable
                ? "Unavailable"
                : "Complete"
              : index === 1
                ? unavailable
                  ? "Not started"
                  : "In progress"
                : "Waiting"}
          </p>
        </div>
      ))}
      <div className="h-px bg-border" />
      <p className="text-muted-foreground">
        A decoded preview alone does not permit approval.
      </p>
    </Panel>
  );
}
export function ClientPaymentEvidence({
  payout,
  trade,
}: {
  payout: PayoutView;
  trade: TradeView;
}) {
  return (
    <Panel className="gap-3">
      <h2>Client payment evidence</h2>
      <StatusBadge
        tone={payout.clientReceived ? "success" : "warning"}
        className="w-fit"
      >
        {payout.clientReceived ? "Verified" : "Not received"}
      </StatusBadge>
      <div className="grid grid-cols-2 gap-6">
        <div>
          <p className="caption mb-1">Expected client payment</p>
          <p className="font-medium leading-5">
            {number(trade.clientAmount)} test USDT
          </p>
        </div>
        <div>
          <p className="caption mb-1">Received on-chain</p>
          <p
            className={
              payout.clientReceived
                ? "font-medium leading-5 text-success"
                : "font-medium leading-5 text-warning"
            }
          >
            {payout.clientReceived ? number(trade.clientAmount) : "0"} test USDT
          </p>
        </div>
      </div>
      <div className="h-px bg-border" />
      {payout.clientReceived ? (
        <>
          <p className="caption">
            Client testnet · 24 confirmations · Required minimum reached
          </p>
          <p className="caption">
            Desk deposit address · 6ac8…19d2 · Deposit not previously used
          </p>
          <SampleDetails
            title="Deposit transaction"
            content={
              <p>
                Sample transaction 74c8…e81a · Client payment of{" "}
                {number(trade.clientAmount)} test USDT.
              </p>
            }
          >
            <Button
              variant="link"
              className="h-auto justify-start p-0 text-xs leading-[18px] font-normal text-muted-foreground"
            >
              Deposit transaction · 74c8…e81a &nbsp; ↗
            </Button>
          </SampleDetails>
        </>
      ) : (
        <>
          <p className="caption">
            No confirmed payment found at the desk&apos;s deposit address.
          </p>
          <p className="caption">
            Deposit proof is required before a payout can execute.
          </p>
        </>
      )}
    </Panel>
  );
}
export function TradeComparison({
  payout,
  trade,
}: {
  payout: PayoutView;
  trade: TradeView;
}) {
  const destination = payout.destinationMatches
    ? shorten(trade.destination)
    : "9hK3…D9Qb";
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Panel className="gap-3 p-5">
        <p className="caption">Approved trade ticket</p>
        <div>
          {trade.id} · Version {trade.version}
          <br />
          {number(trade.payoutAmount)} test USDC
          <br />
          {trade.counterparty} · {shorten(trade.destination)}
        </div>
      </Panel>
      <Panel className="gap-3 p-5">
        <p
          className={
            payout.destinationMatches
              ? "text-success text-xs"
              : "text-destructive text-xs"
          }
        >
          Decoded payout
        </p>
        <div>
          {number(trade.payoutAmount)} test USDC → {destination}
          <br />
          {payout.destinationMatches
            ? "Asset, amount, and owner wallet match."
            : "Amount matches. Destination differs."}
          <br />
          {!payout.destinationMatches
            ? "Payout blocked."
            : !payout.clientReceived
              ? "Client payment missing."
              : "One TransferChecked instruction."}
        </div>
      </Panel>
    </div>
  );
}
export function PayoutDetails({
  payout,
  trade,
}: {
  payout: PayoutView;
  trade: TradeView;
}) {
  const actual = payout.destinationMatches
    ? trade.destination
    : "9hK3uETdPXn4R9wY2gA7cMv5KqH3zBfN6tLsVpXrD9Qb";
  return (
    <Panel className="gap-4">
      <h2>Payout details</h2>
      <div className="grid grid-cols-2 gap-6">
        <div>
          <p className="caption mb-1">Amount</p>
          <p>{number(trade.payoutAmount)} test USDC</p>
        </div>
        <div>
          <p className="caption mb-1">Recipient</p>
          <p>
            {payout.destinationMatches
              ? trade.counterparty + " · Verified wallet"
              : "Destination mismatch"}
          </p>
        </div>
      </div>
      <div className="h-px bg-border" />
      <div>
        <p className="caption mb-1">Recipient owner wallet</p>
        <p className="break-all">{actual}</p>
      </div>
      <p
        className={
          payout.destinationMatches
            ? "text-success text-xs"
            : "text-destructive text-xs"
        }
      >
        {payout.destinationMatches
          ? "Matches trade destination and counterparty registry."
          : "Does not match the trade's verified settlement wallet."}
      </p>
    </Panel>
  );
}
export function InstructionBreakdown({
  payout,
  trade,
}: {
  payout: PayoutView;
  trade: TradeView;
}) {
  return (
    <Panel className="gap-4">
      <h2>Instruction breakdown</h2>
      <div className="flex items-start gap-3">
        <AssetIcon
          src={
            payout.destinationMatches
              ? figmaAssets.review.imgIconCheck
              : figmaAssets.blocked.imgIconShield3
          }
        />
        <div className="space-y-2">
          <p className="font-medium leading-5">01 · Token transfer</p>
          <p className="text-muted-foreground">
            {payout.destinationMatches
              ? "Send " +
                number(trade.payoutAmount) +
                " test USDC from the settlement vault to " +
                trade.counterparty +
                "'s token account."
              : "Send " +
                number(trade.payoutAmount) +
                " test USDC to a wallet different from the approved trade."}
          </p>
        </div>
      </div>
      <p className="caption">
        1 instruction decoded · SPL Token / TransferChecked
      </p>
      <div className="h-px bg-border" />
      <SampleDetails
        title="Decoded instruction"
        content={
          <dl className="space-y-3">
            <div>
              <dt className="caption">Instruction</dt>
              <dd>TransferChecked</dd>
            </div>
            <div>
              <dt className="caption">Amount</dt>
              <dd>{number(trade.payoutAmount)} test USDC</dd>
            </div>
            <div>
              <dt className="caption">Destination owner</dt>
              <dd className="break-all">
                {payout.destinationMatches ? trade.destination : "9hK3…D9Qb"}
              </dd>
            </div>
          </dl>
        }
      >
        <Button
          variant="link"
          className="h-auto justify-start p-0 text-xs leading-[18px] font-normal text-muted-foreground"
        >
          Technical details &nbsp; ›
        </Button>
      </SampleDetails>
    </Panel>
  );
}
