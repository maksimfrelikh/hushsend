/**
 * The public side of the NAT probe (probe.ts): a UDP reflector that tells a client which address
 * and port its packet arrived FROM, and on request sends it a packet from an endpoint it never
 * talked to. Runs in the lab's "internet" namespace on three addresses:
 *
 *   node reflect.ts <ip1> <ip2> <ip3>
 *
 *   ip1:7001, ip1:7002, ip2:7002   answer {op:'map'} with the source they saw — one client socket
 *                                  asking all three shows whether its NAT mapping depends on the
 *                                  destination port, the destination address, or neither;
 *   ip1:7003, ip3:7003             only ever SEND: {op:'knock', from} makes one of them fire a
 *                                  packet at the asking mapping — same address but another port,
 *                                  or an address the client never contacted — which is what tells
 *                                  port-restricted filtering from a looser one.
 *
 * Plain Node, no dependencies; types are erasable so `node reflect.ts` runs it as is.
 */
import dgram from 'node:dgram';

const [ip1, ip2, ip3] = process.argv.slice(2);
if (!ip1 || !ip2 || !ip3) {
  console.error('usage: node reflect.ts <ip1> <ip2> <ip3>');
  process.exit(2);
}

const MAP_PORT = 7001;
const MAP_PORT_OTHER = 7002;
const KNOCK_PORT = 7003;

function bind(address: string, port: number): Promise<dgram.Socket> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', reject);
    socket.bind(port, address, () => resolve(socket));
  });
}

const knockers = {
  'same-address': await bind(ip1, KNOCK_PORT),
  'other-address': await bind(ip3, KNOCK_PORT),
};

function serve(socket: dgram.Socket): void {
  socket.on('message', (data, from) => {
    let msg: { op?: unknown; id?: unknown; from?: unknown };
    try {
      msg = JSON.parse(data.toString()) as typeof msg;
    } catch {
      return;
    }
    const reply = (body: Record<string, unknown>): void => {
      socket.send(JSON.stringify({ id: msg.id, ...body }), from.port, from.address);
    };
    if (msg.op === 'map') {
      reply({ op: 'mapped', address: from.address, port: from.port });
    } else if (msg.op === 'knock' && (msg.from === 'same-address' || msg.from === 'other-address')) {
      const knocker = knockers[msg.from];
      knocker.send(
        JSON.stringify({ id: msg.id, op: 'knocked', from: msg.from }),
        from.port,
        from.address,
        // The acknowledgement goes back on the flow the client opened, so "no knock arrived" can
        // never mean "no knock was sent".
        () => reply({ op: 'knock-sent', from: msg.from }),
      );
    }
  });
}

serve(await bind(ip1, MAP_PORT));
serve(await bind(ip1, MAP_PORT_OTHER));
serve(await bind(ip2, MAP_PORT_OTHER));
console.log(`reflector up: ${ip1}:${MAP_PORT} ${ip1}:${MAP_PORT_OTHER} ${ip2}:${MAP_PORT_OTHER}`);
