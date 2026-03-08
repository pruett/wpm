import { Hono } from "hono";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { sendError } from "../errors";
import {
  findUserByEmail,
  findUserById,
  findActiveInviteCode,
  insertChallenge,
  findChallenge,
  deleteChallenge,
  insertUser,
  insertCredential,
  incrementInviteCodeUse,
  findCredentialById,
  updateCredentialCounter,
} from "../db/queries";
import { generateWalletKeyPair, encryptPrivateKey } from "../crypto/wallet";
import {
  signJwt,
  signRefreshToken,
  verifyRefreshToken,
  setRefreshCookie,
  getRefreshCookie,
} from "../middleware/auth";
import { createNodeClient } from "../node-client";

const RP_ID = process.env.WEBAUTHN_RP_ID ?? "localhost";
const RP_NAME = process.env.WEBAUTHN_RP_NAME ?? "WPM";
const ORIGIN = process.env.WEBAUTHN_ORIGIN ?? `https://${RP_ID}`;
const NODE_URL = process.env.NODE_URL ?? "http://localhost:3001";

const CHALLENGE_TTL_MS = 60_000;

const auth = new Hono();

// --- POST /auth/register/begin ---

auth.post("/auth/register/begin", async (c) => {
  let body: { inviteCode?: unknown; name?: unknown; email?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: "INVALID_INVITE_CODE", message: "Invalid request body" } }, 400);
  }

  const { inviteCode, name, email } = body;

  // Validate invite code
  if (typeof inviteCode !== "string" || !inviteCode) {
    return sendError(c, "INVALID_INVITE_CODE");
  }

  const code = findActiveInviteCode(inviteCode);
  if (!code) {
    return sendError(c, "INVALID_INVITE_CODE");
  }

  // Validate name: 1-50 characters
  if (typeof name !== "string" || name.length < 1 || name.length > 50) {
    return c.json(
      { error: { code: "VALIDATION_ERROR", message: "Name must be 1-50 characters" } },
      400,
    );
  }

  // Validate email format
  if (typeof email !== "string" || !isValidEmail(email)) {
    return c.json({ error: { code: "VALIDATION_ERROR", message: "Invalid email format" } }, 400);
  }

  // Check duplicate email (case-insensitive via COLLATE NOCASE in DB)
  const existing = findUserByEmail(email);
  if (existing) {
    return sendError(c, "DUPLICATE_REGISTRATION");
  }

  // Generate WebAuthn registration options
  const userId = crypto.randomUUID();

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: email,
    userDisplayName: name,
    userID: new TextEncoder().encode(userId),
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
    timeout: 60000,
    supportedAlgorithmIDs: [-7, -257],
  });

  // Store challenge in auth_challenges with 60s TTL
  const challengeId = crypto.randomUUID();
  const now = Date.now();

  insertChallenge({
    id: challengeId,
    challenge: options.challenge,
    type: "webauthn_register",
    userData: JSON.stringify({ userId, name, email, inviteCode }),
    expiresAt: now + CHALLENGE_TTL_MS,
  });

  return c.json({
    challengeId,
    publicKey: options,
  });
});

// --- POST /auth/register/complete ---

auth.post("/auth/register/complete", async (c) => {
  let body: { challengeId?: unknown; credential?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return sendError(c, "CHALLENGE_EXPIRED", "Invalid request body");
  }

  const { challengeId, credential } = body;

  if (typeof challengeId !== "string") {
    return sendError(c, "CHALLENGE_EXPIRED");
  }

  // Retrieve and validate challenge
  const challenge = findChallenge(challengeId);
  if (!challenge) {
    return sendError(c, "CHALLENGE_EXPIRED");
  }

  if (challenge.type !== "webauthn_register") {
    return sendError(c, "CHALLENGE_EXPIRED");
  }

  if (Date.now() > challenge.expires_at) {
    deleteChallenge(challengeId);
    return sendError(c, "CHALLENGE_EXPIRED");
  }

  // Parse stored user data
  const userData = JSON.parse(challenge.user_data!) as {
    userId: string;
    name: string;
    email: string;
    inviteCode: string;
  };

  // Verify WebAuthn attestation
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: credential as Parameters<typeof verifyRegistrationResponse>[0]["response"],
      expectedChallenge: challenge.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: true,
    });
  } catch {
    deleteChallenge(challengeId);
    return sendError(c, "WEBAUTHN_VERIFICATION_FAILED");
  }

  if (!verification.verified || !verification.registrationInfo) {
    deleteChallenge(challengeId);
    return sendError(c, "WEBAUTHN_VERIFICATION_FAILED");
  }

  const { credential: regCredential } = verification.registrationInfo;

  // Generate custodial wallet keypair
  const { publicKey: walletPublicKey, privateKey: walletPrivateKey } = generateWalletKeyPair();

  // Encrypt private key
  const encryptionKey = process.env.WALLET_ENCRYPTION_KEY;
  if (!encryptionKey) {
    deleteChallenge(challengeId);
    return sendError(c, "INTERNAL_ERROR", "Wallet encryption key not configured");
  }

  const encryptedPrivateKey = await encryptPrivateKey(walletPrivateKey, encryptionKey);

  // Re-validate invite code (may have been used between begin and complete)
  const inviteCode = findActiveInviteCode(userData.inviteCode);
  if (!inviteCode) {
    deleteChallenge(challengeId);
    return sendError(c, "INVALID_INVITE_CODE");
  }

  // Re-check email uniqueness
  const existingUser = findUserByEmail(userData.email);
  if (existingUser) {
    deleteChallenge(challengeId);
    return sendError(c, "DUPLICATE_REGISTRATION");
  }

  // Insert user + credential (SQLite is synchronous so both execute atomically within the same tick)
  insertUser({
    id: userData.userId,
    name: userData.name,
    email: userData.email,
    walletAddress: walletPublicKey,
    walletPrivateKeyEnc: encryptedPrivateKey,
  });

  insertCredential({
    credentialId: regCredential.id,
    userId: userData.userId,
    publicKey: Buffer.from(regCredential.publicKey),
    counter: regCredential.counter,
  });

  // Increment invite code usage
  incrementInviteCodeUse(userData.inviteCode);

  // Delete consumed challenge
  deleteChallenge(challengeId);

  // Airdrop 100,000 WPM to new wallet
  const node = createNodeClient(NODE_URL);
  await node.distribute(walletPublicKey, 100_000, "signup_airdrop");

  // Referral reward if invite code has a referrer
  if (inviteCode.referrer) {
    await node.referralReward(inviteCode.referrer, userData.userId);
  }

  // Issue JWT + refresh token
  const token = await signJwt({
    sub: userData.userId,
    role: "user" as const,
    walletAddress: walletPublicKey,
    email: userData.email,
  });

  const refreshToken = await signRefreshToken(userData.userId);
  setRefreshCookie(c, refreshToken);

  return c.json(
    {
      userId: userData.userId,
      walletAddress: walletPublicKey,
      token,
    },
    201,
  );
});

// --- POST /auth/login/begin ---

auth.post("/auth/login/begin", async (c) => {
  // Discoverable credentials (passkeys) — no allowCredentials needed
  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: "required",
    timeout: 60000,
  });

  const challengeId = crypto.randomUUID();
  const now = Date.now();

  insertChallenge({
    id: challengeId,
    challenge: options.challenge,
    type: "webauthn_login",
    expiresAt: now + CHALLENGE_TTL_MS,
  });

  return c.json({
    challengeId,
    publicKey: options,
  });
});

// --- POST /auth/login/complete ---

auth.post("/auth/login/complete", async (c) => {
  let body: { challengeId?: unknown; credential?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return sendError(c, "UNAUTHORIZED", "Invalid request body");
  }

  const { challengeId, credential } = body;

  if (typeof challengeId !== "string") {
    return sendError(c, "UNAUTHORIZED", "Missing challenge ID");
  }

  // Retrieve and validate challenge
  const challenge = findChallenge(challengeId);
  if (!challenge) {
    return sendError(c, "UNAUTHORIZED", "Invalid or expired challenge");
  }

  if (challenge.type !== "webauthn_login") {
    deleteChallenge(challengeId);
    return sendError(c, "UNAUTHORIZED", "Invalid challenge type");
  }

  if (Date.now() > challenge.expires_at) {
    deleteChallenge(challengeId);
    return sendError(c, "CHALLENGE_EXPIRED");
  }

  // Extract credential ID from the response
  const cred = credential as { id?: string; rawId?: string; type?: string; response?: unknown };
  if (!cred || typeof cred.id !== "string") {
    deleteChallenge(challengeId);
    return sendError(c, "UNAUTHORIZED", "Missing credential ID");
  }

  // Look up stored credential
  const storedCredential = findCredentialById(cred.id);
  if (!storedCredential) {
    deleteChallenge(challengeId);
    return sendError(c, "UNAUTHORIZED", "Unknown credential");
  }

  // Verify authentication assertion
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: credential as Parameters<typeof verifyAuthenticationResponse>[0]["response"],
      expectedChallenge: challenge.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: true,
      credential: {
        id: storedCredential.credential_id,
        publicKey: new Uint8Array(storedCredential.public_key),
        counter: storedCredential.counter,
      },
    });
  } catch {
    deleteChallenge(challengeId);
    return sendError(c, "UNAUTHORIZED", "Authentication verification failed");
  }

  if (!verification.verified) {
    deleteChallenge(challengeId);
    return sendError(c, "UNAUTHORIZED", "Authentication verification failed");
  }

  // Update credential counter
  updateCredentialCounter(
    storedCredential.credential_id,
    verification.authenticationInfo.newCounter,
  );

  // Delete consumed challenge
  deleteChallenge(challengeId);

  // Look up user
  const user = findUserById(storedCredential.user_id);
  if (!user) {
    return sendError(c, "UNAUTHORIZED", "User not found");
  }

  // Issue JWT + refresh token
  const token = await signJwt({
    sub: user.id,
    role: user.role as "user" | "admin",
    walletAddress: user.wallet_address,
    email: user.email,
  });

  const refreshToken = await signRefreshToken(user.id);
  setRefreshCookie(c, refreshToken);

  return c.json({
    userId: user.id,
    walletAddress: user.wallet_address,
    token,
  });
});

// --- POST /auth/refresh ---

auth.post("/auth/refresh", async (c) => {
  const refreshToken = getRefreshCookie(c);
  if (!refreshToken) {
    return sendError(
      c,
      "UNAUTHORIZED",
      "Refresh token expired or missing. Please re-authenticate.",
    );
  }

  let payload;
  try {
    payload = await verifyRefreshToken(refreshToken);
  } catch {
    return sendError(
      c,
      "UNAUTHORIZED",
      "Refresh token expired or missing. Please re-authenticate.",
    );
  }

  // Validate user still exists
  const user = findUserById(payload.sub);
  if (!user) {
    return sendError(
      c,
      "UNAUTHORIZED",
      "Refresh token expired or missing. Please re-authenticate.",
    );
  }

  // Issue fresh access JWT
  const token = await signJwt({
    sub: user.id,
    role: user.role as "user" | "admin",
    walletAddress: user.wallet_address,
    email: user.email,
  });

  // Rotate refresh cookie
  const newRefreshToken = await signRefreshToken(user.id);
  setRefreshCookie(c, newRefreshToken);

  return c.json({ token });
});

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export { auth };
