/**
 * FiveM's RCON is the classic Quake3/GoldSrc-style out-of-band UDP protocol (the same one
 * icecon [https://github.com/icedream/icecon] uses via its go-q3net dependency), NOT the
 * Valve Source-engine TCP RCON protocol. Wire format, derived from go-q3net's message.go:
 *
 *   request:  \xFF\xFF\xFF\xFF + "rcon" + 0x20 + "<password> <command>" + 0x00
 *   response: \xFF\xFF\xFF\xFF + "print" + 0x20 + "<output>" + (0x00 padding, trimmed)
 *
 * There is no separate auth handshake and no request/response IDs - every packet carries the
 * password inline, and a wrong password gets you back a "print" response saying so.
 */

const OOB_HEADER = Buffer.from([0xff, 0xff, 0xff, 0xff]);

export function encodeRconRequest(password: string, command: string): Buffer {
  const data = Buffer.from(`${password} ${command}`, 'utf8');
  return Buffer.concat([OOB_HEADER, Buffer.from('rcon', 'ascii'), Buffer.from([0x20]), data, Buffer.from([0x00])]);
}

export interface DecodedRconMessage {
  name: string;
  data: string;
}

const SEPARATORS = new Set([0x20, 0x0a, 0x0d, 0x09, 0x00, 0x5c]); // space, \n, \r, \t, NUL, backslash

export function decodeRconMessage(buf: Buffer): DecodedRconMessage | undefined {
  if (buf.length < 4) return undefined;
  if (!buf.subarray(0, 4).equals(OOB_HEADER)) return undefined; // not an out-of-band packet

  const rest = buf.subarray(4);
  let splitPos = rest.length;
  for (let i = 0; i < rest.length; i++) {
    if (SEPARATORS.has(rest[i])) {
      splitPos = i;
      break;
    }
  }

  const name = rest.subarray(0, splitPos).toString('ascii');
  let extra = splitPos < rest.length ? rest.subarray(splitPos + 1) : Buffer.alloc(0);
  let end = extra.length;
  while (end > 0 && extra[end - 1] === 0x00) end--; // strip trailing NUL padding
  extra = extra.subarray(0, end);

  return { name, data: extra.toString('utf8') };
}
