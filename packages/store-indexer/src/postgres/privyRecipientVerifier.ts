import type { Address } from "viem";

export type RecipientVerificationResult =
  | { status: "ok"; userId: string }
  | { status: "not-linked"; claimantUserId?: string; recipientUserId?: string }
  | { status: "unavailable"; error: string };

export type RecipientVerifier = {
  verifyLinkedWallets(claimant: Address, recipient: Address): Promise<RecipientVerificationResult>;
};

type FetchLike = typeof fetch;

type PrivyUserResponse = {
  id?: unknown;
};

export function createPrivyRecipientVerifier(args: {
  appId: string;
  appSecret: string;
  fetchImpl?: FetchLike;
}): RecipientVerifier {
  const fetchImpl = args.fetchImpl ?? fetch;
  const auth = Buffer.from(`${args.appId}:${args.appSecret}`).toString("base64");

  async function lookupUserId(
    address: Address,
  ): Promise<{ status: "ok"; userId: string } | { status: "not-found" } | { status: "error"; error: string }> {
    let response: Response;
    try {
      response = await fetchImpl("https://api.privy.io/v1/users/wallet/address", {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
          "privy-app-id": args.appId,
        },
        body: JSON.stringify({ address }),
      });
    } catch (e) {
      return { status: "error", error: e instanceof Error ? e.message : String(e) };
    }

    if (response.status === 404) return { status: "not-found" };
    if (!response.ok) {
      const body = await safeText(response);
      return { status: "error", error: `Privy lookup failed (${response.status})${body ? `: ${body}` : ""}` };
    }

    let json: PrivyUserResponse;
    try {
      json = (await response.json()) as PrivyUserResponse;
    } catch (e) {
      return {
        status: "error",
        error: `Privy lookup returned invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    if (typeof json.id !== "string" || json.id.length === 0) {
      return { status: "error", error: "Privy lookup response missing user id" };
    }
    return { status: "ok", userId: json.id };
  }

  return {
    async verifyLinkedWallets(claimant, recipient): Promise<RecipientVerificationResult> {
      if (claimant.toLowerCase() === recipient.toLowerCase()) {
        return { status: "ok", userId: "same-wallet" };
      }

      const [claimantLookup, recipientLookup] = await Promise.all([lookupUserId(claimant), lookupUserId(recipient)]);
      if (claimantLookup.status === "error") return { status: "unavailable", error: claimantLookup.error };
      if (recipientLookup.status === "error") return { status: "unavailable", error: recipientLookup.error };
      if (claimantLookup.status === "not-found" || recipientLookup.status === "not-found") {
        return {
          status: "not-linked",
          claimantUserId: claimantLookup.status === "ok" ? claimantLookup.userId : undefined,
          recipientUserId: recipientLookup.status === "ok" ? recipientLookup.userId : undefined,
        };
      }
      if (claimantLookup.userId !== recipientLookup.userId) {
        return {
          status: "not-linked",
          claimantUserId: claimantLookup.userId,
          recipientUserId: recipientLookup.userId,
        };
      }
      return { status: "ok", userId: claimantLookup.userId };
    },
  };
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return "";
  }
}
