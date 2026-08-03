# Egress Filtering: Port Restrictions vs Domain Allowlist

## TL;DR

**Domain allowlist is the primary security control. Port restrictions are defense-in-depth.**

## Why Squid Restricts CONNECT to Ports 80/443

The HTTP `CONNECT` method creates a blind TCP tunnel. From [Squid's official documentation](https://wiki.squid-cache.org/Features/HTTPS):

> "It is important to notice that the protocols passed through CONNECT are not limited to the ones Squid normally handles. Quite literally **anything that uses a two-way TCP connection** can be passed through a CONNECT tunnel."

This is why Squid's default ACL starts with `deny CONNECT !SSL_Ports`.

## The Case Against Port Restrictions (Counter-Arguments)

**Industry consensus: Port-based filtering is increasingly obsolete.**

From [Palo Alto Networks](https://www.paloaltonetworks.co.uk/cyberpedia/what-is-a-next-generation-firewall-ngfw): "Developers began tunneling application traffic through common ports like 80 and 443 to bypass restrictive firewalls. This rendered port-based filtering largely ineffective."

Bypass techniques are well-documented:
- **SSH over 443**: Run `sshd -p 443`, tunnel anything ([documented extensively](https://blog.frost.kiwi/ssh-over-https-tunneling/))
- **SSLH multiplexing**: Same port serves SSH and HTTPS based on protocol detection
- **HTTP tunneling tools**: chisel, wstunnel, cloudflared work over "allowed" ports

Even [Nmap's reference-guide source](https://github.com/nmap/nmap/blob/d5645bf76da55c056082a99593de1b5ef645bfa8/docs/refguide.xml#L3394-L3401) notes historical firewall flaws—Zone Alarm allowed any UDP from port 53, Windows IPsec filters allowed all traffic from port 88.

## Why Port Restrictions Still Matter (Supporting Arguments)

**1. Squid's official security guidance** ([SecurityPitfalls](https://wiki.squid-cache.org/SquidFaq/SecurityPitfalls)):
> "Safe_Ports prevents people from making requests to any of the registered protocol ports. SSL_Ports along with the CONNECT ACL prevents anyone from making an unfiltered tunnel to any of the otherwise safe ports."

**2. CMU SEI recommends port-based egress filtering** ([Best Practices](https://www.sei.cmu.edu/blog/best-practices-and-considerations-in-egress-filtering/)):
- Block SMB (445)—would have limited WannaCry spread
- Restrict DNS (53)—prevents participation in DDoS like 2016 Dyn attack
- Block IRC (6660-6669)—common C2 channel

**3. Defense-in-depth principle**: Forces attackers to use sophisticated techniques rather than obvious ports.

## The Real Security: Domain Allowlist

Port restrictions fail when attackers control infrastructure on port 443. Domain allowlists don't:

```
CONNECT attacker.com:443
  → Port 443? ✓
  → Domain in allowlist? ✗ DENIED
```

**Even this has limits.** [DNS tunneling](https://www.paloaltonetworks.com/cyberpedia/what-is-dns-tunneling) can exfiltrate data through allowed DNS servers by encoding data in queries. Mitigation requires DNS traffic analysis, not just filtering.

## Security Layers Compared

| Layer | What It Blocks | Bypass Method |
|-------|----------------|---------------|
| Port restriction | SSH:22, SMTP:25, DB:3306 | Run service on 443 |
| Domain allowlist | Non-whitelisted domains | Compromise allowed domain, DNS tunneling |
| SSL Bump/DPI | Malicious content on allowed domains | Performance cost, cert complexity |

## Conclusion

Port restrictions are **not security theater, but not primary security either**. They:
- Block opportunistic attacks using standard ports
- Increase attacker effort and sophistication required
- Align with [NIST SP 800-41](https://nvlpubs.nist.gov/nistpubs/legacy/sp/nistspecialpublication800-41r1.pdf) egress filtering guidance

**AWF's security relies on the domain allowlist.** Keep it minimal. Port restrictions are a useful secondary layer but won't stop a determined attacker with infrastructure on port 443.
