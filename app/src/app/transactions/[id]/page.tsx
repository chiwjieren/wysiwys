import { ReviewScreen } from "@/components/review/review-screen";

export default async function PayoutPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ReviewScreen id={id} />;
}
