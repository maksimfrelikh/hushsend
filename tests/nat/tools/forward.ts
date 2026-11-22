/**
 * A TCP port-forward for a client namespace:   node forward.ts <port>=<host>:<port> …
 *
 * Each pair listens on 127.0.0.1:<port> and pipes to the target. The browser in that namespace
 * then loads the app from `http://localhost:5173` — a secure context, and the one origin the
 * development signaling server allows — while the bytes really cross the namespace's NAT to the
 * lab's public address. Only the page and the signaling WebSocket go through here; STUN, TURN and
 * the peer-to-peer traffic use the real addresses.
 */
import net from 'node:net';

const pairs = process.argv.slice(2);
if (pairs.length === 0) {
  console.error('usage: node forward.ts <port>=<host>:<port> …');
  process.exit(2);
}

for (const pair of pairs) {
  const [listen, target] = pair.split('=');
  const [host, port] = (target ?? '').split(':');
  if (!listen || !host || !port) {
    console.error(`forward: bad pair '${pair}'`);
    process.exit(2);
  }
  net
    .createServer((client) => {
      const upstream = net.connect(Number(port), host);
      client.pipe(upstream).pipe(client);
      const drop = (): void => {
        client.destroy();
        upstream.destroy();
      };
      client.on('error', drop);
      upstream.on('error', drop);
    })
    .listen(Number(listen), '127.0.0.1', () => console.log(`forward: 127.0.0.1:${listen} → ${target}`));
}
