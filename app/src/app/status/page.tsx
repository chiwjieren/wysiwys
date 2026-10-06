import Link from "next/link";
import { PageHeader, Panel, StatusBadge } from "@/components/design";
import { Button } from "@/components/ui/button";
import { mockProviders } from "@/lib/mock/data";

export default function StatusPage() {
  return (
    <div className="page-stack">
      <PageHeader
        title="Verification infrastructure"
        description="Technical status · Sample data"
      />
      <Panel className="max-w-[548px] gap-4">
        {mockProviders.map((p) => (
          <div key={p} className="flex items-center justify-between">
            <p className="font-medium">{p}</p>
            <StatusBadge className="w-[152px]">Configured</StatusBadge>
          </div>
        ))}
        <div className="h-px bg-border" />
        <p className="caption">Active networks are configured per provider.</p>
        <p className="caption">
          Client-payment network selection is pending backend setup.
        </p>
        <p>RPC cross-check: sources must agree</p>
        <p>Listener and CRE runner: health shown here</p>
        <Button asChild variant="secondary" className="w-fit">
          <Link href="/transactions/unavailable">View unavailable state</Link>
        </Button>
      </Panel>
      <Button asChild variant="secondary" className="w-fit">
        <Link href="/transactions/states">View settlement states</Link>
      </Button>
    </div>
  );
}
