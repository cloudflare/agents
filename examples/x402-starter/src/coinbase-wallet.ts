// Coinbase CDP Wallet Integration for Cloudflare Workers
export interface CoinbaseConfig {
  apiKeyId: string;
  apiKeySecret: string;
  walletSecret: string;
  network?: string;
}

export interface WalletBalance {
  currency: string;
  amount: number;
}

export interface TransactionResult {
  transactionHash: string;
  status: "pending" | "completed" | "failed";
  amount: number;
  currency: string;
}

export class CoinbaseWallet {
  private config: CoinbaseConfig;

  constructor(config: CoinbaseConfig) {
    this.config = config;
  }

  async getBalance(currency: string = "USDC"): Promise<WalletBalance> {
    // In a real implementation, this would call Coinbase CDP API
    // For demo purposes, return mock data
    return {
      currency,
      amount: 100.0 // Mock balance
    };
  }

  async requestFunds(
    currency: string = "USDC",
    amount: number = 10
  ): Promise<boolean> {
    // In a real implementation, this would call the Coinbase CDP faucet
    // For demo purposes on base-sepolia testnet
    console.log(`Requesting ${amount} ${currency} from faucet`);
    return true;
  }

  async verifyPayment(
    paymentId: string,
    expectedAmount: number,
    expectedCurrency: string,
    recipient: string
  ): Promise<TransactionResult | null> {
    // In a real implementation, this would verify the transaction on-chain
    // For demo purposes, simulate verification

    // Mock verification logic
    if (paymentId.startsWith("demo_")) {
      return {
        transactionHash: `0x${paymentId.slice(5)}${"0".repeat(60)}`,
        status: "completed",
        amount: expectedAmount,
        currency: expectedCurrency
      };
    }

    return null;
  }

  async createPayment(
    amount: number,
    currency: string,
    recipient: string,
    description?: string
  ): Promise<string> {
    // In a real implementation, this would create a payment transaction
    // For demo purposes, return a mock payment ID
    const paymentId = `demo_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    console.log(
      `Created payment: ${paymentId} for ${amount} ${currency} to ${recipient}`
    );
    if (description) {
      console.log(`Description: ${description}`);
    }

    return paymentId;
  }

  // Helper method to check if wallet has sufficient funds
  async hasSufficientFunds(
    amount: number,
    currency: string = "USDC"
  ): Promise<boolean> {
    const balance = await this.getBalance(currency);
    return balance.amount >= amount;
  }

  // Helper method to auto-request funds if balance is low
  async ensureFunds(
    minAmount: number,
    currency: string = "USDC"
  ): Promise<boolean> {
    const balance = await this.getBalance(currency);

    if (balance.amount < minAmount) {
      console.log(
        `Balance low (${balance.amount} ${currency}), requesting funds...`
      );
      return await this.requestFunds(currency, minAmount * 2);
    }

    return true;
  }
}

// Factory function to create wallet instance from environment
export function createWalletFromEnv(env: any): CoinbaseWallet | null {
  const config = {
    apiKeyId: env.CDP_API_KEY_ID,
    apiKeySecret: env.CDP_API_KEY_SECRET,
    walletSecret: env.CDP_WALLET_SECRET,
    network: env.NETWORK || "base-sepolia"
  };

  // Validate required config
  if (!config.apiKeyId || !config.apiKeySecret || !config.walletSecret) {
    console.warn(
      "Missing Coinbase CDP configuration. Wallet features disabled."
    );
    return null;
  }

  return new CoinbaseWallet(config);
}
