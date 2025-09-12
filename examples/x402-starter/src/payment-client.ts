/**
 * X402 Client wrapper for handling payment-enabled fetch requests
 * Similar to x402-fetch from Vercel's implementation but for Cloudflare Workers
 */

import { PaymentAuthorization } from "./types";
import { CoinbaseWallet } from "./coinbase-wallet";

export interface X402ClientOptions {
  wallet?: CoinbaseWallet;
  walletAddress?: string;
  autoPayment?: boolean;
  maxPaymentAmount?: number;
}

export class X402Client {
  private options: X402ClientOptions;

  constructor(options: X402ClientOptions = {}) {
    this.options = {
      autoPayment: true,
      maxPaymentAmount: 0.1, // Default max payment of $0.10
      ...options
    };
  }

  /**
   * Wrap fetch to handle X402 payment requirements
   */
  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);

    // First attempt without payment
    let response = await fetch(request);

    // Check if payment is required (402 status)
    if (response.status === 402) {
      const paymentRequired = response.headers.get("X-Payment-Required");

      if (!paymentRequired) {
        throw new Error("Payment required but no payment details provided");
      }

      const paymentInfo = JSON.parse(paymentRequired);

      // Check if we should auto-pay
      if (!this.options.autoPayment) {
        return response; // Return 402 response for manual handling
      }

      // Check payment amount limit
      if (paymentInfo.amount > this.options.maxPaymentAmount!) {
        throw new Error(
          `Payment amount ${paymentInfo.amount} exceeds maximum ${this.options.maxPaymentAmount}`
        );
      }

      // Create payment authorization
      const authorization = await this.createPaymentAuthorization(paymentInfo);

      // Retry request with payment
      const authorizedRequest = new Request(request, {
        headers: {
          ...Object.fromEntries(request.headers.entries()),
          "X-Payment-Authorization": JSON.stringify(authorization)
        }
      });

      response = await fetch(authorizedRequest);
    }

    return response;
  }

  /**
   * Create payment authorization for X402 protocol
   */
  private async createPaymentAuthorization(
    paymentInfo: any
  ): Promise<PaymentAuthorization> {
    const paymentId = `demo_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // In production, this would:
    // 1. Use the wallet to create actual payment
    // 2. Sign the payment with private key
    // 3. Submit to blockchain

    if (this.options.wallet) {
      // Ensure sufficient funds
      const hasFunds = await this.options.wallet.hasSufficientFunds(
        paymentInfo.amount,
        paymentInfo.currency
      );

      if (!hasFunds) {
        // Try to request funds from faucet (testnet only)
        await this.options.wallet.requestFunds(
          paymentInfo.currency,
          paymentInfo.amount * 2
        );
      }
    }

    return {
      paymentId,
      amount: paymentInfo.amount,
      currency: paymentInfo.currency,
      recipient: paymentInfo.recipient,
      timestamp: Date.now(),
      signature: `demo_signature_${paymentId}` // In production, real cryptographic signature
    };
  }

  /**
   * Check if a response requires payment
   */
  static requiresPayment(response: Response): boolean {
    return response.status === 402;
  }

  /**
   * Extract payment information from 402 response
   */
  static getPaymentInfo(response: Response): any | null {
    if (response.status !== 402) {
      return null;
    }

    const paymentRequired = response.headers.get("X-Payment-Required");
    if (!paymentRequired) {
      return null;
    }

    try {
      return JSON.parse(paymentRequired);
    } catch (error) {
      console.error("Failed to parse payment info:", error);
      return null;
    }
  }
}

/**
 * Create a wrapped fetch function with X402 payment support
 */
export function createX402Fetch(options: X402ClientOptions = {}): typeof fetch {
  const client = new X402Client(options);
  return client.fetch.bind(client);
}
