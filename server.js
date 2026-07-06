const express = require("express");
const crypto = require("crypto");
const cors = require("cors");

const app = express();

// ─── Config ────────────────────────────────────────────────────────────────
const SECRET_KEY = "ep_live_sk_1e637312cc767dace6ae1e7508978e2d";
const WEBHOOK_SECRET = "whsec_gur3sa5eh9gwmuqzu9te22ug8rcv42on";
const PUBLIC_KEY = "ep_live_pk_37e251461d03f27cd2d10b38589401f7";
const PORT = process.env.PORT || 3001;
const ELICATE_BASE = "https://elicatepay.online";

// ─── Middleware ─────────────────────────────────────────────────────────────
// Allow all frontends
app.use(cors({ origin: "*" }));

// Parse JSON for all routes except /webhook (needs raw body for HMAC)
app.use((req, res, next) => {
  if (req.path === "/webhook") return next();
  express.json()(req, res, next);
});

// ─── In-Memory Receipt Store ────────────────────────────────────────────────
// In production, replace this with a real database (Postgres, MongoDB, etc.)
const receipts = new Map();

function createReceipt({ transaction_id, reference, amount, fee, net_amount, currency, customer_name, customer_phone, network, status, created_at }) {
  const receipt = {
    receipt_number: `RCP-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    transaction_id,
    reference,
    amount,
    fee: fee ?? 0,
    net_amount: net_amount ?? amount,
    currency: currency || "ZMW",
    customer_name,
    customer_phone,
    network,
    status,
    issued_at: new Date().toISOString(),
    original_created_at: created_at ? new Date(created_at).toISOString() : new Date().toISOString(),
  };
  receipts.set(transaction_id, receipt);
  return receipt;
}

// ─── Routes ────────────────────────────────────────────────────────────────

/**
 * POST /charge
 * Accepts { name, phone, network, amount } from your frontend.
 * Sends an STK push via Elicate Pay and returns the transaction_id
 * plus a redirect_url if the network requires iframe/tab verification.
 */
app.post("/charge", async (req, res) => {
  const { name, phone, network, amount, reference } = req.body;

  // --- Validation ---
  const errors = [];
  if (!phone) errors.push("phone is required");
  if (!network) errors.push("network is required (MTN, AIRTEL, or ZAMTEL)");
  if (!amount || isNaN(amount) || Number(amount) <= 0) errors.push("amount must be a positive number");
  if (!["MTN", "AIRTEL", "ZAMTEL"].includes((network || "").toUpperCase())) errors.push("network must be MTN, AIRTEL, or ZAMTEL");

  if (errors.length) {
    return res.status(400).json({ success: false, error: "Validation failed", details: errors });
  }

  const chargeRef = reference || `ORDER-${Date.now()}`;

  let elicateRes, elicateData;
  try {
    elicateRes = await fetch(`${ELICATE_BASE}/api/v1/payments/charge`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: Number(amount),
        phone: String(phone).trim(),
        network: String(network).toUpperCase(),
        currency: "ZMW",
        customer_name: name || "Customer",
        reference: chargeRef,
      }),
    });

    elicateData = await elicateRes.json();
  } catch (networkErr) {
    console.error("[charge] Network error calling Elicate Pay:", networkErr.message);
    return res.status(502).json({
      success: false,
      error: "Could not reach Elicate Pay. Please try again.",
    });
  }

  // --- Handle Elicate Pay error responses ---
  if (!elicateRes.ok) {
    console.error("[charge] Elicate Pay error:", elicateRes.status, elicateData);

    const statusCode = elicateRes.status;
    let userMessage = "Payment initiation failed.";

    if (statusCode === 401) userMessage = "Invalid or expired API key.";
    else if (statusCode === 402) userMessage = "Insufficient merchant balance.";
    else if (statusCode === 422 || statusCode === 400) userMessage = elicateData?.error || elicateData?.message || "Invalid payment details.";
    else if (statusCode === 429) userMessage = "Too many requests. Please wait and try again.";
    else if (statusCode >= 500) userMessage = "Elicate Pay is experiencing issues. Please try again shortly.";

    return res.status(statusCode).json({
      success: false,
      error: userMessage,
      elicate_error: elicateData?.error || elicateData?.message || null,
    });
  }

  // --- Success: charge accepted ---
  // Normalise ID — Elicate may return it as transaction_id, id, or payment_id
  const transaction_id = elicateData.transaction_id || elicateData.id || elicateData.payment_id || elicateData.reference || null;
  const { status, reference: txRef, meta } = elicateData;
  const redirectUrl = meta?.authorization?.redirect_url || null;
  const authMode = meta?.authorization?.mode || null;

  console.log(`[charge] Initiated — transaction_id=${transaction_id} ref=${txRef} status=${status} mode=${authMode}`);

  return res.status(200).json({
    success: true,
    transaction_id,
    status,           // "pending"
    reference: txRef,
    message: meta?.message || "Check your phone to approve the payment.",
    // Redirect URL for Flutterwave iframe/tab verification (may be null for USSD-only flows)
    redirect_url: redirectUrl,
    auth_mode: authMode,
  });
});

/**
 * GET /status/:transaction_id
 * Poll this from your frontend every 3 seconds after charging.
 * Uses the secret-key endpoint for full details including fee and net_amount.
 * On first success, creates and stores a receipt.
 */
app.get("/status/:transaction_id", async (req, res) => {
  const { transaction_id } = req.params;

  if (!transaction_id) {
    return res.status(400).json({ success: false, error: "transaction_id is required" });
  }

  let elicateRes, elicateData;
  try {
    elicateRes = await fetch(`${ELICATE_BASE}/api/v1/payments/${transaction_id}`, {
      headers: { Authorization: `Bearer ${SECRET_KEY}` },
    });
    elicateData = await elicateRes.json();
  } catch (networkErr) {
    console.error("[status] Network error:", networkErr.message);
    return res.status(502).json({ success: false, error: "Could not reach Elicate Pay." });
  }

  if (!elicateRes.ok) {
    const statusCode = elicateRes.status;
    let userMessage = "Could not fetch transaction status.";
    if (statusCode === 401) userMessage = "Unauthorized. Check server API key.";
    else if (statusCode === 403) userMessage = "This transaction does not belong to your merchant account.";
    else if (statusCode === 404) userMessage = "Transaction not found.";
    else if (statusCode === 429) userMessage = "Too many requests. Slow down polling.";
    else if (statusCode >= 500) userMessage = "Elicate Pay is experiencing issues. Try again shortly.";
    console.error(`[status] Elicate Pay error: ${statusCode}`, elicateData);
    return res.status(statusCode).json({
      success: false,
      error: userMessage,
      elicate_error: elicateData?.error || elicateData?.message || null,
    });
  }

  const { transaction_id: txId, status, amount, fee, net_amount, currency, reference, customer_name, customer_phone, network, created_at, updated_at } = elicateData;

  // Auto-create receipt on success if not already created
  let receipt = null;
  if (status === "success") {
    if (!receipts.has(txId)) {
      receipt = createReceipt({ transaction_id: txId, reference, amount, fee, net_amount, currency, customer_name, customer_phone, network, status, created_at });
      console.log(`[status] Receipt created — receipt_number=${receipt.receipt_number} transaction_id=${txId}`);
    } else {
      receipt = receipts.get(txId);
    }
  }

  console.log(`[status] transaction_id=${txId} status=${status}`);

  return res.status(200).json({
    success: true,
    transaction_id: txId,
    status,           // "pending" | "success" | "failed"
    amount,
    fee: fee ?? 0,
    net_amount: net_amount ?? amount,
    currency: currency || "ZMW",
    reference,
    customer_name,
    customer_phone,
    network,
    created_at,
    updated_at,
    receipt: receipt || null,
  });
});

/**
 * GET /receipt/:transaction_id
 * Retrieve a stored receipt by transaction ID.
 */
app.get("/receipt/:transaction_id", (req, res) => {
  const { transaction_id } = req.params;
  const receipt = receipts.get(transaction_id);

  if (!receipt) {
    return res.status(404).json({
      success: false,
      error: "Receipt not found. Payment may not have succeeded yet.",
    });
  }

  return res.status(200).json({ success: true, receipt });
});

/**
 * POST /webhook
 * Receives Elicate Pay payment & payout event notifications.
 * Verifies the HMAC-SHA256 signature before processing.
 * Your frontend should NOT call this — Elicate Pay calls it automatically.
 */
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const signature = req.headers["x-elicatepay-signature"];
    const rawBody = req.body.toString("utf-8");

    // --- Signature verification (fail-closed) ---
    if (!WEBHOOK_SECRET) {
      // Refuse all webhook calls if the secret is not configured — safer than accepting unverified events.
      console.error("[webhook] ELICATE_WEBHOOK_SECRET is not set. Rejecting request. Set this env var before going live.");
      return res.status(500).json({ error: "Webhook secret not configured on server." });
    }

    if (!signature) {
      console.warn("[webhook] Missing X-ElicatePay-Signature header — rejected.");
      return res.status(401).json({ error: "Missing signature" });
    }

    const expected = crypto
      .createHmac("sha256", WEBHOOK_SECRET)
      .update(rawBody)
      .digest("hex");

    let signaturesMatch;
    try {
      signaturesMatch = crypto.timingSafeEqual(
        Buffer.from(signature, "hex"),
        Buffer.from(expected, "hex")
      );
    } catch {
      signaturesMatch = false;
    }

    if (!signaturesMatch) {
      console.warn("[webhook] Invalid signature — rejected.");
      return res.status(401).json({ error: "Invalid signature" });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return res.status(400).json({ error: "Invalid JSON payload" });
    }

    const { event, data } = payload;
    console.log(`[webhook] Event received: ${event}`);

    switch (event) {
      case "payment.success": {
        const { transaction_id, reference, amount, fee, net_amount, currency, customer_name, customer_phone, network } = data;
        console.log(`[webhook] payment.success — transaction_id=${transaction_id} ref=${reference} net=${net_amount} ${currency}`);

        // Create receipt if not already created by polling
        if (!receipts.has(transaction_id)) {
          const receipt = createReceipt({ transaction_id, reference, amount, fee, net_amount, currency, customer_name, customer_phone, network, status: "success" });
          console.log(`[webhook] Receipt created — receipt_number=${receipt.receipt_number}`);
        }

        // TODO: Mark your order as paid in your database using transaction_id / reference
        break;
      }

      case "payment.failed": {
        const { transaction_id, reference } = data;
        console.log(`[webhook] payment.failed — transaction_id=${transaction_id} ref=${reference}`);
        // TODO: Mark your order as failed in your database
        break;
      }

      case "payout.success": {
        console.log(`[webhook] payout.success — payout_id=${data.payout_id} ref=${data.reference}`);
        // TODO: Update payout record in your database
        break;
      }

      case "payout.failed": {
        console.log(`[webhook] payout.failed — payout_id=${data.payout_id} ref=${data.reference}`);
        // TODO: Update payout record in your database
        break;
      }

      case "payment.test": {
        console.log("[webhook] Test webhook received — OK.");
        break;
      }

      default:
        console.log(`[webhook] Unhandled event type: ${event}`);
    }

    // Always return 200 quickly so Elicate Pay doesn't retry
    return res.status(200).json({ received: true });
  }
);

// ─── Health check ───────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ─── 404 fallback ───────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// ─── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Elicate Pay STK server running on port ${PORT}`);
  console.log(`  POST /charge           — initiate STK push`);
  console.log(`  GET  /status/:id       — poll transaction status`);
  console.log(`  GET  /receipt/:id      — fetch receipt`);
  console.log(`  POST /webhook          — receive Elicate Pay events`);
});
