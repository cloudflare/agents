import type {
  ChannelMessageSurface,
  ChannelMessageSurfaceInput
} from "../../surface";

export type EmailSurfaceAddress = string | { email: string; name: string };
export type EmailSurfaceRecipients =
  | EmailSurfaceAddress
  | readonly EmailSurfaceAddress[];

export type EmailMessageAddress = {
  from: EmailSurfaceAddress;
  to: EmailSurfaceRecipients;
  replyTo?: EmailSurfaceAddress;
  cc?: EmailSurfaceRecipients;
  bcc?: EmailSurfaceRecipients;
  headers?: Readonly<Record<string, string>>;
  subject?: string;
  inReplyTo?: string;
  references?: readonly string[];
};

export type EmailMessageSurface = ChannelMessageSurface<
  string,
  EmailMessageAddress
>;

export type EmailMessageSurfaceInput =
  ChannelMessageSurfaceInput<EmailMessageAddress>;
