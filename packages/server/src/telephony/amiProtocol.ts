/**
 * AMI wire format: packets are `Key: Value` lines separated by CRLF and
 * terminated by a blank line. Keys may repeat (e.g. Variable, Output), so a
 * parsed packet maps each lower-cased key to the list of its values.
 * Kept dependency-free and exported for unit tests with recorded packets.
 */

export type AmiFields = Map<string, string[]>;

export function amiField(message: AmiFields, name: string): string | undefined {
  return message.get(name.toLowerCase())?.[0];
}

export function parseAmiPacket(raw: string): AmiFields {
  const fields: AmiFields = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    fields.set(key, [...(fields.get(key) ?? []), value]);
  }
  return fields;
}

function safeValue(value: string): string {
  if (/\r|\n/.test(value)) throw new Error('Invalid AMI value (contains a line break)');
  return value;
}

/** Serialize one AMI action. Values may be arrays for repeated keys (Variable…). */
export function serializeAmiAction(fields: Record<string, string | string[]>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    for (const v of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${safeValue(v)}`);
  }
  return lines.join('\r\n') + '\r\n\r\n';
}

/**
 * Split a stream buffer into complete packets. Returns the packets and the
 * unconsumed remainder. The Asterisk greeting ("Asterisk Call Manager/x.y")
 * is a single line, not a packet – it is stripped when seen at the head.
 */
export function splitAmiStream(buffer: string): { packets: string[]; rest: string } {
  let buf = buffer;
  if (buf.startsWith('Asterisk Call Manager/')) {
    const nl = buf.indexOf('\n');
    if (nl < 0) return { packets: [], rest: buf };
    buf = buf.slice(nl + 1);
  }
  const packets: string[] = [];
  for (;;) {
    const crlf = buf.indexOf('\r\n\r\n');
    const lf = buf.indexOf('\n\n');
    const end = crlf < 0 ? lf : lf < 0 ? crlf : Math.min(crlf, lf);
    if (end < 0) break;
    const delim = end === crlf ? 4 : 2;
    const raw = buf.slice(0, end);
    buf = buf.slice(end + delim);
    if (raw.trim()) packets.push(raw);
  }
  return { packets, rest: buf };
}
