import { z } from 'zod';

/**
 * Signaling frames (server <-> peer). The signaling server is UNTRUSTED, so every
 * inbound frame is validated against these schemas before we act on it — we never
 * trust the shape of what the server relays.
 *
 * Outbound from a peer is always: { type: 'signal', to: <peerId>, data: <opaque> }.
 * The server stamps `from` itself (no source spoofing).
 */
export const welcomeSchema = z.object({
  type: z.literal('welcome'),
  selfId: z.string(),
  room: z.string(),
  peers: z.array(z.string()),
});

export const peerJoinedSchema = z.object({
  type: z.literal('peer-joined'),
  peerId: z.string(),
});

export const peerLeftSchema = z.object({
  type: z.literal('peer-left'),
  peerId: z.string(),
});

export const signalSchema = z.object({
  type: z.literal('signal'),
  from: z.string(),
  data: z.unknown(),
});

/**
 * The server invalidated our word room (words method): TTL expiry (`reason: 'expired'`) or the
 * creator's destroy command (`reason: 'destroyed'`). The client treats either as "room gone".
 */
export const roomClosedSchema = z.object({
  type: z.literal('room-closed'),
  reason: z.string(),
});

export const serverMessageSchema = z.discriminatedUnion('type', [
  welcomeSchema,
  peerJoinedSchema,
  peerLeftSchema,
  signalSchema,
  roomClosedSchema,
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type SignalMessage = z.infer<typeof signalSchema>;
