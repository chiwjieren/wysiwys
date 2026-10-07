"use client";
import { useCallback, useEffect, useState } from "react";

// Display labels for member wallets, per treasury. They live only in this
// browser's localStorage and never go on-chain or to the server.
export const MEMBER_NAMES_KEY = "wysiwys.memberNames";
export const MEMBER_NAME_MAX = 40;
const CHANGED = "wysiwys.memberNames.changed";

type Names = Record<string, string>;
type Reader = Pick<Storage, "getItem">;
type Store = Pick<Storage, "getItem" | "setItem">;

function readAll(store: Reader): Record<string, Names> {
  try {
    const parsed: unknown = JSON.parse(store.getItem(MEMBER_NAMES_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, Names>)
      : {};
  } catch {
    return {};
  }
}

export function readMemberNames(store: Reader, multisig: string): Names {
  const names = readAll(store)[multisig];
  if (!names || typeof names !== "object") return {};
  return Object.fromEntries(
    Object.entries(names).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && !!entry[1],
    ),
  );
}

// Saves (or, when blank, clears) the label for one wallet of one treasury.
export function saveMemberName(
  store: Store,
  multisig: string,
  wallet: string,
  name: string,
) {
  const all = readAll(store);
  const names = { ...readMemberNames(store, multisig) };
  const label = name.trim().slice(0, MEMBER_NAME_MAX);
  if (label) names[wallet] = label;
  else delete names[wallet];
  all[multisig] = names;
  store.setItem(MEMBER_NAMES_KEY, JSON.stringify(all));
  return names;
}

// Label shown wherever members are listed. The connected wallet keeps the
// "You" marker.
export function memberDisplayName(
  address: string,
  index: number,
  names: Names,
  account?: string,
) {
  const name = names[address];
  if (address === account) return name ? `${name} · You` : "Your wallet · You";
  return name || `Member ${index + 1}`;
}

export function useMemberNames(multisig: string | undefined) {
  const [names, setNames] = useState<Names>({});
  useEffect(() => {
    if (!multisig) return setNames({});
    const load = () => {
      try {
        setNames(readMemberNames(localStorage, multisig));
      } catch {
        setNames({});
      }
    };
    load();
    window.addEventListener(CHANGED, load);
    window.addEventListener("storage", load);
    return () => {
      window.removeEventListener(CHANGED, load);
      window.removeEventListener("storage", load);
    };
  }, [multisig]);
  const save = useCallback(
    (wallet: string, name: string) => {
      if (!multisig) return false;
      try {
        saveMemberName(localStorage, multisig, wallet, name);
        window.dispatchEvent(new Event(CHANGED));
        return true;
      } catch {
        return false;
      }
    },
    [multisig],
  );
  return { names, save };
}
