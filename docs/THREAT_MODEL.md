# Threat model

## Assets

- **Link integrity.** A short link must always lead where its creator intended.
- **Availability** of redirects.
- **API keys** that authorize link creation.
- **The infrastructure itself:** WrapLink must not become a tool for reaching internal systems.

## Trust boundaries

Internet clients → (optional load balancer) → Node.js API / C++ redirect service → Redis and PostgreSQL on a private network.

## Threats and mitigations

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| Unauthorized link creation | API keys stored only as SHA-256 hashes and compared in constant time (`HashedApiKeyAuthenticator`) | Leaked keys work until removed from `CREATE_API_KEYS` |
| Credential guessing and creation floods | Redis rate limit per client IP, applied before authentication. Fails closed (503) when Redis is down | Distributed attackers with many IPs; add an edge WAF |
| SSRF and internal network mapping via destinations | `SafeUrlPolicy` allows only http(s), rejects credentials in URLs and local hostnames, resolves DNS and rejects private, loopback, link-local, CGNAT, multicast and IPv4-mapped addresses | DNS rebinding after creation. WrapLink never fetches destinations, so the impact is limited to the user's browser |
| Phishing and malware destinations | Out of scope for the core service | Add reputation checks (for example Safe Browsing) at creation time |
| Code enumeration | Random codes; write-behind codes are a keyed Feistel permutation of a counter | Anyone with `CODE_SCRAMBLE_SECRET` can enumerate write-behind codes. Treat it as a secret |
| Link hijacking via a code collision | PostgreSQL primary key. Write-behind codes are unique by construction; custom aliases are refused while a pending code exists; residual collisions are detected at sync, PostgreSQL wins and the record is dead-lettered | — |
| Spoofed client IP | `X-Forwarded-For` is ignored unless `TRUST_PROXY=true` | Misconfiguration behind an untrusted proxy |
| Header and log injection | Request IDs accepted only if they match `[A-Za-z0-9._:-]{1,128}`; Prometheus labels escaped | — |
| Clickjacking and content sniffing on API responses | `Content-Security-Policy: default-src 'none'`, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer` | — |
| Oversized requests | 16 KB body limit, 10 s request timeout, URL length ≤ 2,048 | Slowloris-style attacks need edge protection |
| Redis or PostgreSQL exposed to the internet | Compose binds them for local development only | Production must restrict them to a private network, with passwords and TLS |
| Data loss in write-behind mode | AOF, replicas, bounded backlog, at-least-once idempotent sync | Simultaneous loss of a Redis master and its replica before sync |
| Poisoned queue records | Strict parsing; invalid records are dead-lettered | — |
| Malicious IPC between cluster workers | Every metrics message is validated before aggregation | Workers share a trust domain by design |

## Out of scope

User accounts, link ownership and editing, abuse reporting, and destination scanning. These are the next security milestones for a public deployment.
