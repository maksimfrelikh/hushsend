/**
 * Measure the NAT in front of this network namespace — the suite never takes a router's behaviour
 * from the rule that was loaded into it.
 *
 *   node probe.ts <ip1> <ip2> <stunHost:port> [--expect-mapping M] [--expect-filtering F]
 *
 * ONE UDP socket talks to three reflector endpoints (reflect.ts) and to the STUN server the
 * browsers will use, and compares the source each of them saw:
 *
 *   mapping    endpoint-independent           the same public port for every destination
 *              address-dependent              a new port per destination ADDRESS
 *              address-and-port-dependent     a new port per destination address:port — "symmetric"
 *
 * Then it asks the reflector to send to that mapping from an endpoint this socket never
 * contacted, first the same address on another port, then another address:
 *
 *   filtering  endpoint-independent           anything gets in (full cone)
 *              address-dependent              any port of an address that was sent to
 *              address-and-port-dependent     only the exact address:port sent to — port-restricted
 *
 * Prints one line of JSON. With --expect-*, exits 3 when the measurement differs (the JSON is still
 * printed, so the caller can say what was measured instead). Exits 1 when a reflector or the STUN
 * server does not answer at all.
 */
import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';

type Behaviour = 'endpoint-independent' | 'address-dependent' | 'address-and-port-dependent';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const expectMapping = flag('--expect-mapping');
const expectFiltering = flag('--expect-filtering');
const [ip1, ip2, stun] = args;
if (!ip1 || !ip2 || !stun) {
  console.error('usage: node probe.ts <ip1> <ip2> <stunHost:port> [--expect-mapping M] [--expect-filtering F]');
  process.exit(2);
}
const [stunHost, stunPort] = stun.split(':');

const socket = dgram.createSocket('udp4');
await new Promise<void>((resolve) => socket.bind(0, resolve));

interface Reply {
  id?: string;
  op?: string;
  address?: string;
  port?: number;
  from?: string;
}
const jsonWaiters = new Map<string, (r: Reply) => void>();
const stunWaiters = new Map<string, (b: Buffer) => void>();
const knocks = new Set<string>();
socket.on('message', (data) => {
  if (data[0] === 0x7b /* '{' */) {
    let r: Reply;
    try {
      r = JSON.parse(data.toString()) as Reply;
    } catch {
      return;
    }
    if (r.op === 'knocked' && r.from) knocks.add(r.from);
    else if (r.id) jsonWaiters.get(r.id)?.(r);
  } else if (data.length >= 20) {
    stunWaiters.get(data.subarray(8, 20).toString('hex'))?.(data);
  }
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Send until an answer comes: UDP in a fresh namespace loses the first packet to ARP often enough. */
async function ask<T>(
  what: string,
  send: () => void,
  wait: (resolve: (value: T) => void) => () => void,
): Promise<T> {
  for (let attempt = 0; attempt < 6; attempt++) {
    let cancel = (): void => {};
    const answer = await Promise.race([
      new Promise<T>((resolve) => {
        cancel = wait(resolve);
        send();
      }),
      sleep(500).then(() => undefined),
    ]);
    cancel();
    if (answer !== undefined) return answer;
  }
  console.error(`probe: no answer from ${what}`);
  process.exit(1);
}

function reflector(address: string, port: number, body: Record<string, unknown>): Promise<Reply> {
  const id = randomBytes(6).toString('hex');
  return ask<Reply>(
    `the reflector at ${address}:${port}`,
    () => socket.send(JSON.stringify({ id, ...body }), port, address),
    (resolve) => {
      jsonWaiters.set(id, resolve);
      return () => jsonWaiters.delete(id);
    },
  );
}

async function mappedBy(address: string, port: number): Promise<string> {
  const r = await reflector(address, port, { op: 'map' });
  return `${r.address}:${r.port}`;
}

/** A STUN Binding request (RFC 8489): what the browsers' ICE agents will learn from this server. */
async function mappedByStun(): Promise<string> {
  const tid = randomBytes(12);
  const request = Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00, 0x21, 0x12, 0xa4, 0x42]), tid]);
  const key = tid.toString('hex');
  const reply = await ask<Buffer>(
    `the STUN server at ${stun}`,
    () => socket.send(request, Number(stunPort), stunHost),
    (resolve) => {
      stunWaiters.set(key, resolve);
      return () => stunWaiters.delete(key);
    },
  );
  const end = Math.min(reply.length, 20 + reply.readUInt16BE(2));
  for (let pos = 20; pos + 4 <= end; ) {
    const type = reply.readUInt16BE(pos);
    const len = reply.readUInt16BE(pos + 2);
    const value = reply.subarray(pos + 4, pos + 4 + len);
    if (type === 0x0020 /* XOR-MAPPED-ADDRESS */ && value[1] === 0x01) {
      const port = value.readUInt16BE(2) ^ 0x2112;
      const cookie = [0x21, 0x12, 0xa4, 0x42];
      const ip = [...value.subarray(4, 8)].map((b, i) => b ^ cookie[i]).join('.');
      return `${ip}:${port}`;
    }
    pos += 4 + len + ((4 - (len % 4)) % 4);
  }
  console.error(`probe: the STUN server at ${stun} answered without XOR-MAPPED-ADDRESS`);
  process.exit(1);
}

async function knockArrives(from: 'same-address' | 'other-address'): Promise<boolean> {
  await reflector(ip1, 7001, { op: 'knock', from });
  await sleep(400);
  return knocks.has(from);
}

const a = await mappedBy(ip1, 7001);
const otherPort = await mappedBy(ip1, 7002);
const otherAddress = await mappedBy(ip2, 7002);
const viaStun = await mappedByStun();

const mapping: Behaviour =
  a === otherPort && a === otherAddress
    ? 'endpoint-independent'
    : a === otherPort
      ? 'address-dependent'
      : 'address-and-port-dependent';

const sameAddressIn = await knockArrives('same-address');
const otherAddressIn = await knockArrives('other-address');
const filtering: Behaviour = otherAddressIn
  ? 'endpoint-independent'
  : sameAddressIn
    ? 'address-dependent'
    : 'address-and-port-dependent';

const local = socket.address();
socket.close();
console.log(
  JSON.stringify({
    mapping,
    filtering,
    local: `${local.address}:${local.port}`,
    mapped: { first: a, otherPort, otherAddress, stun: viaStun },
  }),
);
if ((expectMapping && expectMapping !== mapping) || (expectFiltering && expectFiltering !== filtering)) {
  process.exit(3);
}
