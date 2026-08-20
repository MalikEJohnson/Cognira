import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { one, run } from "./db.js";
import { grantMembership, PLANS, type PlanId } from "./membership.js";

/**
 * Payment in USDC on Solana.
 *
 * The server only ever builds an UNSIGNED transaction and verifies what landed
 * on chain afterwards. Signing and sending happen in the visitor's own wallet;
 * no key material reaches this process, and the treasury address is a public
 * address supplied by config.
 *
 * Prices are denominated in USDC rather than SOL on purpose: the plans are USD
 * amounts, and pricing them in SOL would mean the cost drifting with the market
 * between the moment a page renders and the moment someone clicks pay.
 */

/** USDC has 6 decimals. */
const USDC_DECIMALS = 6;

/** Mainnet USDC. Override for devnet testing. */
const DEFAULT_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** A transaction older than this is not accepted as payment for a new pass. */
const MAX_PAYMENT_AGE_MS = 24 * 60 * 60 * 1000;

export class PaymentError extends Error {}

export interface PaymentConfig {
  treasury: PublicKey;
  usdcMint: PublicKey;
  rpcUrl: string;
}

/** Returns null when payments are not configured, so the app can still run. */
export function paymentConfig(): PaymentConfig | null {
  const treasury = process.env.TREASURY_WALLET?.trim();
  if (!treasury) return null;

  try {
    return {
      treasury: new PublicKey(treasury),
      usdcMint: new PublicKey(process.env.USDC_MINT?.trim() || DEFAULT_USDC_MINT),
      rpcUrl: process.env.SOLANA_RPC_URL?.trim() || "https://api.mainnet-beta.solana.com",
    };
  } catch {
    throw new PaymentError(
      "TREASURY_WALLET in .env is not a valid Solana address. Payments are disabled until it is fixed.",
    );
  }
}

function requireConfig(): PaymentConfig {
  const config = paymentConfig();
  if (!config) {
    throw new PaymentError(
      "Payments are not configured. Set TREASURY_WALLET in .env to the wallet that should receive USDC.",
    );
  }
  return config;
}

/**
 * Builds the unsigned USDC transfer for a plan. The client passes this to
 * Phantom, which shows the amount and recipient before the user approves.
 */
export async function buildPaymentTransaction(
  payerWallet: string,
  plan: PlanId,
): Promise<{ transactionBase64: string; amountUsd: number; treasury: string }> {
  const config = requireConfig();
  const definition = PLANS[plan];

  let payer: PublicKey;
  try {
    payer = new PublicKey(payerWallet);
  } catch {
    throw new PaymentError("Your wallet address is not valid.");
  }

  const fromAta = getAssociatedTokenAddressSync(config.usdcMint, payer);
  const toAta = getAssociatedTokenAddressSync(config.usdcMint, config.treasury);

  const connection = new Connection(config.rpcUrl, "confirmed");
  const { blockhash } = await connection.getLatestBlockhash("confirmed");

  const transaction = new Transaction();

  // Idempotent, so the very first payment works even if the treasury has never
  // held USDC. Costs the payer a small one-time rent deposit in that case only.
  transaction.add(
    createAssociatedTokenAccountIdempotentInstruction(
      payer,
      toAta,
      config.treasury,
      config.usdcMint,
    ),
  );

  transaction.add(
    createTransferCheckedInstruction(
      fromAta,
      config.usdcMint,
      toAta,
      payer,
      definition.amountBaseUnits,
      USDC_DECIMALS,
      [],
      TOKEN_PROGRAM_ID,
    ),
  );

  transaction.feePayer = payer;
  transaction.recentBlockhash = blockhash;

  return {
    transactionBase64: transaction
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64"),
    amountUsd: definition.priceUsd,
    treasury: config.treasury.toBase58(),
  };
}

interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}

/**
 * Confirms a transaction really paid for the plan, then grants the pass.
 *
 * Nothing here trusts the client beyond the signature string. The amount, the
 * recipient and the payer are all read back from the chain, and the signature
 * is the primary key of the payments table, so replaying one cannot buy a
 * second pass.
 */
export async function verifyAndGrant(input: {
  signature: string;
  userId: string;
  wallet: string;
  plan: PlanId;
}): Promise<{ expiresAt: string }> {
  const config = requireConfig();
  const definition = PLANS[input.plan];

  if (!/^[1-9A-HJ-NP-Za-km-z]{64,128}$/.test(input.signature)) {
    throw new PaymentError("That does not look like a Solana transaction signature.");
  }

  const alreadyClaimed = await one<{ user_id: string }>(
    "SELECT user_id FROM payments WHERE signature = ?",
    [input.signature],
  );

  if (alreadyClaimed) {
    throw new PaymentError("That payment has already been credited.");
  }

  const connection = new Connection(config.rpcUrl, "confirmed");
  const tx = await connection.getTransaction(input.signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });

  if (!tx) {
    throw new PaymentError(
      "That transaction has not confirmed yet. Wait a few seconds and try again.",
    );
  }
  if (tx.meta?.err) {
    throw new PaymentError("That transaction failed on chain, so nothing was paid.");
  }

  if (tx.blockTime && Date.now() - tx.blockTime * 1000 > MAX_PAYMENT_AGE_MS) {
    throw new PaymentError("That transaction is too old to redeem.");
  }

  // The payer must be the wallet that is signed in, otherwise anyone could
  // point at someone else's payment and claim it.
  const signerCount = tx.transaction.message.header.numRequiredSignatures;
  const signers = tx.transaction.message
    .getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses })
    .staticAccountKeys.slice(0, signerCount)
    .map((key) => key.toBase58());

  if (!signers.includes(input.wallet)) {
    throw new PaymentError("That payment was not sent from the wallet you signed in with.");
  }

  // Reading the treasury's balance delta rather than decoding instructions
  // keeps this correct regardless of how the transfer was composed.
  const mint = config.usdcMint.toBase58();
  const treasury = config.treasury.toBase58();

  const post = (tx.meta?.postTokenBalances ?? []) as TokenBalance[];
  const pre = (tx.meta?.preTokenBalances ?? []) as TokenBalance[];

  const received = post
    .filter((b) => b.mint === mint && b.owner === treasury)
    .reduce((total, after) => {
      const before = pre.find(
        (b) => b.accountIndex === after.accountIndex && b.mint === mint,
      );
      const delta =
        BigInt(after.uiTokenAmount.amount) - BigInt(before?.uiTokenAmount.amount ?? "0");
      return total + (delta > 0n ? delta : 0n);
    }, 0n);

  if (received < definition.amountBaseUnits) {
    const asUsd = (value: bigint) => (Number(value) / 10 ** USDC_DECIMALS).toFixed(2);
    throw new PaymentError(
      `That transaction paid $${asUsd(received)} USDC, but ${definition.label} costs $${asUsd(
        definition.amountBaseUnits,
      )}.`,
    );
  }

  // Record the payment first; its UNIQUE signature is what makes this safe to
  // call twice. If two requests race, the second insert throws and no second
  // pass is granted.
  try {
    await run(
      `INSERT INTO payments (signature, user_id, plan, amount_base_units, payer_wallet, verified_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        input.signature,
        input.userId,
        input.plan,
        Number(received),
        input.wallet,
        new Date().toISOString(),
      ],
    );
  } catch {
    throw new PaymentError("That payment has already been credited.");
  }

  const membership = await grantMembership(input.userId, input.plan, input.signature);
  return { expiresAt: membership.expiresAt };
}
