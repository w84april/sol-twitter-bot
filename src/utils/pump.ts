import { VersionedTransaction } from "@solana/web3.js";

export const getPumpTx = async (
  address: string,
  amount: string,
  priorityLevel: string
) => {
  if (!address) {
    throw new Error("Address is required");
  }

  const body = {
    wallet: process.env.USER_PUBLIC_KEY,
    type: "BUY",
    mint: address,
    inAmount: amount,
    priorityFeeLevel: priorityLevel === "veryHigh" ? "extreme" : priorityLevel,
    slippageBps: "5000",
  };

  const response = await fetch("https://public.jupiterapi.com/pump-fun/swap", {
    method: "post",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  const data = await response.json();

  const swapTransactionBuf = Buffer.from((data as any).tx, "base64");

  var transaction = VersionedTransaction.deserialize(swapTransactionBuf);

  return transaction;
};
