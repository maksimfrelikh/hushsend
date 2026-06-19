import * as QRCode from 'qrcode';

/**
 * Render a link as a self-contained SVG QR code (string). The QR encodes EXACTLY the link URL
 * (`<origin>/#<roomCode>.<S>`); a scanner reads the same string back, which `parseLink` turns into
 * { roomCode, secret } — see the round-trip unit test. Dark-on-light with a quiet-zone margin so it
 * scans reliably regardless of the app theme (the caller places it on a light card). Generation is
 * fully local — nothing about the QR (or the secret it carries) ever reaches the server.
 */
export async function linkToQrSvg(url: string): Promise<string> {
  return QRCode.toString(url, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 2,
    color: { dark: '#000000ff', light: '#ffffffff' },
  });
}
