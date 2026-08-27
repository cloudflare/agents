export type ObservedMessage = { text: string };

export type LiveDeliveryBinding = {
  name: "telegram" | "slack" | "email";
  destination: string;
  open?(): Promise<void>;
  clear(): Promise<void>;
  deliver(text: string): Promise<unknown>;
  read(): Promise<ObservedMessage[]>;
  close?(): Promise<void>;
};

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing live delivery configuration: ${name}`);
  return value;
}
