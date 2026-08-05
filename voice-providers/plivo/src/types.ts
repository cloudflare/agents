/**
 * Plivo audio streaming WebSocket message types.
 *
 * See https://www.plivo.com/docs/voice/concepts/audio-streaming for the
 * full protocol. Only the messages the adapter consumes are typed here.
 */

export interface PlivoStartMessage {
  event: "start";
  sequenceNumber: number;
  start: {
    callId: string;
    streamId: string;
    accountId: string;
    tracks: string[];
  };
}

export interface PlivoMediaMessage {
  event: "media";
  sequenceNumber: number;
  streamId: string;
  media: {
    track: string;
    timestamp: string;
    chunk: number;
    payload: string;
  };
}

export interface PlivoDtmfMessage {
  event: "dtmf";
  sequenceNumber: number;
  streamId: string;
  dtmf: {
    track: string;
    digit: string;
    timestamp: string;
  };
}
