"use client";
import { useEffect, useState } from "react";

// Polls a same-origin runner route every 15 seconds, like the chain reads.
// Error responses still carry a sanitized JSON body, so it is used as-is.
export function useRunnerPoll<T>(path: string, fallback: T) {
  const [data, setData] = useState<T>();
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch(path, { cache: "no-store" });
        const body = (await response.json()) as T;
        if (!cancelled) setData(body);
      } catch {
        if (!cancelled) setData(fallback);
      }
    }
    void load();
    const timer = setInterval(() => void load(), 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // The fallback is a constant per call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  return data;
}
