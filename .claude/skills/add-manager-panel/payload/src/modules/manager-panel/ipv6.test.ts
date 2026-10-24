import { describe, expect, it } from 'vitest';

import { ipv6Groups, mappedIpv4 } from './ipv6.js';
import { clientKey } from './sessions.js';

describe('ipv6Groups', () => {
  it('expands the short forms and drops the zone', () => {
    expect(ipv6Groups('fe80::1%eth0')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(ipv6Groups('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(ipv6Groups('::ffff:192.0.2.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0xc000, 0x0201]);
  });

  it('refuses groups that are not one to four hex digits, and wrong group counts', () => {
    expect(ipv6Groups('2001:db8::1g')).toBeNull();
    expect(ipv6Groups('2001:db8::12345')).toBeNull();
    expect(ipv6Groups('1:2:3:4:5:6:7')).toBeNull();
    expect(ipv6Groups('1::2::3')).toBeNull();
    expect(ipv6Groups('::ffff:192.0.2.256')).toBeNull();
  });
});

describe('mappedIpv4', () => {
  it('reads the IPv4 address however the mapped form is spelled', () => {
    expect(mappedIpv4(ipv6Groups('::ffff:192.0.2.1')!)).toBe('192.0.2.1');
    expect(mappedIpv4(ipv6Groups('::ffff:c000:201')!)).toBe('192.0.2.1');
    expect(mappedIpv4(ipv6Groups('2001:db8::1')!)).toBeNull();
  });
});

describe('clientKey', () => {
  it('groups IPv6 clients by /64 and keeps IPv4 as it is', () => {
    expect(clientKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(clientKey('::ffff:c000:201')).toBe('192.0.2.1');
    expect(clientKey('192.0.2.7')).toBe('192.0.2.7');
    expect(clientKey(undefined)).toBe('unknown');
  });
});
