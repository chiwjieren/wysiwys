import { PageHeader, Panel, StatusBadge } from "@/components/design";
import { Button } from "@/components/ui/button";

// Presentation examples from Figma, not protocol reason-code definitions.
const states = [
  [
    "Expired trade",
    "The approved trade is past its validity window. Initiate settlement is unavailable.",
    "TRADE_EXPIRED",
  ],
  [
    "Cancelled trade",
    "The trade was cancelled. No payout proposal can be initiated for it.",
    "TRADE_CANCELLED",
  ],
  [
    "Already settled",
    "This trade has already settled. Prevent another payout for the same trade.",
    "TRADE_ALREADY_SETTLED",
  ],
  [
    "Amount or asset mismatch",
    "Trade requires 500,000 USDC. Decoded payout requests 500,100 USDC. Payout blocked.",
    "AMOUNT_MISMATCH / ASSET_MISMATCH",
  ],
  [
    "Data sources disagree",
    "The independent RPC reads disagree. The workflow rejects the review and payout remains blocked.",
    "RPC_NO_CONSENSUS",
  ],
  [
    "Unexpected instruction",
    "The payout contains an authority change, delegate, durable nonce, or unsupported instruction.",
    "UNEXPECTED_INSTRUCTION",
  ],
];
export default function SettlementStatesPage() {
  return (
    <div className="page-stack">
      <PageHeader
        title="Settlement states"
        description="Clear outcomes for trade eligibility, payout matching, and policy failures."
      />
      <div className="grid gap-6 md:grid-cols-2">
        {states.map(([title, body, reason]) => (
          <Panel key={title} className="gap-4">
            <StatusBadge tone="danger" className="w-fit">
              Unavailable
            </StatusBadge>
            <h2>{title}</h2>
            <p className="text-muted-foreground">{body}</p>
            <p className="caption">{reason}</p>
            <Button disabled variant="secondary" className="w-[220px]">
              Payout unavailable
            </Button>
          </Panel>
        ))}
      </div>
    </div>
  );
}
