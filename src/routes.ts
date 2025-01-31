import express, { Request, NextFunction, Response } from "express";
import { verifyWebhookSignature } from "@hookdeck/sdk/webhooks/helpers";
import Tesseract from "tesseract.js";
import fetch, { Response as NodeFetchResponse } from "node-fetch";
import { IncomingHttpHeaders } from "http";
import { Request as ExpressRequest } from "express";
import { TOKEN_PROGRAM_ID, Token } from "@solana/spl-token";
import { getJupiterTx } from "./utils/jupiter";

import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import JSBI from "jsbi";

import bs58 from "bs58";

import "dotenv/config";
import { TokenInfo } from "../types/express";
import { getPumpTx } from "./utils/pump";

const BLOCKED_TOKENS = [
  "4Cnk9EPnW5ixfLZatCPJjDB1PUtcRpVVgTQukm9epump".toLowerCase(),
  // "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN".toLowerCase(),
  "FUAfBo2jgks6gB4Z4LfZkqSZgzNucisEHqnNebaRxM1P".toLowerCase(),
];

const USER_PUBLIC_KEY = process.env.USER_PUBLIC_KEY || "";

const SECRET: string = import.meta.env.VITE_HOOKDECK_SIGNING_SECRET || "";

const privateKey = bs58.decode(process.env.PRIVATE_KEY || "");
const from = Keypair.fromSecretKey(privateKey);

const router = express.Router();

if (!SECRET) {
  console.warn("No Hookdeck Signing Secret set!");
}

const verifyHookdeckSignature = async (
  req: ExpressRequest,
  res: Response,
  next: NextFunction
) => {
  if (!SECRET) {
    console.warn(
      "No Hookdeck Signing Secret: Skipping webhook verification. Do not do this in production!"
    );
    return next();
  }

  const headers: { [key: string]: string } = {};
  const incomingHeaders = req.headers as IncomingHttpHeaders;

  for (const [key, value] of Object.entries(incomingHeaders)) {
    headers[key] = value as string;
  }

  const rawBody = req.rawBody.toString();

  const result = await verifyWebhookSignature({
    headers,
    rawBody,
    signingSecret: SECRET,
    config: {
      checkSourceVerification: false,
    },
  });

  if (!result.isValidSignature) {
    console.log("Signature is invalid, rejected");
    res.sendStatus(401);
  } else {
    console.log("Signature is valid, accepted");
    next();
  }
};

/***********************************************************************************************
 * Solana Address Detection
 * Regular expression to match Solana addresses:
 * - Must be between 32-44 characters
 * - Can only contain Base58 characters (alphanumeric without 0, O, I, l)
 ***********************************************************************************************/
const SOLANA_ADDRESS_REGEX = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

/***********************************************************************************************
 * Image Processing Functions
 * These functions handle downloading and OCR processing of images
 * to extract text that might contain Solana addresses
 ***********************************************************************************************/
async function downloadImage(url: string): Promise<Buffer> {
  const response = await fetch(url);
  return Buffer.from(await response.arrayBuffer());
}

async function extractTextFromImage(imageBuffer: Buffer): Promise<string> {
  const worker = await Tesseract.createWorker();

  const {
    data: { text },
  } = await worker.recognize(imageBuffer);
  await worker.terminate();

  return text;
}

/***********************************************************************************************
 * Solana Address Validator
 * Uses PublicKey from @solana/web3.js to validate addresses:
 * - Checks if the string can be converted to a valid PublicKey
 * - Validates the checksum
 * - Ensures proper Base58 encoding
 ***********************************************************************************************/
function isValidSolanaAddress(address: string): boolean {
  try {
    const publicKey = new PublicKey(address);
    // toString() will throw if the public key is invalid
    return publicKey.toBase58() === address;
  } catch (error) {
    return false;
  }
}

/***********************************************************************************************
 * Text Normalization
 * Converts common homoglyphs to their Latin equivalents
 * Handles Cyrillic, Greek, and other similar-looking characters
 ***********************************************************************************************/
const homoglyphMap: { [key: string]: string } = {
  А: "A", // Cyrillic -> Latin
  В: "B",
  С: "C",
  Е: "E",
  Н: "H",
  І: "I",
  Ј: "J",
  К: "K",
  М: "M",
  О: "O",
  Р: "P",
  Ѕ: "S",
  Т: "T",
  Υ: "Y",
  Χ: "X",
  Ζ: "Z",
  а: "a",
  е: "e",
  о: "o",
  р: "p",
  с: "c",
  у: "y",
  х: "x",
};

function normalizeText(text: string): string {
  return (
    text
      // First, apply NFKC normalization (combines characters and converts compatibility characters)
      .normalize("NFKC")
      // Then replace known homoglyphs
      .split("")
      .map((char) => homoglyphMap[char] || char)
      .join("")
  );
}

/***********************************************************************************************
 * Jupiter Integration
 * Setup Jupiter connection and swap functions
 * Supports finding best routes and executing swaps
 ***********************************************************************************************/
const connection = new Connection(
  process.env.RPC_URL || "https://api.mainnet-beta.solana.com"
);

/***********************************************************************************************
 * Token Information
 * Fetches detailed token information including:
 * - Supply
 * - Decimals
 * - Token metadata if available
 ***********************************************************************************************/
async function getTokenInfo(address: string): Promise<TokenInfo | null> {
  try {
    const mint = new PublicKey(address);
    const token = new Token(
      connection,
      mint,
      TOKEN_PROGRAM_ID,
      // @ts-ignore - dummy signer for readonly operations
      null
    );

    const supply = await token.getMintInfo();
    if (!supply.decimals) {
      return null;
    }
    return {
      address,
      decimals: supply.decimals,
      supply: supply.supply.toString(),
      isInitialized: supply.isInitialized,
    };
  } catch (error) {
    console.error("Error getting token info:", error);
    return null;
  }
}

const getAmount = (address: string, user: string) => {
  if (user === "DaniilP86141") {
    if (address.includes("pump")) {
      return 10000000; // 0.01 SOL
    }
    return 100000; // 0.1 USDC
  }

  if (address.includes("pump")) {
    return 500000000; // 0.5 SOL
  }
  return 1000000000; // 1000 USDC
};

/***********************************************************************************************
 * Webhook Handler
 * Now includes text normalization before processing
 ***********************************************************************************************/
router.post(
  "/webhooks",
  verifyHookdeckSignature,
  async (req: Request, res: Response) => {
    try {
      console.log("pump");
      const user = req.body.task?.user;
      const text = (req.body.data?.text || "").replace(/\s+/g, ""); // text from the image parsed by tweet-catcher
      const fulltext = req.body.data?.full_text || "";
      const imageUrl = req.body.data?.image;

      let maxLamports;
      if (user === "DaniilP86141") {
        maxLamports = 100000000; // 0.1 SOL
      } else {
        maxLamports = 1000000000; // 1 SOL
      }

      let priorityLevel;
      if (user === "DaniilP86141") {
        priorityLevel = "medium";
      } else {
        priorityLevel = "veryHigh";
      }

      // Normalize all text inputs
      let combinedText = normalizeText(fulltext + " " + text);

      // Process image if present
      if (imageUrl) {
        try {
          console.log("Processing image:", imageUrl);
          const imageBuffer = await downloadImage(imageUrl);
          const imageText = await extractTextFromImage(imageBuffer);
          // Also normalize the text extracted from image
          combinedText += " " + normalizeText(imageText);
          console.log("Normalized text from image:", normalizeText(imageText));
        } catch (error) {
          console.error("Error processing image:", error);
        }
      }

      console.log("Normalized combined text:", combinedText);

      // Find all potential Solana addresses in the normalized text
      const matches = [];

      for (let i = 0; i < combinedText.length; i++) {
        const word = combinedText.slice(i, i + 45);
        const match = word.match(SOLANA_ADDRESS_REGEX);
        if (match) {
          matches.push(match[0]);
        }
      }
      console.log("Reg exp matches:", matches);
      if (matches && matches.length > 0) {
        // Filter valid addresses
        const validAddresses = matches.filter(
          (address) =>
            isValidSolanaAddress(address) &&
            !BLOCKED_TOKENS.includes(address.toLowerCase())
        );

        console.log("validAddresses:", validAddresses);
        if (validAddresses.length > 0) {
          // For each valid token address, get price info
          const tokenInfoPromises = validAddresses.map(async (address) => {
            return new Promise(async (resolve, reject) => {
              try {
                const tokenInfo = await getTokenInfo(address);
                console.log("tokenInfo:", tokenInfo);

                if (tokenInfo) {
                  resolve(tokenInfo);
                } else {
                  reject(new Error("No token info found"));
                }
              } catch (error) {
                reject(error);
              }
            });
          });

          console.log("tokenInfoPromises:", tokenInfoPromises);

          const tokenInfo = (await Promise.any(
            tokenInfoPromises
          )) as TokenInfo | null;

          console.log("tokenInfo:", tokenInfo);

          // const transaction = await getJupiterTx(
          //   tokenInfo?.address,
          //   amount,
          //   maxLamports,
          //   priorityLevel
          // );
          const amount = getAmount(tokenInfo?.address, user);
          console.log("amount:", amount);
          const transaction = await getPumpTx(
            tokenInfo?.address,
            amount.toString(),
            priorityLevel
          );

          console.log("pumpfun transaction:", transaction);

          // sign the transaction.
          transaction.sign([from]);

          // get the latest block hash
          const latestBlockHash = await connection.getLatestBlockhash();
          console.log("latestBlockHash:", latestBlockHash);
          // Execute the transaction
          const rawTransaction = transaction.serialize();
          console.log("rawTransaction:", rawTransaction);
          const txid = await connection.sendRawTransaction(rawTransaction, {
            skipPreflight: true,
            maxRetries: 10,
          });
          console.log("txid:", txid);
          await connection.confirmTransaction({
            blockhash: latestBlockHash.blockhash,
            lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
            signature: txid,
          });
          console.log(`https://solscan.io/tx/${txid}`);
        } else {
          res.send({
            status: "success",
            message: "No valid token addresses found",
          });
          return;
        }
      } else {
        console.log("No potential Solana addresses found in text or image");
      }

      res.send({
        status: "success",
        message: "Successfully processed webhook for Solana addresses",
        source: imageUrl ? "text and image" : "text only",
      });
    } catch (error) {
      console.error("Error processing webhook:", error);
      res.status(500).send({
        status: "error",
        message: "Error processing webhook",
        error: error.message,
      });
    }
  }
);

/***********************************************************************************************
 * Error Handler
 * Global error handler for the router
 ***********************************************************************************************/
router.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error("Router Error:", err);
  res.status(500).send({
    status: "error",
    message: "Internal server error",
    error: err.message,
  });
});

export default router;
