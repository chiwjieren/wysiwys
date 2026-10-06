import Link from "next/link";
export default function States() {
  return (
    <div className="page-stack">
      <h1>Proposal states</h1>
      <p>Proposal status and votes are read from Squads on-chain accounts.</p>
      <Link href="/transactions" className="underline">
        View current proposals
      </Link>
    </div>
  );
}
