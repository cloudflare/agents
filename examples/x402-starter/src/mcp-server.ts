import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { PaymentConfig } from "./types";
import { CoinbaseWallet, createWalletFromEnv } from "./coinbase-wallet";

type Env = {
  X402_MCP: DurableObjectNamespace<X402MCP>;
  OPENAI_API_KEY: string;
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
  CDP_WALLET_SECRET?: string;
  WALLET_ADDRESS?: string;
  NETWORK?: string;
};

type State = {
  totalEarnings: number;
  toolUsageCount: Record<string, number>;
  paymentHistory: Array<{
    toolName: string;
    amount: number;
    timestamp: number;
    paymentId: string;
  }>;
};

export class X402MCP extends McpAgent<Env, State, {}> {
  server = new McpServer({
    name: "X402 Paid Tools Demo",
    version: "1.0.0",
    description: "MCP server with paid tools using X402 protocol"
  });

  private wallet: CoinbaseWallet | null = null;
  private walletAddress: string = "demo-wallet-address";

  initialState: State = {
    totalEarnings: 0,
    toolUsageCount: {},
    paymentHistory: []
  };

  async init() {
    // Initialize wallet if credentials are available
    this.wallet = createWalletFromEnv(this.env);
    this.walletAddress = this.env.WALLET_ADDRESS || "demo-wallet-address";

    // Register free tools
    this.server.tool(
      "get_weather",
      "Get current weather information (free tool)",
      {
        location: z.string().describe("City name or coordinates")
      },
      async ({ location }) => {
        // Mock weather data
        const weather = {
          location,
          temperature: Math.floor(Math.random() * 30) + 10,
          condition: ["sunny", "cloudy", "rainy", "snowy"][
            Math.floor(Math.random() * 4)
          ],
          humidity: Math.floor(Math.random() * 100)
        };

        return {
          content: [
            {
              text: `Weather in ${location}: ${weather.temperature}°C, ${weather.condition}, ${weather.humidity}% humidity`,
              type: "text"
            }
          ]
        };
      }
    );

    // Register balance tool (free in demo)
    this.server.tool(
      "get_balance",
      "Get the user's account balance (demo or real if wallet configured)",
      {},
      async () => {
        try {
          if (
            this.wallet &&
            typeof (this.wallet as any).getBalance === "function"
          ) {
            const bal = await (this.wallet as any).getBalance();
            const text = `Your account balance is ${bal.amount} ${bal.currency}.`;
            return {
              content: [{ text, type: "text" }]
            };
          }
        } catch (err) {
          // ignore and fall through to demo value
        }

        // Demo fallback
        return {
          content: [{ text: "Your account balance is 436 USDC.", type: "text" }]
        };
      }
    );

    // Register paid tool: premium_analysis
    this.server.tool(
      "premium_analysis",
      "Advanced data analysis with AI insights ($0.01 USDC)",
      {
        data: z.string().describe("Data to analyze"),
        analysisType: z
          .enum(["statistical", "predictive", "sentiment"])
          .describe("Type of analysis")
      },
      async ({
        data,
        analysisType
      }: {
        data: string;
        analysisType: "statistical" | "predictive" | "sentiment";
      }) => {
        // Simulate premium analysis
        const insights = {
          statistical: `Statistical analysis of "${data}": Mean trend positive, 85% confidence interval`,
          predictive: `Predictive model for "${data}": 73% likelihood of growth in next period`,
          sentiment: `Sentiment analysis of "${data}": 68% positive, 22% neutral, 10% negative`
        };

        return {
          content: [
            {
              text: `Premium ${analysisType} analysis result: ${insights[analysisType]}`,
              type: "text"
            }
          ]
        };
      }
    );

    // Register paid tool: generate_report
    this.server.tool(
      "generate_report",
      "Generate comprehensive business report ($0.05 USDC)",
      {
        topic: z.string().describe("Report topic"),
        format: z
          .enum(["executive", "detailed", "technical"])
          .describe("Report format")
      },
      async ({
        topic,
        format
      }: {
        topic: string;
        format: "executive" | "detailed" | "technical";
      }) => {
        // Simulate report generation
        const reportContent = {
          executive: `Executive Summary: ${topic}\n\nKey findings and strategic recommendations...`,
          detailed: `Detailed Analysis: ${topic}\n\nComprehensive research, data analysis, and conclusions...`,
          technical: `Technical Report: ${topic}\n\nMethodology, implementation details, and technical specifications...`
        };

        return {
          content: [
            {
              text: `Generated ${format} report on "${topic}":\n\n${reportContent[format]}`,
              type: "text"
            }
          ]
        };
      }
    );

    // Register paid tool: market_intelligence
    this.server.tool(
      "market_intelligence",
      "Real-time market intelligence and insights ($0.02 USDC)",
      {
        market: z.string().describe("Market or industry to analyze"),
        timeframe: z
          .enum(["1h", "24h", "7d", "30d"])
          .describe("Analysis timeframe")
      },
      async ({
        market,
        timeframe
      }: {
        market: string;
        timeframe: "1h" | "24h" | "7d" | "30d";
      }) => {
        // Simulate market intelligence
        const intelligence = `Market Intelligence Report for ${market} (${timeframe}):
        
• Market cap: $${(Math.random() * 1000000).toFixed(0)}M
• Volume change: ${(Math.random() * 20 - 10).toFixed(1)}%
• Sentiment score: ${(Math.random() * 100).toFixed(0)}/100
• Key trends: Growing adoption, regulatory clarity improving
• Risk factors: Market volatility, competitive pressure`;

        return {
          content: [
            {
              text: intelligence,
              type: "text"
            }
          ]
        };
      }
    );

    // Register resource for payment statistics
    this.server.resource("payment-stats", "mcp://x402/payment-stats", () => {
      const stats = {
        totalEarnings: this.state.totalEarnings,
        toolUsageCount: this.state.toolUsageCount,
        recentPayments: this.state.paymentHistory.slice(-10)
      };

      return {
        contents: [
          {
            text: JSON.stringify(stats, null, 2),
            uri: "mcp://x402/payment-stats"
          }
        ]
      };
    });
  }

  onStateUpdate(state: State) {
    console.log("X402 MCP state updated:", {
      totalEarnings: state.totalEarnings,
      toolUsageCount: state.toolUsageCount,
      recentPayments: state.paymentHistory.length
    });
  }

  onError(_: unknown, error?: unknown): void | Promise<void> {
    console.error("X402 MCP error:", error);
  }
}

export default X402MCP.serve("/mcp", {
  binding: "X402_MCP"
});
