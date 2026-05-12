/**
 * Computeback MCP server — core (transport-agnostic) factory.
 *
 * Builds an `McpServer` instance and registers all 28 tools. The same
 * factory is used by both the stdio entry-point (`server-stdio.ts`)
 * and the streamable-http entry-point (`server-http.ts`).
 *
 * Auth model
 * ----------
 * The CB Hire family of tools requires per-request HMAC auth — the
 * stdio version reads `AGENT_DID` + `AGENT_HMAC_SECRET` from env (set
 * once per client by their MCP config). The HTTP version is shared
 * across clients and instead captures `x-agent-did` + `x-agent-signature`
 * headers off each incoming HTTP request.
 *
 * To keep the tool implementations transport-agnostic we accept an
 * `AuthContext` from the caller. `getAuthHeaders(path)` is called by the
 * `agentFetch` helper to produce the outbound auth headers (signing or
 * forwarding). `requireAuth()` is called by CB Hire tools to assert auth
 * is available before doing any work — missing auth surfaces as an MCP
 * error (`-32603`) rather than a noisy backend 401.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ethers } from "ethers";
import { createHmac } from "node:crypto";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BACKEND_URL =
  process.env.COMPUTEBACK_API_URL || "https://www.computeback.com/api";
const BASE_RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const NOMD_TOKEN = "0x667b3de5b479ff61d5e5ad7ec2e97345298b125c";
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

// ---------------------------------------------------------------------------
// Auth context — transport-supplied
// ---------------------------------------------------------------------------

export interface AgentAuthHeaders {
  /** Raw value for the `X-Agent-Did` header. */
  did: string;
  /** Raw value for the `X-Agent-Signature` header. */
  signature: string;
  /**
   * Raw value for the `X-Agent-Timestamp` header — unix-millis as a
   * decimal string. The backend enforces ±5 min freshness against
   * `Date.now()` to bound replay attacks.
   */
  timestamp?: string;
}

export interface AuthContext {
  /**
   * Return outbound auth headers for a backend `agentFetch` call against
   * `path`. Return null if no auth is available — CB Hire tools will then
   * reject the call before it leaves the MCP process.
   *
   * Stdio: signs `did + ":" + ts + ":" + path` with the local HMAC secret
   *        and a fresh `Date.now()` timestamp on every call.
   * Http : returns the headers captured off the incoming HTTP request
   *        (the backend re-verifies the signature on every call).
   */
  getAuthHeaders(path: string): AgentAuthHeaders | null;
  /**
   * Surface a clear error when a CB Hire tool is invoked without
   * any auth on the wire. Throws an Error which the McpServer
   * surfaces back to the client as JSON-RPC -32603.
   */
  requireAuth(toolName: string): void;
}

/**
 * Stdio auth: pulls `AGENT_DID` + `AGENT_HMAC_SECRET` from env at module
 * load and signs each request locally.
 */
export function makeStdioAuthContext(): AuthContext {
  const agentDid = process.env.COMPUTEBACK_AGENT_DID || process.env.AGENT_DID || "";
  const hmacSecret = process.env.AGENT_HMAC_SECRET || "";
  return {
    getAuthHeaders(path: string): AgentAuthHeaders | null {
      if (!agentDid) return null;
      // Mint a fresh timestamp per request — the backend enforces ±5 min
      // freshness on `X-Agent-Timestamp` to bound replay attacks. The
      // signed value is `did + ":" + ts + ":" + path`.
      const timestamp = Date.now().toString();
      // If we have a DID but no secret, send the DID alone — useful for
      // the AGENT_AUDIENCE_DEV_OPEN=1 dev mode the backend supports.
      const signature = hmacSecret
        ? createHmac("sha256", hmacSecret)
            .update(`${agentDid}:${timestamp}:${path}`)
            .digest("hex")
        : "";
      return { did: agentDid, signature, timestamp };
    },
    requireAuth(toolName: string): void {
      if (!agentDid) {
        throw new Error(
          `Tool "${toolName}" requires agent auth. Set AGENT_DID + AGENT_HMAC_SECRET in your MCP client config; register a DID at https://computeback.com/hire.`,
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function apiFetch(path: string, options?: RequestInit): Promise<unknown> {
  const url = `${BACKEND_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${body || res.statusText}`);
  }
  return res.json();
}

function formatResponse(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function makeAgentFetch(authCtx: AuthContext) {
  return async function agentFetch(
    path: string,
    options: RequestInit = {},
  ): Promise<unknown> {
    const url = `${BACKEND_URL}${path}`;
    const auth = authCtx.getAuthHeaders(path);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...((options.headers as Record<string, string>) ?? {}),
    };
    if (auth) {
      headers["X-Agent-Did"] = auth.did;
      if (auth.signature) headers["X-Agent-Signature"] = auth.signature;
      if (auth.timestamp) headers["X-Agent-Timestamp"] = auth.timestamp;
    }
    const res = await fetch(url, { ...options, headers });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Agent API ${res.status}: ${text || res.statusText}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  };
}

// ---------------------------------------------------------------------------
// Tool list — what requires auth (used by the http transport docs + here
// in `requireAuth` calls below). Update both if you add new tools.
// ---------------------------------------------------------------------------

export const STOREFRONT_TOOL_NAMES = [
  "search_products",
  "get_product",
  "get_categories",
  "check_balance",
  "create_order",
  "get_orders",
  "get_recommendations",
  "buy_nomd",
] as const;

export const CB_HIRE_TOOL_NAMES = [
  "get_audience_data",
  "list_audiences",
  "get_business_profile",
  "get_product_info",
  "fetch_url",
  "dispatch_email_campaign",
  "dispatch_voice_campaign",
  "dispatch_sms_campaign",
  "configure_landing_page",
  "dispatch_landing_pages",
  "send_landing_chat",
  "list_workflow_templates",
  "start_workflow",
  "place_bid",
  "withdraw_bid",
  "list_my_inbox",
  "get_agent_profile",
  "edit_agent_profile",
  "get_settlement_status",
  "list_my_settlements",
] as const;

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function buildServer(authCtx: AuthContext): McpServer {
  const server = new McpServer({
    name: "computeback",
    version: "1.1.3",
  });

  const agentFetch = makeAgentFetch(authCtx);

  // ===========================================================================
  // STOREFRONT TOOLS (no auth required)
  // ===========================================================================

  // ---- search_products ----------------------------------------------------

  server.tool(
    "search_products",
    "Search the Computeback rewards marketplace for products purchasable with $NOMD tokens. Filter by category, keyword, or sort order.",
    {
      category: z.string().optional().describe("Filter by category slug"),
      query: z.string().optional().describe("Free-text search query"),
      sort: z
        .enum(["price_asc", "price_desc", "best_value", "newest"])
        .optional()
        .describe("Sort order for results"),
    },
    async ({ category, query, sort }) => {
      const params = new URLSearchParams();
      if (category) params.set("category", category);
      if (query) params.set("q", query);
      if (sort) params.set("sort", sort);
      const qs = params.toString();
      const data = await apiFetch(`/v1/products${qs ? `?${qs}` : ""}`);
      return formatResponse(data);
    },
  );

  // ---- get_product --------------------------------------------------------

  server.tool(
    "get_product",
    "Get full details for a specific product in the Computeback marketplace, including $NOMD price, USD value, vendor, and description.",
    {
      product_id: z.string().describe("The product ID to look up"),
    },
    async ({ product_id }) => {
      const data = await apiFetch(`/v1/products/${product_id}`);
      return formatResponse(data);
    },
  );

  // ---- get_categories -----------------------------------------------------

  server.tool(
    "get_categories",
    "List all product categories available in the Computeback marketplace with product counts.",
    {},
    async () => {
      const data = await apiFetch("/v1/categories");
      return formatResponse(data);
    },
  );

  // ---- check_balance ------------------------------------------------------

  server.tool(
    "check_balance",
    "Check the $NOMD token balance for a wallet address. Reads directly from the Base L2 blockchain and includes the current USD value.",
    {
      wallet_address: z
        .string()
        .describe("Ethereum wallet address (0x...) to check"),
    },
    async ({ wallet_address }) => {
      // On-chain balance read
      const provider = new ethers.JsonRpcProvider(BASE_RPC);
      const token = new ethers.Contract(NOMD_TOKEN, ERC20_ABI, provider);

      const [rawBalance, decimals] = await Promise.all([
        token.balanceOf(wallet_address) as Promise<bigint>,
        token.decimals() as Promise<bigint>,
      ]);

      const balanceNomd = Number(ethers.formatUnits(rawBalance, decimals));

      // USD price from backend
      let rate = 0;
      let balanceUsd = 0;
      try {
        const priceData = (await apiFetch("/v1/price")) as {
          rate?: number;
          price?: number;
        };
        rate = priceData.rate ?? priceData.price ?? 0;
        balanceUsd = balanceNomd * rate;
      } catch {
        // price endpoint may not be available — return balance without USD
      }

      return formatResponse({
        wallet_address,
        balance_nomd: balanceNomd,
        balance_usd: balanceUsd,
        rate,
        token: NOMD_TOKEN,
        network: "Base L2",
      });
    },
  );

  // ---- create_order -------------------------------------------------------

  server.tool(
    "create_order",
    "Purchase a product from the Computeback marketplace using $NOMD tokens. Creates an order for the given product and buyer wallet.",
    {
      product_id: z.string().describe("The product ID to purchase"),
      wallet_address: z
        .string()
        .describe("Buyer wallet address that holds $NOMD"),
    },
    async ({ product_id, wallet_address }) => {
      const data = await apiFetch("/v1/orders", {
        method: "POST",
        body: JSON.stringify({ productId: product_id, buyerWallet: wallet_address }),
      });
      return formatResponse(data);
    },
  );

  // ---- get_orders ---------------------------------------------------------

  server.tool(
    "get_orders",
    "Retrieve order history for a wallet address from the Computeback marketplace.",
    {
      wallet_address: z
        .string()
        .describe("Wallet address to look up orders for"),
    },
    async ({ wallet_address }) => {
      const data = await apiFetch(
        `/v1/orders?buyerWallet=${encodeURIComponent(wallet_address)}`,
      );
      return formatResponse(data);
    },
  );

  // ---- get_recommendations ------------------------------------------------

  server.tool(
    "get_recommendations",
    "Get recommended products from the Computeback marketplace. Optionally personalized by wallet or agent type.",
    {
      wallet_address: z
        .string()
        .optional()
        .describe("Wallet address for personalized recommendations"),
      agent_type: z
        .string()
        .optional()
        .describe(
          "Type of AI agent (e.g. 'travel', 'shopping', 'general') for tailored suggestions",
        ),
    },
    async ({ wallet_address, agent_type }) => {
      const params = new URLSearchParams();
      if (wallet_address) params.set("wallet", wallet_address);
      if (agent_type) params.set("agent_type", agent_type);
      const qs = params.toString();
      const data = await apiFetch(
        `/v1/products/featured${qs ? `?${qs}` : ""}`,
      );
      return formatResponse(data);
    },
  );

  // ---- buy_nomd -----------------------------------------------------------

  server.tool(
    "buy_nomd",
    "Get the link to purchase $NOMD tokens from the Autonomad treasury (paid in USDC on Base L2). Use this when the agent or user needs more tokens to make a purchase on Computeback.",
    {},
    async () => {
      const link = "https://computeback.com/buy-nomd";
      return formatResponse({
        message:
          "Purchase $NOMD directly from the Autonomad treasury using USDC on Base L2. Rate is set by Autonomad and updates based on market signals — check the live rate at the link before buying.",
        url: link,
        token: NOMD_TOKEN,
        network: "Base L2",
        acquisitionMethod: "treasury_sale",
        paymentCurrency: "USDC",
        alternateEarnPath: "Earn $NOMD by completing travel bookings on https://autonomad.ai",
      });
    },
  );

  // ===========================================================================
  // CB HIRE TOOLS (HMAC auth required)
  // ===========================================================================

  // ---- get_audience_data --------------------------------------------------

  server.tool(
    "get_audience_data",
    "Read a paginated slice of an audience upload (e.g. an email list a business uploaded). Each access is audit-logged. Returns rows keyed by the schema columns.",
    {
      business_id: z.string().describe("The Computeback business id whose audience you're reading"),
      audience_id: z.string().describe("The audience upload id"),
      page: z.number().int().min(1).default(1).describe("1-indexed page number"),
      page_size: z.number().int().min(1).max(500).default(50).describe("Rows per page (max 500)"),
      task_id: z.string().optional().describe("Optional offer/task id for audit-trail correlation"),
    },
    async ({ business_id, audience_id, page, page_size, task_id }) => {
      authCtx.requireAuth("get_audience_data");
      const qs = new URLSearchParams({
        page: String(page),
        page_size: String(page_size),
      });
      if (task_id) qs.set("task_id", task_id);
      const data = await agentFetch(`/v1/agent/audience/${audience_id}?${qs.toString()}`);
      void business_id; // The audience-id is globally unique; business_id is recorded for the audit log future-tightening
      return formatResponse(data);
    },
  );

  // ---- list_audiences -----------------------------------------------------

  server.tool(
    "list_audiences",
    "List the audience uploads (lead lists, brand assets, product docs) a business has provided for the current task. Returns metadata only — no row contents.",
    {
      business_id: z.string().describe("The Computeback business id"),
      kind: z
        .enum(["email_list", "contact_list", "brand_asset", "product_doc"])
        .optional()
        .describe("Filter by upload kind"),
    },
    async ({ business_id, kind }) => {
      authCtx.requireAuth("list_audiences");
      const qs = new URLSearchParams({ business_id });
      if (kind) qs.set("kind", kind);
      const data = await agentFetch(`/v1/agent/audience?${qs.toString()}`);
      return formatResponse(data);
    },
  );

  // ---- get_business_profile -----------------------------------------------

  server.tool(
    "get_business_profile",
    "Get the business's public profile fields (legal name, website, phone, location). Use this when drafting outreach copy or replies that need to introduce the business.",
    {
      business_id: z.string().describe("The Computeback business id"),
    },
    async ({ business_id }) => {
      authCtx.requireAuth("get_business_profile");
      const data = await agentFetch(
        `/v1/agent/business-profile?business_id=${encodeURIComponent(business_id)}`,
      );
      return formatResponse(data);
    },
  );

  // ---- get_product_info (stub) --------------------------------------------

  server.tool(
    "get_product_info",
    "Look up product knowledge for a business. Currently returns a deferred-feature notice — pass product context via the offer description until the RAG integration ships.",
    {
      business_id: z.string().describe("The Computeback business id"),
      query: z.string().describe("The question or topic to look up"),
      top_k: z.number().int().min(1).max(20).default(5).describe("Max chunks to return (when implemented)"),
    },
    async ({ business_id, query, top_k }) => {
      authCtx.requireAuth("get_product_info");
      const qs = new URLSearchParams({
        business_id,
        query,
        top_k: String(top_k),
      });
      try {
        const data = await agentFetch(`/v1/agent/product-info?${qs.toString()}`);
        return formatResponse(data);
      } catch (err: any) {
        return formatResponse({
          deferred: true,
          message: err?.message ?? "product RAG not yet available",
        });
      }
    },
  );

  // ---- fetch_url ----------------------------------------------------------

  server.tool(
    "fetch_url",
    "Scoped scraper for prospect research. Pass a public URL (e.g. a prospect's company homepage) and get the text contents back. Rate-limited to 30 calls/min per agent. Respects the 256KB cap.",
    {
      url: z.string().describe("Absolute http(s) URL to fetch"),
    },
    async ({ url }) => {
      authCtx.requireAuth("fetch_url");
      const data = await agentFetch("/v1/agent/fetch-url", {
        method: "POST",
        body: JSON.stringify({ url }),
      });
      return formatResponse(data);
    },
  );

  // ---- dispatch_email_campaign (sub-plan #4) -------------------------------

  server.tool(
    "dispatch_email_campaign",
    "Send a personalized cold-outreach email campaign for an offer the agent has accepted. Each recipient gets a Claude-drafted email; A/B variants are randomly assigned. CAN-SPAM unsubscribe link is auto-injected; previously-opted-out recipients are skipped. Outcome events stream back via the offer's webhook configuration.",
    {
      offer_id: z.string().describe("The offer id the agent is currently assigned to."),
      audience_upload_id: z.string().describe("Audience id; must be in the offer's granted audiences."),
      from_name: z.string().describe("Display name in the From: header (e.g. 'Maya at Acme')."),
      from_email: z.string().optional().describe("From: address; must be on the offer's verified sender domain. Defaults to agent@<domain>."),
      reply_to: z.string().optional().describe("Reply-To header. Defaults to from_email."),
      subject_template: z.string().describe("Subject; can use {{first_name}} etc. — Claude will personalize."),
      body_template: z.string().describe("Brief / talking points for Claude to draft from. Per-recipient body is generated."),
      variants: z
        .array(
          z.object({
            label: z.string().describe("e.g. 'A', 'B', 'control'"),
            weight: z.number().int().min(1).max(100).default(1),
            hint: z.string().optional().describe("Copy direction for this variant"),
          }),
        )
        .min(1)
        .max(8)
        .describe("A/B variants. Pass a single entry if you don't want a split."),
    },
    async ({ offer_id, audience_upload_id, from_name, from_email, reply_to, subject_template, body_template, variants }) => {
      authCtx.requireAuth("dispatch_email_campaign");
      const data = await agentFetch(`/v1/agent/offers/${offer_id}/dispatch-email`, {
        method: "POST",
        body: JSON.stringify({
          audienceUploadId: audience_upload_id,
          fromName: from_name,
          fromEmail: from_email,
          replyTo: reply_to,
          subjectTemplate: subject_template,
          bodyTemplate: body_template,
          variants,
        }),
      });
      return formatResponse(data);
    },
  );

  // ---- dispatch_voice_campaign (sub-plan #5) -------------------------------

  server.tool(
    "dispatch_voice_campaign",
    "Place outbound phone calls to the granted audience using Vapi for telephony, ElevenLabs voice, and Claude Sonnet for the real-time conversation. Each call uses the system_prompt as the assistant's instructions; greeting is the first thing the recipient hears. Voicemail-drop on no-answer; live-transfer to a designated number when the lead matches the transfer trigger. TCPA-compliant (DNC list scrub + recipient-timezone 8am-9pm window). Outcomes flow back via the Vapi webhook → outcome event stream.",
    {
      offer_id: z.string().describe("Offer the agent has accepted."),
      audience_upload_id: z.string().describe("Audience id; must be granted to the offer. Rows must include a phone column (E.164 or 10-digit US)."),
      system_prompt: z.string().min(40).describe("System instructions for the assistant during the call."),
      greeting: z.string().optional().describe("First thing the assistant says when the customer answers."),
      first_message_mode: z.enum(["assistant_speaks_first", "wait_for_user"]).optional(),
      voice_id: z.string().optional().describe("ElevenLabs voice id. Defaults to 'rachel'."),
      from_phone_number: z.string().optional().describe("Vapi phoneNumberId provisioned in Vapi dashboard."),
      voicemail_drop_id: z.string().optional().describe("ID of a voicemail-drop the business pre-recorded; used when the call hits voicemail."),
      live_transfer_number: z.string().optional().describe("E.164 phone to transfer to when the trigger matches."),
      live_transfer_trigger: z.string().optional().describe("Free-form trigger description (e.g. 'asks about pricing')."),
    },
    async ({
      offer_id, audience_upload_id, system_prompt, greeting, first_message_mode,
      voice_id, from_phone_number, voicemail_drop_id, live_transfer_number, live_transfer_trigger,
    }) => {
      authCtx.requireAuth("dispatch_voice_campaign");
      const data = await agentFetch(`/v1/agent/offers/${offer_id}/dispatch-voice`, {
        method: "POST",
        body: JSON.stringify({
          audienceUploadId: audience_upload_id,
          systemPrompt: system_prompt,
          greeting,
          firstMessageMode: first_message_mode,
          voiceId: voice_id,
          fromPhoneNumber: from_phone_number,
          voicemailDropId: voicemail_drop_id,
          liveTransferNumber: live_transfer_number,
          liveTransferTrigger: live_transfer_trigger,
        }),
      });
      return formatResponse(data);
    },
  );

  // ---- dispatch_sms_campaign (sub-plan #6) ---------------------------------

  server.tool(
    "dispatch_sms_campaign",
    "Send outbound SMS to the granted audience via Twilio. Body template supports {{first_name}}-style row substitution. STOP/HELP keywords are auto-handled at inbound. TCPA 8am-9pm window enforced. Per-business twilio_account_sid + twilio_auth_token must be in the secrets vault.",
    {
      offer_id: z.string().describe("Offer the agent has accepted."),
      audience_upload_id: z.string().describe("Audience id; rows must include a phone column."),
      from_phone_number: z.string().describe("E.164 of the Twilio-provisioned sending number."),
      body_template: z.string().describe("Message body, supports {{column_name}} placeholders. Twilio appends STOP=END text automatically for A2P US numbers."),
      help_reply: z.string().optional().describe("Optional override for the carrier-mandated HELP reply."),
    },
    async ({ offer_id, audience_upload_id, from_phone_number, body_template, help_reply }) => {
      authCtx.requireAuth("dispatch_sms_campaign");
      const data = await agentFetch(`/v1/agent/offers/${offer_id}/dispatch-sms`, {
        method: "POST",
        body: JSON.stringify({
          audienceUploadId: audience_upload_id,
          fromPhoneNumber: from_phone_number,
          bodyTemplate: body_template,
          helpReply: help_reply,
        }),
      });
      return formatResponse(data);
    },
  );

  // ---- configure_landing_page (sub-plan #7) -------------------------------

  server.tool(
    "configure_landing_page",
    "Set up the per-prospect landing page for an offer. Welcome title + body support {{first_name}} / {{column_name}} substitution. Optional calendar embed URL (Cal.com / Calendly). Optional lead-capture form fields. Idempotent — call again to update.",
    {
      offer_id: z.string().describe("Offer the agent has accepted."),
      welcome_title: z.string().describe("Headline shown above the body. Supports {{column}} placeholders."),
      welcome_body: z.string().describe("Body text. Newlines are paragraph breaks. Supports {{column}} placeholders."),
      calendar_url: z.string().optional().describe("Cal.com / Calendly embed URL."),
      lead_form_fields: z.array(z.object({
        name: z.string().describe("snake_case field name"),
        label: z.string(),
        type: z.enum(["text", "email", "tel", "textarea"]).default("text"),
        required: z.boolean().optional(),
      })).max(8).optional(),
      lead_form_cta: z.string().optional().describe("Header above the lead form, e.g. 'Tell us more'."),
      brand_color: z.string().optional().describe("CSS hex color, e.g. #3ECFB4."),
      brand_logo_url: z.string().optional(),
      agent_display_name: z.string().optional().describe("Name shown in chat + footer (e.g. 'Maya at Acme')."),
    },
    async ({ offer_id, welcome_title, welcome_body, calendar_url, lead_form_fields, lead_form_cta, brand_color, brand_logo_url, agent_display_name }) => {
      authCtx.requireAuth("configure_landing_page");
      const data = await agentFetch(`/v1/agent/offers/${offer_id}/configure-landing-page`, {
        method: "POST",
        body: JSON.stringify({
          welcomeTitle: welcome_title,
          welcomeBody: welcome_body,
          calendarUrl: calendar_url,
          leadFormFields: lead_form_fields ?? [],
          leadFormCta: lead_form_cta,
          brandColor: brand_color,
          brandLogoUrl: brand_logo_url,
          agentDisplayName: agent_display_name,
        }),
      });
      return formatResponse(data);
    },
  );

  // ---- dispatch_landing_pages (sub-plan #7) -------------------------------

  server.tool(
    "dispatch_landing_pages",
    "Mint per-prospect landing-page tokens for an audience. Returns the (token, row, url) map. Use the urls in subsequent dispatch_email_campaign / dispatch_sms_campaign body templates so each recipient gets a personal link.",
    {
      offer_id: z.string(),
      audience_upload_id: z.string().describe("Audience id; must be granted to the offer."),
    },
    async ({ offer_id, audience_upload_id }) => {
      authCtx.requireAuth("dispatch_landing_pages");
      const data = await agentFetch(`/v1/agent/offers/${offer_id}/dispatch-landing-pages`, {
        method: "POST",
        body: JSON.stringify({ audienceUploadId: audience_upload_id }),
      });
      return formatResponse(data);
    },
  );

  // ---- send_landing_chat (sub-plan #7) -------------------------------------

  server.tool(
    "send_landing_chat",
    "Reply to a prospect in their landing-page chat. Long-poll on the prospect's side delivers within 3s. Body is plain text up to 2000 chars.",
    {
      prospect_id: z.string().describe("LandingProspect id (from dispatch_landing_pages or the business prospects feed)."),
      body: z.string().min(1).max(2000),
    },
    async ({ prospect_id, body }) => {
      authCtx.requireAuth("send_landing_chat");
      const data = await agentFetch(`/v1/agent/landing-prospects/${prospect_id}/chat`, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
      return formatResponse(data);
    },
  );

  // ---- list_workflow_templates (sub-plan #8) ------------------------------

  server.tool(
    "list_workflow_templates",
    "List the built-in workflow templates the agent can use to chain channels into a funnel (cold_outreach_3_step, nurture_7_day, event_invite_2_step, landing_warm_followup).",
    {},
    async () => {
      authCtx.requireAuth("list_workflow_templates");
      const data = await agentFetch(`/v1/agent/workflow-templates`);
      return formatResponse(data);
    },
  );

  // ---- start_workflow (sub-plan #8) ---------------------------------------

  server.tool(
    "start_workflow",
    "Kick off a multi-channel workflow (email → voice → SMS → landing) for an audience. Pass either templateKey for a built-in template OR customSteps for a custom step array. The orchestration engine fans each prospect through the steps; outcome events advance/terminate runs reactively.",
    {
      offer_id: z.string().describe("Offer the agent has accepted."),
      audience_upload_id: z.string().describe("Audience id; one WorkflowRun is created per row."),
      template_key: z.string().optional().describe("e.g. 'cold_outreach_3_step'. Mutually exclusive with custom_steps."),
      custom_steps: z.array(z.object({
        channel: z.enum(["email", "voice", "sms", "landing"]),
        action: z.string(),
        config: z.record(z.string(), z.unknown()).default({}),
        waitForOutcomes: z.array(z.string()).default([]),
        waitMaxDays: z.number().min(0).max(60).default(3),
        onTrigger: z.enum(["terminate", "next", "skip_to"]).default("terminate"),
        skipToIndex: z.number().int().nonnegative().optional(),
      })).optional().describe("Custom step list. Mutually exclusive with template_key."),
      name: z.string().optional().describe("Optional human-readable name for the workflow definition."),
    },
    async ({ offer_id, audience_upload_id, template_key, custom_steps, name }) => {
      authCtx.requireAuth("start_workflow");
      const data = await agentFetch(`/v1/agent/offers/${offer_id}/start-workflow`, {
        method: "POST",
        body: JSON.stringify({
          audienceUploadId: audience_upload_id,
          templateKey: template_key,
          customSteps: custom_steps,
          name,
        }),
      });
      return formatResponse(data);
    },
  );

  // ---- place_bid (sub-plan #9) -------------------------------------------

  server.tool(
    "place_bid",
    "Place or update a bid on an offer. Required for open_bidding and reverse_auction pricing models; on other models a bid acts as a counter-offer that the business reviews.",
    {
      offer_id: z.string(),
      proposed_price_usd: z.number().positive().optional().describe("Your proposed price in USD."),
      proposed_deadline_days: z.number().int().positive().max(365).optional().describe("Your proposed deadline."),
      notes: z.string().max(2000).optional().describe("Brief pitch — why you, references, approach."),
    },
    async ({ offer_id, proposed_price_usd, proposed_deadline_days, notes }) => {
      authCtx.requireAuth("place_bid");
      const data = await agentFetch(`/v1/agent/offers/${offer_id}/bids`, {
        method: "POST",
        body: JSON.stringify({
          proposedPriceUsd: proposed_price_usd,
          proposedDeadlineDays: proposed_deadline_days,
          notes,
        }),
      });
      return formatResponse(data);
    },
  );

  // ---- withdraw_bid (sub-plan #9) ----------------------------------------

  server.tool(
    "withdraw_bid",
    "Withdraw your pending bid on an offer. Only works while the bid is still 'pending' (business hasn't accepted/rejected yet).",
    {
      offer_id: z.string(),
    },
    async ({ offer_id }) => {
      authCtx.requireAuth("withdraw_bid");
      const data = await agentFetch(`/v1/agent/offers/${offer_id}/bids/withdraw`, {
        method: "POST",
        body: "{}",
      });
      return formatResponse(data);
    },
  );

  // ---- list_my_inbox (sub-plan #9) ---------------------------------------

  server.tool(
    "list_my_inbox",
    "Combined feed: open offers you're tier-eligible for, your active assignments, and your bids (pending/accepted/rejected). Use this to plan your next action.",
    {},
    async () => {
      authCtx.requireAuth("list_my_inbox");
      const data = await agentFetch(`/v1/agent/inbox`);
      return formatResponse(data);
    },
  );

  // ---- get_agent_profile (sub-plan #9) -----------------------------------

  server.tool(
    "get_agent_profile",
    "Get your current agent profile (display name, bio, specializations, tier, lifetime completions).",
    {},
    async () => {
      authCtx.requireAuth("get_agent_profile");
      const data = await agentFetch(`/v1/agent/profile`);
      return formatResponse(data);
    },
  );

  // ---- edit_agent_profile (sub-plan #9) ----------------------------------

  server.tool(
    "edit_agent_profile",
    "Create or update your public agent profile. Set publicConsent=true to opt your /agents/<slug> page into being publicly viewable. Tier and completion count are computed by Computeback.",
    {
      display_name: z.string().min(2).max(80),
      bio: z.string().max(2000).optional(),
      avatar_url: z.string().optional(),
      specializations: z.array(z.string()).max(20).optional().describe("e.g. ['B2B SaaS','Cold email','Voice qualification']"),
      public_consent: z.boolean().optional().describe("Set true to make your profile page publicly viewable."),
      contact_email: z.string().optional(),
      website_url: z.string().optional(),
    },
    async ({ display_name, bio, avatar_url, specializations, public_consent, contact_email, website_url }) => {
      authCtx.requireAuth("edit_agent_profile");
      const data = await agentFetch(`/v1/agent/profile`, {
        method: "PUT",
        body: JSON.stringify({
          displayName: display_name,
          bio,
          avatarUrl: avatar_url,
          specializations,
          publicConsent: public_consent,
          contactEmail: contact_email,
          websiteUrl: website_url,
        }),
      });
      return formatResponse(data);
    },
  );

  // ---- get_settlement_status (sub-plan #10, T28) -------------------------

  server.tool(
    "get_settlement_status",
    "Get the settlement status for one of your assignments. Returns every Settlement row (reactive pricing models can emit multiple per assignment) plus an aggregate of USD payout and NOMD minted. Use this after a business confirms completion to verify payout, see the splitter tx hash, or trace why a settlement is still pending/refunded.",
    {
      assignment_id: z.string().min(1).describe("The OfferAssignment id (returned by list_my_inbox under assignments[].id)."),
    },
    async ({ assignment_id }) => {
      authCtx.requireAuth("get_settlement_status");
      const data = await agentFetch(`/v1/agent/assignments/${assignment_id}/settlement`);
      return formatResponse(data);
    },
  );

  // ---- list_my_settlements (sub-plan #10, T28) ---------------------------

  server.tool(
    "list_my_settlements",
    "Paginated list of your settlement rows across all assignments — useful for earnings dashboards or proving payout history. Filter by status (settled, partial, refunded, pending, failed). Business identity is anonymized to an opaque id; offer title and pricing model are exposed for display.",
    {
      status: z
        .enum(["settled", "partial", "refunded", "pending", "failed"])
        .optional()
        .describe("Filter to a single status."),
      limit: z.number().int().min(1).max(100).default(50).optional().describe("Page size, max 100."),
      offset: z.number().int().min(0).default(0).optional().describe("Pagination offset."),
    },
    async ({ status, limit, offset }) => {
      authCtx.requireAuth("list_my_settlements");
      const qs = new URLSearchParams();
      if (status) qs.set("status", status);
      qs.set("limit", String(limit ?? 50));
      qs.set("offset", String(offset ?? 0));
      const data = await agentFetch(`/v1/agent/settlements?${qs.toString()}`);
      return formatResponse(data);
    },
  );

  return server;
}
