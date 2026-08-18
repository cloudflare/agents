# Platform support

Use this reference to choose between the built-in Channels. Every Channel can
be delivered to directly, registered with a durable `ChannelHost`, and composed
with `fallback()` or `fanout()`.

| Feature                           | Email                                                                            | Telegram                                                       | Browser voice                                            |
| --------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------- |
| Factory                           | `email()` from `@cloudflare/channels`                                            | `telegram()` from `@cloudflare/channels`                       | `browserVoice()` from `@cloudflare/channels/voice`       |
| Outbound transport                | Cloudflare Email Service binding                                                 | Telegram Bot API                                               | `@cloudflare/voice` TTS and Voice client protocol        |
| Destination                       | Configured `to`, `cc`, and `bcc` addresses                                       | Configured user, group, or channel chat ID                     | Current browser connection returned by `getConnection()` |
| Direct delivery                   | Yes                                                                              | Yes                                                            | Yes                                                      |
| Durable Host delivery and retries | Yes                                                                              | Yes                                                            | Yes                                                      |
| Delivery reference                | Email Service message ID                                                         | Telegram message ID                                            | No                                                       |
| Availability check                | No                                                                               | No                                                             | Yes, based on the current browser connection             |
| Message title                     | Email subject                                                                    | Prepended to text by default                                   | Ignored by the default speech projection                 |
| Message content                   | Canonical Markdown sent as plain text                                            | Plain text by default; optional HTML or MarkdownV2 parse mode  | Synthesized speech plus an assistant transcript frame    |
| Custom content projection         | No                                                                               | `toText()`                                                     | `toSpeechText()`                                         |
| Inbound messages                  | Yes, through Workers Email events                                                | Yes, through an optional webhook                               | No                                                       |
| Reply correlation                 | `Message-ID` and `In-Reply-To`                                                   | Telegram message and reply-to IDs                              | No                                                       |
| Approval requests                 | Yes, using Host-generated approval links                                         | Yes, with reply instructions and interaction correlation       | No                                                       |
| Approval responses                | Yes, through Host approval links; email replies remain ordinary inbound messages | Yes, an exact `YES` or `NO` reply to the approval message      | No                                                       |
| Attachments                       | No                                                                               | No                                                             | Not applicable                                           |
| Ingress filtering or verification | Optional envelope recipient and sender filters                                   | Webhook secret header and configured chat ID                   | Not applicable                                           |
| Provider setup                    | Configure Email Routing and a Send Email binding                                 | Register the Host ingress URL with Telegram using `setWebhook` | Connect with `VoiceClient` or `useVoiceAgent()`          |

## Platform notes

### Email

- `email()` infers inbound addresses by reversing its configured outbound
  `from` and `to` addresses. Use `inbound` to override either filter.
- Envelope sender and recipient checks are routing filters, not cryptographic
  sender authentication.
- If an inbound message has no `Message-ID`, Channels uses a SHA-256 hash of the
  raw message as its durable reference.
- Approval links require a `ChannelHost` configured with `publicBaseUrl`.
- HTML bodies and attachments are not currently supported.

### Telegram

- Webhook ingress is optional. Supply `webhook.secretToken` when constructing
  the Channel, then register `host.ingressUrl(channelId)` with Telegram.
- `ChannelHost.init()` does not call Telegram's `setWebhook` API.
- The webhook secret verifies that the request came through the configured
  Telegram webhook. Applications must apply any participant authorization
  policy separately.
- An unthreaded `YES` or `NO` is an ordinary inbound message. It resolves an
  approval only when sent as a reply to the correlated approval message.
- Text is limited to 4,096 characters. `maxLength` can set a lower limit.

### Browser voice

- Browser voice is output-only. It does not provide microphone input,
  speech-to-text, ordinary inbound messages, or approval responses.
- `browserVoice()` synthesizes each complete message before sending audio. It
  does not stream incremental message content.
- MP3 is the default audio format. `sampleRate` defaults to 16 kHz and applies
  only to raw PCM; encoded formats carry their own sample rate.
- Delivery failures before audio starts are retryable. A failure after audio
  starts is `uncertain`, because replaying it could repeat speech the user
  already heard.
