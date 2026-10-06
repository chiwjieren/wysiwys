"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
export function CopyButton({
  value,
  label = "Copy",
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [feedback, setFeedback] = useState("");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setFeedback("Copied");
    } catch {
      setFeedback("Copy unavailable");
    }
  };
  return (
    <Button
      variant="secondary"
      className={className}
      onClick={copy}
      aria-live="polite"
    >
      {feedback || label}
    </Button>
  );
}
