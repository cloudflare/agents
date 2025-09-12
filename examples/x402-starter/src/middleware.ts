import {
  X402MiddlewareOptions,
  PaymentConfig,
  PaymentAuthorization
} from "./types";

export class X402Middleware {
  private options: X402MiddlewareOptions;

  constructor(options: X402MiddlewareOptions) {
    this.options = options;
  }

  async handleRequest(
    request: Request,
    pathname: string
  ): Promise<Response | null> {
    const config = this.getRouteConfig(pathname);
    if (!config) {
      return null; // Route not protected
    }

    const authHeader = request.headers.get("X-Payment-Authorization");

    if (!authHeader) {
      // No payment provided, return 402 with payment instructions
      return this.createPaymentRequiredResponse(config, pathname);
    }

    // Validate payment authorization
    try {
      const isValid = await this.validatePaymentAuthorization(
        authHeader,
        config
      );
      if (!isValid) {
        return new Response("Invalid payment authorization", {
          status: 402,
          headers: {
            "X-Payment-Outcome": "failed",
            "Content-Type": "text/plain"
          }
        });
      }

      // Payment valid, allow request to proceed
      return null;
    } catch (error) {
      console.error("Payment validation error:", error);
      return new Response("Payment validation failed", {
        status: 402,
        headers: {
          "X-Payment-Outcome": "error",
          "Content-Type": "text/plain"
        }
      });
    }
  }

  private getRouteConfig(pathname: string): PaymentConfig | null {
    // Check for exact match first
    if (this.options.routes[pathname]) {
      return this.options.routes[pathname];
    }

    // Check for pattern matches (simple wildcard support)
    for (const [route, config] of Object.entries(this.options.routes)) {
      if (route.includes("*")) {
        const pattern = route.replace("*", ".*");
        const regex = new RegExp(`^${pattern}$`);
        if (regex.test(pathname)) {
          return config;
        }
      }
    }

    return null;
  }

  private createPaymentRequiredResponse(
    config: PaymentConfig,
    pathname: string
  ): Response {
    const paymentRequest = {
      amount: config.price,
      currency: config.currency || "USDC",
      recipient: this.options.recipient,
      description: config.description || `Access to ${pathname}`,
      network: config.network || this.options.network || "base-sepolia"
    };

    return new Response("Payment Required", {
      status: 402,
      headers: {
        "X-Payment-Required": JSON.stringify(paymentRequest),
        "Content-Type": "text/plain",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "X-Payment-Authorization, Content-Type",
        "Access-Control-Expose-Headers": "X-Payment-Required, X-Payment-Outcome"
      }
    });
  }

  private async validatePaymentAuthorization(
    authHeader: string,
    config: PaymentConfig
  ): Promise<boolean> {
    try {
      const authorization: PaymentAuthorization = JSON.parse(authHeader);

      // Basic validation
      if (!authorization.paymentId || !authorization.signature) {
        return false;
      }

      // Validate amount matches
      if (authorization.amount !== config.price) {
        return false;
      }

      // Validate currency matches
      const expectedCurrency = config.currency || "USDC";
      if (authorization.currency !== expectedCurrency) {
        return false;
      }

      // Validate recipient matches
      if (authorization.recipient !== this.options.recipient) {
        return false;
      }

      // Check timestamp (payment should be recent, within 5 minutes)
      const now = Date.now();
      const paymentAge = now - authorization.timestamp;
      if (paymentAge > 5 * 60 * 1000) {
        // 5 minutes
        return false;
      }

      // Use custom validation if provided
      if (this.options.validatePayment) {
        return await this.options.validatePayment(authHeader);
      }

      // For demo purposes, accept any well-formed authorization
      // In production, you would verify the signature against the blockchain
      return true;
    } catch (error) {
      console.error("Payment authorization parsing error:", error);
      return false;
    }
  }
}

// Helper function to create middleware instance
export function createX402Middleware(
  options: X402MiddlewareOptions
): X402Middleware {
  return new X402Middleware(options);
}
