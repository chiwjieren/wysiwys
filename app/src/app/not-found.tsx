import Link from "next/link";
import { Button } from "@/components/ui/button";
export default function NotFound() {
  return (
    <div className="page-stack">
      <h1>Page not found</h1>
      <p className="text-muted-foreground">
        Return to your treasury dashboard.
      </p>
      <Button asChild className="w-fit">
        <Link href="/">Dashboard</Link>
      </Button>
    </div>
  );
}
