import { z } from 'zod';

/**
 * Signaling frames (server <-> peer). The signaling server is UNTRUSTED, so every
 * inbound frame is validated against these schemas before we act on it — we never
 * trust the shape of what the server relays.
 *
 * Outbound from a peer is always: { type: 'signal', to: <peerId>, data: <opaque> }.
 * The server stamps `from` itself (no source spoofing).
 */
/**
 * A peer in the room roster (mesh lobby — room method). `id` is the readable signaling label (a
 * LABEL, not identity); `device` is a COARSE cosmetic hint the peer sent on connect (e.g. "Desktop"
 * / "Mobile" — never a full UA); `joinedAt` is the server's clock at join. None of this authenticates
 * anything (the SAS does) — it is display metadata for the human picking whom to pair with. The
 * server is UNTRUSTED, so it is validated here before reaching the store/UI.
 */
export const peerInfoSchema = z.object({
  id: z.string(),
  device: z.string(),
  joinedAt: z.number(),
});
export type PeerInfo = z.infer<typeof peerInfoSchema>;

export const welcomeSchema = z.object({
  type: z.literal('welcome'),
  selfId: z.string(),
  room: z.string(),
  peers: z.array(peerInfoSchema),
});

export const peerJoinedSchema = z.object({
  type: z.literal('peer-joined'),
  peerId: z.string(),
  device: z.string(),
  joinedAt: z.number(),
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

/**
 * The server's reply to a `turn-request` (step 6d, Reliable mode): short-lived coturn credentials
 * (`use-auth-secret` scheme) so a pair that can't connect directly can fall back through a relay.
 * The server is UNTRUSTED, so this is validated before the client feeds it into `iceServers`. An
 * empty `urls` means TURN is unconfigured/undeployed → the client stays direct-only (it ignores
 * username/credential when urls is empty). `ttl` is informational (the username embeds the expiry).
 */
export const turnCredentialsSchema = z.object({
  type: z.literal('turn-credentials'),
  urls: z.array(z.string()),
  username: z.string(),
  credential: z.string(),
  ttl: z.number(),
});

export const serverMessageSchema = z.discriminatedUnion('type', [
  welcomeSchema,
  peerJoinedSchema,
  peerLeftSchema,
  signalSchema,
  roomClosedSchema,
  turnCredentialsSchema,
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type SignalMessage = z.infer<typeof signalSchema>;
