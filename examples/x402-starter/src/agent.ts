import { Agent } from "agents";
import { createOpenAI } from "@ai-sdk/openai";
import {
  streamText,
  generateText,
  experimental_createMCPClient as createMCPClient
} from "ai";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { withX402Payment } from "./mcp-client";
import { createX402Middleware } from "./middleware";
import { CoinbaseWallet, createWalletFromEnv } from "./coinbase-wallet";

type Env = {
  X402_AGENT: DurableObjectNamespace<X402Agent>;
  X402_MCP: DurableObjectNamespace;
  OPENAI_API_KEY: string;
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
  CDP_WALLET_SECRET?: string;
  WALLET_ADDRESS?: string;
  NETWORK?: string;
};

type State = {
  conversationCount: number;
  totalSpent: number;
  toolUsageHistory: Array<{
    toolName: string;
    cost: number;
    timestamp: number;
    success: boolean;
  }>;
};

export class X402Agent extends Agent<Env, State> {
  private wallet: CoinbaseWallet | null = null;
  private x402Middleware: any;
  private mcpClient: any = null;

  initialState: State = {
    conversationCount: 0,
    totalSpent: 0,
    toolUsageHistory: []
  };

  async init() {
    // Initialize wallet
    this.wallet = createWalletFromEnv(this.env);

    // Initialize X402 middleware for protected routes
    this.x402Middleware = createX402Middleware({
      routes: {
        "/api/premium-chat": {
          price: 0.001,
          currency: "USDC",
          description: "Premium AI chat with advanced features"
        },
        "/api/analysis/*": {
          price: 0.005,
          currency: "USDC",
          description: "Advanced analysis endpoints"
        }
      },
      recipient: this.env.WALLET_ADDRESS || "demo-wallet-address"
    });

    // Note: MCP client initialization would go here in a full implementation
    // For this demo, we'll simulate MCP tools directly
  }

  private getBaseUrl(): string {
    // In production, this would be your actual domain
    return "https://x402-ai-starter.your-domain.workers.dev";
  }

  private wrapMCPClientWithPayment(client: any) {
    const originalCallTool = client.callTool?.bind(client);

    if (!originalCallTool) return client;

    client.callTool = async (toolName: string, args: any) => {
      try {
        // First try without payment
        return await originalCallTool(toolName, args);
      } catch (error: any) {
        // Check if payment is required
        if (error.message?.includes("Payment required")) {
          const paymentInfo = this.extractPaymentInfo(error.message);

          if (paymentInfo && this.wallet) {
            // Create payment authorization
            const paymentAuth =
              await this.createPaymentAuthorization(paymentInfo);

            // Retry with payment
            const argsWithPayment = {
              ...args,
              paymentAuthorization: paymentAuth
            };

            const result = await originalCallTool(toolName, argsWithPayment);

            // Record successful payment
            await this.recordToolUsage(toolName, paymentInfo.amount, true);

            return result;
          }
        }
        throw error;
      }
    };

    return client;
  }

  private extractPaymentInfo(errorMessage: string): any {
    try {
      const match = errorMessage.match(/Payment required: (.+)/);
      if (match) {
        return JSON.parse(match[1]);
      }
    } catch (error) {
      console.error("Failed to parse payment info:", error);
    }
    return null;
  }

  private async createPaymentAuthorization(paymentInfo: any) {
    if (!this.wallet) {
      throw new Error("Wallet not initialized");
    }

    // Ensure we have sufficient funds
    await this.wallet.ensureFunds(paymentInfo.amount, paymentInfo.currency);

    // Create payment
    const paymentId = await this.wallet.createPayment(
      paymentInfo.amount,
      paymentInfo.currency,
      paymentInfo.recipient,
      paymentInfo.description
    );

    // Create authorization object
    return {
      paymentId,
      amount: paymentInfo.amount,
      currency: paymentInfo.currency,
      recipient: paymentInfo.recipient,
      timestamp: Date.now(),
      signature: `demo_signature_${paymentId}` // In production, this would be a real signature
    };
  }

  private async recordToolUsage(
    toolName: string,
    cost: number,
    success: boolean
  ) {
    const newState = {
      ...this.state,
      totalSpent: success
        ? this.state.totalSpent + cost
        : this.state.totalSpent,
      toolUsageHistory: [
        ...this.state.toolUsageHistory,
        {
          toolName,
          cost,
          timestamp: Date.now(),
          success
        }
      ].slice(-50) // Keep last 50 tool uses
    };

    this.setState(newState);
  }

  async onRequest(request: Request): Promise<Response> {
    // Ensure middleware is initialized
    if (!this.x402Middleware) {
      await this.init();
    }

    const url = new URL(request.url);

    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers":
            "Content-Type, Authorization, X-Payment-Authorization",
          "Access-Control-Expose-Headers":
            "X-Payment-Required, X-Payment-Outcome",
          "Access-Control-Max-Age": "86400"
        }
      });
    }

    // Check if this is a protected route
    const paymentResponse = await this.x402Middleware.handleRequest(
      request,
      url.pathname
    );
    if (paymentResponse) {
      return paymentResponse;
    }

    // Handle chat endpoint
    if (url.pathname === "/chat" && request.method === "POST") {
      return this.handleChat(request);
    }

    // Handle premium chat endpoint
    if (url.pathname === "/api/premium-chat" && request.method === "POST") {
      return this.handlePremiumChat(request);
    }

    // Handle analysis endpoints
    if (url.pathname.startsWith("/api/analysis/")) {
      return this.handleAnalysis(request, url.pathname);
    }

    // Handle wallet status
    if (url.pathname === "/api/wallet/status") {
      return this.handleWalletStatus();
    }

    // Handle spending history
    if (url.pathname === "/api/spending/history") {
      return this.handleSpendingHistory();
    }

    // Handle MCP requests are routed by the main worker

    // Default response for unknown routes
    return new Response("Not Found", { status: 404 });
  }

  private async handleChat(request: Request): Promise<Response> {
    try {
      const body = (await request.json()) as {
        messages: Array<{ role: string; content: string }>;
      };
      const lastMessage =
        body.messages[body.messages.length - 1]?.content || "";

      // No heuristic for balance queries; rely on MCP tools (get_balance)

      // Check if OpenAI API key is configured
      if (!this.env.OPENAI_API_KEY) {
        console.error("OPENAI_API_KEY not configured");
        return new Response(
          "OpenAI API key not configured. Please add OPENAI_API_KEY to your .dev.vars file.",
          {
            status: 500,
            headers: { "Content-Type": "text/plain" }
          }
        );
      }

      // Update conversation count
      this.setState({
        ...this.state,
        conversationCount: this.state.conversationCount + 1
      });

      // Create system message with payment context
      const systemMessage = `You are an AI assistant with access to both free and paid tools via the X402 protocol.

Available tools:
- Weather information (free)
- Premium analysis ($0.01) - Advanced data analysis with AI insights
- Generate reports ($0.05) - Comprehensive business reports  
- Market intelligence ($0.02) - Real-time market analysis
 - get_balance (free demo) - Returns the user's account balance. ALWAYS use this tool to answer balance questions.

User spending summary:
- Total spent: $${this.state.totalSpent.toFixed(3)}
- Tools used: ${this.state.toolUsageHistory.length}
- Conversation #${this.state.conversationCount}

Instructions:
- For any questions about balance, account balance, or funds, CALL the get_balance tool and summarize its response. Do not answer from your own knowledge.
- When using paid tools, inform the user about the cost and ask for confirmation if it's a significant expense (>$0.01).
- Prefer free tools when possible.`;

      console.log("Calling OpenAI with message:", lastMessage);
      console.log("API Key present:", !!this.env.OPENAI_API_KEY);
      console.log(
        "API Key starts with:",
        this.env.OPENAI_API_KEY?.substring(0, 7)
      );

      // Create OpenAI instance with API key
      const openai = createOpenAI({ apiKey: this.env.OPENAI_API_KEY });

      // Create MCP client over HTTP and wrap with X402 payment (like Vercel template)
      const base = new URL(request.url);
      const mcpClient = await createMCPClient({
        transport: new StreamableHTTPClientTransport(new URL("/mcp", base))
      });

      const paidMcp = withX402Payment(mcpClient, {
        autoPayment: true,
        maxPaymentAmount: 0.1,
        wallet: this.wallet || undefined,
        walletAddress: this.env.WALLET_ADDRESS
      });

      const tools = (await paidMcp.tools?.()) ?? {};
      try {
        const toolKeys = typeof tools === "object" ? Object.keys(tools) : [];
        console.log("MCP tools available:", toolKeys);
      } catch {}

      // Generate response using OpenAI with MCP tools available
      const result = await generateText({
        model: openai("gpt-4"),
        tools,
        messages: [
          { role: "system", content: systemMessage },
          { role: "user", content: lastMessage }
        ]
      });

      console.log("OpenAI response received:", result.text);

      return new Response(result.text, {
        headers: {
          "Content-Type": "text/plain",
          "X-Conversation-Count": this.state.conversationCount.toString(),
          "X-Total-Spent": this.state.totalSpent.toString()
        }
      });
    } catch (error) {
      console.error("Error in handleChat:", error);
      return new Response(
        `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
        {
          status: 500,
          headers: { "Content-Type": "text/plain" }
        }
      );
    }
  }

  private async handlePremiumChat(request: Request): Promise<Response> {
    const body = (await request.json()) as { message: string };

    // Create OpenAI instance with API key
    const openai = createOpenAI({
      apiKey: this.env.OPENAI_API_KEY
    });

    // Enhanced premium chat with advanced features
    const result = await generateText({
      model: openai("gpt-4"),
      messages: [
        {
          role: "system",
          content:
            "You are a premium AI assistant with advanced reasoning capabilities. Provide detailed, insightful responses with examples and actionable advice."
        },
        { role: "user", content: body.message }
      ]
    });

    return new Response(
      JSON.stringify({
        response: result.text,
        premium: true,
        features: [
          "advanced_reasoning",
          "detailed_examples",
          "actionable_advice"
        ]
      }),
      {
        headers: { "Content-Type": "application/json" }
      }
    );
  }

  private async handleAnalysis(
    request: Request,
    pathname: string
  ): Promise<Response> {
    const analysisType = pathname.split("/").pop();
    const body = (await request.json()) as { data: string };

    // Simulate advanced analysis
    const analyses = {
      sentiment: `Sentiment Analysis: ${body.data}\nPositive: 65%, Negative: 20%, Neutral: 15%`,
      trend: `Trend Analysis: ${body.data}\nUpward trend detected with 78% confidence`,
      risk: `Risk Analysis: ${body.data}\nLow risk profile, diversification recommended`
    };

    return new Response(
      JSON.stringify({
        analysis:
          analyses[analysisType as keyof typeof analyses] ||
          "Analysis not available",
        type: analysisType,
        timestamp: new Date().toISOString()
      }),
      {
        headers: { "Content-Type": "application/json" }
      }
    );
  }

  private async handleWalletStatus(): Promise<Response> {
    if (!this.wallet) {
      return new Response(JSON.stringify({ error: "Wallet not configured" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const balance = await this.wallet.getBalance();

    return new Response(
      JSON.stringify({
        balance,
        totalSpent: this.state.totalSpent,
        network: this.env.NETWORK || "base-sepolia"
      }),
      {
        headers: { "Content-Type": "application/json" }
      }
    );
  }

  private async handleSpendingHistory(): Promise<Response> {
    return new Response(
      JSON.stringify({
        history: this.state.toolUsageHistory,
        totalSpent: this.state.totalSpent,
        conversationCount: this.state.conversationCount
      }),
      {
        headers: { "Content-Type": "application/json" }
      }
    );
  }

  onStateUpdate(state: State) {
    console.log("X402 Agent state updated:", {
      conversations: state.conversationCount,
      totalSpent: state.totalSpent,
      toolsUsed: state.toolUsageHistory.length
    });
  }
}
