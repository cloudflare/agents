# X402 AI Starter

AI Chat application with paid tools using X402 Protocol, Cloudflare Agents SDK, and OpenAI GPT-4.

## 🚀 Features

- **OpenAI GPT-4** powered AI chat interface
- **AI Chat Interface** with both free and paid tools
- **X402 Protocol Integration** for seamless payments
- **MCP Server** with paid tool capabilities
- **Coinbase CDP Wallet** integration for testnet payments
- **Payment Middleware** for protecting API routes
- **Real-time Payment Tracking** and usage analytics
- **Modern React UI** with wallet status and spending history

## 🔧 Setup

1. **Install dependencies:**

   ```bash
   npm install
   ```

2. **Configure OpenAI:**
   Create a `.dev.vars` file in the project root:

   ```
   OPENAI_API_KEY=your-openai-api-key-here
   ```

3. **Start the development server:**

   ```bash
   npm start
   ```

   The app will be available at http://localhost:5173

## 🤖 AI Configuration

The application uses **OpenAI GPT-4** by default. The AI model is configured in `src/agent.ts`:

- Regular chat uses GPT-4 with context about available tools and spending
- Premium chat uses GPT-4 with enhanced reasoning capabilities
- All AI responses include payment context and tool availability

To use your OpenAI API key:

1. Sign up at [OpenAI Platform](https://platform.openai.com)
2. Generate an API key
3. Add it to your `.dev.vars` file

## 🛠 Tech Stack

- **[Cloudflare Agents SDK](https://github.com/cloudflare/agents)** - AI agent framework
- **[Cloudflare Workers](https://workers.cloudflare.com/)** - Serverless runtime
- **[Durable Objects](https://developers.cloudflare.com/durable-objects/)** - Stateful storage
- **[Model Context Protocol (MCP)](https://modelcontextprotocol.io/)** - Tool integration
- **[X402 Protocol](https://x402.org)** - HTTP payment standard
- **[Coinbase CDP](https://docs.cdp.coinbase.com/)** - Wallet management
- **[OpenAI API](https://openai.com/api/)** - Language model
- **[React](https://react.dev/)** - Frontend framework

## 📋 Prerequisites

1. **Cloudflare Account** with Workers enabled
2. **OpenAI API Key** for AI functionality
3. **Coinbase CDP Account** for wallet management (optional for demo)

## 🚀 Quick Start

### 1. Clone and Install

```bash
cd examples/x402-ai-starter
npm install
```

### 2. Environment Setup

Copy the example environment file:

```bash
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` with your credentials:

```env
# Required
OPENAI_API_KEY=your-openai-api-key-here

# Optional (for full wallet functionality)
CDP_API_KEY_ID=your-coinbase-cdp-api-key-id
CDP_API_KEY_SECRET=your-coinbase-cdp-api-key-secret
CDP_WALLET_SECRET=your-coinbase-cdp-wallet-secret
WALLET_ADDRESS=your-wallet-address-for-receiving-payments
```

### 3. Development

Start the development server:

```bash
npm run dev
```

This will start:

- Cloudflare Workers dev server on `http://localhost:8787`
- Vite dev server for the React frontend on `http://localhost:5173`

### 4. Testing the Demo

1. **Open the frontend** at `http://localhost:5173`
2. **Try free tools** by asking about weather
3. **Test paid tools** by requesting analysis or reports
4. **Use premium chat** with the demo button
5. **Monitor spending** in the wallet status panel

## 🏗 Architecture

### Core Components

#### X402Agent (`src/x402-agent.ts`)

- Main AI chat agent using Agents SDK
- Integrates with MCP server for tool access
- Handles X402 payment authorization
- Manages conversation state and spending tracking

#### X402MCP (`src/x402-mcp-server.ts`)

- MCP server with both free and paid tools
- Implements X402 payment validation
- Tracks earnings and tool usage statistics
- Provides payment-protected tool execution

#### X402Middleware (`src/x402-middleware.ts`)

- HTTP middleware for protecting API routes
- Handles 402 Payment Required responses
- Validates payment authorizations
- Supports route patterns and wildcards

#### CoinbaseWallet (`src/coinbase-wallet.ts`)

- Wallet integration for Coinbase CDP
- Payment creation and verification
- Balance checking and fund management
- Testnet faucet integration

### Payment Flow

1. **Client requests** protected resource or paid tool
2. **Server responds** with 402 status and payment instructions
3. **Client creates** payment authorization (via wallet)
4. **Client retries** request with payment header
5. **Server validates** payment and provides resource
6. **Payment recorded** in usage statistics

## 🔧 Available Tools

### Free Tools

- **get_weather** - Current weather information

### Paid Tools

- **premium_analysis** ($0.01) - Advanced data analysis with AI insights
- **generate_report** ($0.05) - Comprehensive business reports
- **market_intelligence** ($0.02) - Real-time market analysis

### Protected Routes

- **`/api/premium-chat`** ($0.001) - Enhanced AI chat with advanced features
- **`/api/analysis/*`** ($0.005) - Analysis endpoints

## 📊 API Endpoints

### Chat & AI

- `POST /chat` - Main chat interface
- `POST /api/premium-chat` - Premium chat (requires payment)
- `POST /api/analysis/{type}` - Analysis endpoints (requires payment)

### Wallet & Payments

- `GET /api/wallet/status` - Current wallet balance and network
- `GET /api/spending/history` - Tool usage and spending history

### MCP Integration

- `GET /mcp` - MCP server endpoint for tool discovery
- `POST /mcp` - MCP tool execution

## 🌐 Deployment

### Deploy to Cloudflare Workers

1. **Configure wrangler.jsonc** with your account details
2. **Set production secrets**:
   ```bash
   wrangler secret put OPENAI_API_KEY
   wrangler secret put CDP_API_KEY_ID
   wrangler secret put CDP_API_KEY_SECRET
   wrangler secret put CDP_WALLET_SECRET
   wrangler secret put WALLET_ADDRESS
   ```
3. **Deploy**:
   ```bash
   npm run deploy
   ```

### Production Considerations

- **Use mainnet** for real payments (set `NETWORK=base`)
- **Implement proper** signature verification for payments
- **Add rate limiting** and abuse protection
- **Monitor costs** and set spending limits
- **Use real wallet** addresses for payment recipients

## 🧪 Testing Payments

The template uses **base-sepolia testnet** by default with mock payments:

1. **Testnet USDC** - Fake money for testing
2. **Auto-faucet** - Automatically requests funds when low
3. **Mock verification** - Accepts well-formed payment authorizations
4. **Demo payments** - Uses `demo_` prefixed payment IDs

For production, integrate with real Coinbase CDP wallet operations.

## 🔒 Security Notes

- **Payment validation** is simplified for demo purposes
- **Signature verification** should be implemented for production
- **Rate limiting** should be added to prevent abuse
- **Input validation** is basic and should be enhanced
- **Error handling** should not expose sensitive information

## 🤝 Contributing

This template demonstrates X402 integration patterns. Contributions welcome for:

- Enhanced payment verification
- Additional tool examples
- UI/UX improvements
- Security enhancements
- Documentation updates

## 📚 Learn More

- [X402 Protocol Specification](https://x402.org)
- [Cloudflare Agents Documentation](https://github.com/cloudflare/agents)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Coinbase CDP Documentation](https://docs.cdp.coinbase.com/)
- [Vercel X402 AI Starter](https://github.com/vercel-labs/x402-ai-starter)

## 📄 License

This template is part of the Cloudflare Agents SDK and follows the same license terms.
