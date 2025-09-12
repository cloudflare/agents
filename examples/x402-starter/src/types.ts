// X402 Protocol Types for Cloudflare Workers
export interface X402PaymentRequest {
  amount: number;
  currency: string;
  recipient: string;
  description?: string;
  network?: string;
}

export interface X402PaymentResponse {
  paymentId: string;
  status: "pending" | "completed" | "failed";
  transactionHash?: string;
  amount: number;
  currency: string;
}

export interface X402Headers {
  "X-Payment-Required"?: string;
  "X-Payment-Authorization"?: string;
  "X-Payment-Outcome"?: string;
}

export interface PaymentConfig {
  price: number;
  currency?: string;
  description?: string;
  network?: string;
}

export interface X402MiddlewareOptions {
  routes: Record<string, PaymentConfig>;
  recipient: string;
  network?: string;
  validatePayment?: (authorization: string) => Promise<boolean>;
}

export interface PaymentAuthorization {
  paymentId: string;
  signature: string;
  timestamp: number;
  amount: number;
  currency: string;
  recipient: string;
}
