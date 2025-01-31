import { VersionedTransaction } from "@solana/web3.js";
import JSBI from "jsbi";
import fetch, { Response as NodeFetchResponse } from "node-fetch";

const USER_PUBLIC_KEY = process.env.USER_PUBLIC_KEY || "";

/***********************************************************************************************
 * Jupiter Integration
 * Enhanced with token validation and swap functionality
 ***********************************************************************************************/
async function getQuote(
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps: number = 5000
) {
  const amountBigInt = JSBI.BigInt(amount.toString());

  try {
    const quote = await fetch(
      `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountBigInt}&slippageBps=${slippageBps}`
    );
    return await quote.json();
  } catch (error) {
    console.error("Error getting quote:", error);
    return null;
  }
}

async function getSwapTx(
  quote: NodeFetchResponse,
  maxLamports: number,
  priorityLevel: string
) {
  const body = {
    quoteResponse: quote,
    userPublicKey: USER_PUBLIC_KEY,
    prioritizationFeeLamports: {
      priorityLevelWithMaxLamports: {
        maxLamports,
        priorityLevel, // If you want to land transaction fast, set this to use `veryHigh`. You will pay on average higher priority fee.
      },
    },
  };
  console.log("body:", body);
  const response = await fetch("https://quote-api.jup.ag/v6/swap", {
    method: "post",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  return await response.json();
}

export const getJupiterTx = async (
  address: string,
  amount: number,
  maxLamports: number,
  priorityLevel: string
) => {
  const quote = address
    ? await getQuote(
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC mint
        address,
        amount,
        5000
      )
    : null;

  const swapTx = quote
    ? await getSwapTx(quote as NodeFetchResponse, maxLamports, priorityLevel)
    : null;

  console.log("swapTx:", swapTx);
  // deserialize the transaction
  const swapTransactionBuf = Buffer.from(
    (swapTx as any).swapTransaction,
    "base64"
  );

  var transaction = VersionedTransaction.deserialize(swapTransactionBuf);

  return transaction;
};
