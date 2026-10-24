/** IPv6 text to its eight 16-bit groups, shared by the login throttle and the endpoint checks. */

/** The eight groups of an IPv6 address (zone dropped, embedded dotted IPv4 accepted), or null if it is not one. */
export function ipv6Groups(address: string): number[] | null {
  let text = address.split('%')[0].toLowerCase();
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted) {
    const octets = dotted[2].split('.').map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    text = `${dotted[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] =>
    part === '' ? [] : part.split(':').map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN));
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const groups = [...head, ...new Array<number>(halves.length === 2 ? fill : 0).fill(0), ...tail];
  return groups.every((group) => !Number.isNaN(group)) ? groups : null;
}

/** The IPv4 address an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`, however it is spelled) carries, or null. */
export function mappedIpv4(groups: number[]): string | null {
  if (!groups.slice(0, 5).every((group) => group === 0) || groups[5] !== 0xffff) return null;
  return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join('.');
}
