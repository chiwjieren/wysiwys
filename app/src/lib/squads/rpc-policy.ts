const methods = new Set([
  "getAccountInfo",
  "getMultipleAccounts",
  "getBalance",
  "getTokenAccountsByOwner",
  "getLatestBlockhash",
  "getBlockHeight",
  "getSignatureStatuses",
  "getSignaturesForAddress",
  "sendTransaction",
  "getGenesisHash",
]);
export function validateRpcRequest(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid RPC request.");
  const request = input as Record<string, unknown>;
  if (
    request.jsonrpc !== "2.0" ||
    typeof request.method !== "string" ||
    !methods.has(request.method) ||
    !Array.isArray(request.params)
  )
    throw new Error("RPC method is not allowed.");
  if (
    !["sendTransaction", "getSignatureStatuses", "getGenesisHash"].includes(
      request.method,
    )
  ) {
    const options = request.params.at(-1);
    if (
      !options ||
      typeof options !== "object" ||
      options.commitment !== "finalized"
    )
      throw new Error("RPC reads require finalized commitment.");
  }
  return request as {
    jsonrpc: string;
    id: unknown;
    method: string;
    params: unknown[];
  };
}
