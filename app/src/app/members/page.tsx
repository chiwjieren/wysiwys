import {
  PageHeader,
  Panel,
  StatusBadge,
  Avatar,
  AssetIcon,
} from "@/components/design";
import { figmaAssets } from "@/lib/figma-assets";
import { mockDesk, mockMembers } from "@/lib/mock/data";

export default function MembersPage() {
  return (
    <div className="page-stack">
      <PageHeader
        title="Members"
        description="Who can propose, approve, and execute treasury transactions."
      >
        <StatusBadge className="w-44">3 of 3 required</StatusBadge>
      </PageHeader>
      <Panel className="flex-row items-center gap-4">
        <AssetIcon src={figmaAssets.members.imgIconMembers1} size={24} />
        <div className="flex-1 space-y-2">
          <h2>Every signer must approve</h2>
          <p className="text-muted-foreground">
            All three human members vote. The guard executor does not count
            toward the threshold.
          </p>
        </div>
        <StatusBadge className="hidden w-[172px] sm:inline-flex">
          Fixed for v1
        </StatusBadge>
      </Panel>
      <Panel className="gap-4">
        <h2>Human signers</h2>
        <div className="table-scroll">
          <table className="data-table min-w-[600px]">
            <thead>
              <tr>
                <th className="w-[36%]">Member</th>
                <th>Wallet address</th>
                <th className="w-[28%]">Permissions</th>
              </tr>
            </thead>
            <tbody>
              {[mockMembers[2], mockMembers[0], mockMembers[1]].map(
                (member) => (
                  <tr key={member.initials} className="h-[112px]">
                    <td>
                      <div className="flex items-center gap-3">
                        <Avatar initials={member.initials} />
                        <p className="font-medium">{member.name}</p>
                      </div>
                    </td>
                    <td>{member.wallet} &nbsp; ↗</td>
                    <td>
                      <div className="flex gap-2">
                        <StatusBadge className="min-w-0 w-[100px]">
                          Propose
                        </StatusBadge>
                        <StatusBadge className="min-w-0 w-[80px]">
                          Vote
                        </StatusBadge>
                      </div>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel className="gap-5">
        <h2>Guard executor</h2>
        <div className="flex items-center gap-4">
          <AssetIcon src={figmaAssets.members.imgIconShield2} size={32} />
          <div className="flex-1 space-y-2">
            <h2>OmniCounter Guard</h2>
            <p className="caption">Executor PDA · {mockDesk.executor}</p>
            <p className="text-muted-foreground">
              Executes only after policy approval and all required votes. Cannot
              propose or vote.
            </p>
          </div>
          <StatusBadge
            tone="success"
            className="hidden w-[200px] sm:inline-flex"
          >
            Execute only
          </StatusBadge>
        </div>
      </Panel>
      <p className="caption">
        Membership and permission changes are outside the first-version scope.
      </p>
    </div>
  );
}
