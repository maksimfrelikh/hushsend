/**
 * A second STUN destination for the lab:   node stun.ts <ip> <port>
 *
 * Answers a Binding request (RFC 8489) with the source it arrived from, as XOR-MAPPED-ADDRESS —
 * what coturn answers on its own port. The network check (src/core/natCheck.ts) asks two STUN
 * destinations from one socket; this is the second one, on coturn's address and another port, the
 * way the deployment's two STUN ports share one address.
 *
 * Plain Node, no dependencies; types are erasable so `node stun.ts` runs it as is.
 */
import dgram from 'node:dgram';

const [ip, port] = process.argv.slice(2);
if (!ip || !port) {
  console.error('usage: node stun.ts <ip> <port>');
  process.exit(2);
}

const COOKIE = 0x2112a442;
const socket = dgram.createSocket('udp4');
socket.on('message', (msg, from) => {
  if (msg.length < 20 || msg.readUInt16BE(0) !== 0x0001 || msg.readUInt32BE(4) !== COOKIE) return;
  const octets = from.address.split('.').map(Number);
  const attr = Buffer.alloc(12);
  attr.writeUInt16BE(0x0020, 0);
  attr.writeUInt16BE(8, 2);
  attr.writeUInt8(0x01, 5);
  attr.writeUInt16BE(from.port ^ 0x2112, 6);
  attr.writeUInt32BE((((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) ^ COOKIE) >>> 0, 8);
  const head = Buffer.alloc(20);
  head.writeUInt16BE(0x0101, 0);
  head.writeUInt16BE(attr.length, 2);
  msg.copy(head, 4, 4, 20);
  socket.send(Buffer.concat([head, attr]), from.port, from.address);
});
socket.bind(Number(port), ip, () => console.log(`stun up: ${ip}:${port}`));
