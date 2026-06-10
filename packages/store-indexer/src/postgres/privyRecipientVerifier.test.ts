import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { createPrivyRecipientVerifier } from "./privyRecipientVerifier";

const claimant = getAddress("0x0000000000000000000000000000000000000abc");
const recipient = getAddress("0x0000000000000000000000000000000000000def");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("privyRecipientVerifier", () => {
  it("accepts identical claimant and recipient wallets without a Privy call", async () => {
    const verifier = createPrivyRecipientVerifier({
      appId: "app",
      appSecret: "secret",
      fetchImpl: async () => {
        throw new Error("fetch should not run");
      },
    });

    await expect(verifier.verifyLinkedWallets(claimant, claimant)).resolves.toEqual({
      status: "ok",
      userId: "same-wallet",
    });
  });

  it("accepts different wallets linked to the same Privy user", async () => {
    const seenAddresses: string[] = [];
    const verifier = createPrivyRecipientVerifier({
      appId: "app",
      appSecret: "secret",
      fetchImpl: async (_url, init) => {
        seenAddresses.push(JSON.parse(String(init?.body)).address);
        return jsonResponse({ id: "did:privy:user" });
      },
    });

    await expect(verifier.verifyLinkedWallets(claimant, recipient)).resolves.toEqual({
      status: "ok",
      userId: "did:privy:user",
    });
    expect(seenAddresses).toEqual([claimant, recipient]);
  });

  it("rejects different wallets from different Privy users", async () => {
    const verifier = createPrivyRecipientVerifier({
      appId: "app",
      appSecret: "secret",
      fetchImpl: async (_url, init) => {
        const address = JSON.parse(String(init?.body)).address;
        return jsonResponse({ id: address.toLowerCase() === claimant.toLowerCase() ? "did:privy:a" : "did:privy:b" });
      },
    });

    await expect(verifier.verifyLinkedWallets(claimant, recipient)).resolves.toEqual({
      status: "not-linked",
      claimantUserId: "did:privy:a",
      recipientUserId: "did:privy:b",
    });
  });

  it("fails closed when Privy is unavailable", async () => {
    const verifier = createPrivyRecipientVerifier({
      appId: "app",
      appSecret: "secret",
      fetchImpl: async () => new Response("nope", { status: 503 }),
    });

    await expect(verifier.verifyLinkedWallets(claimant, recipient)).resolves.toEqual({
      status: "unavailable",
      error: "Privy lookup failed (503): nope",
    });
  });
});
