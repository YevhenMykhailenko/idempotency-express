# Security reporting

Do not disclose an unfixed vulnerability, credentials, private response bodies or exploit details in a public issue or pull request.

If private vulnerability reporting is enabled for this repository, use GitHub's [Report a vulnerability](https://github.com/YevhenMykhailenko/idempotency-express/security/advisories/new) flow. Availability of that private channel is controlled by repository settings and is not asserted by this document. If it is unavailable, use a **verified private contact published by the maintainer** to request a secure channel before sharing sensitive details. Do not guess an email address or put exploit details in a public fallback issue. No response-time SLA is promised.

Include the package/Node/Express/Store versions, minimal private reproduction, relevant configuration/order of middleware, concurrency/TTL assumptions and the impact. Redact tokens, signatures, cookies, keys, identity information, URLs with credentials and business payloads. Do not probe systems you do not own or have permission to test.

## Version and platform scope

This document describes the **3.0** API and its security boundaries. Local preparation and development test results do not establish that a fix is available in a published version or extend support commitments for older majors. Reports must identify the exact affected version. Maintainers must verify the private-reporting channel described above before publication.

Node 18+ compatibility is retained by explicit project decision. Node 18 and 20 are upstream EOL (2025-04-30 and 2026-04-30 respectively; [official release schedule](https://github.com/nodejs/Release#release-schedule)); this library cannot supply missing Node security patches. Prefer a currently maintained Node release for production. Driver/framework vulnerabilities and their own runtime requirements also need independent assessment.

Middleware does not implement authentication/authorization, encrypt/redact stored bodies, make external effects transactional, or guarantee exactly-once execution after TTL/Store loss. Authentication, authorization and webhook verification must precede replay. See [guarantees](docs/guarantees.md) and [migration](docs/migration.md).

The targeted development dependency remediation completed on 2026-11-19 with zero findings in the local full `npm audit`; the full audit remains a blocking release gate, not a permanent security guarantee. A passing functional suite is not a security audit, and this root audit does not assess an application's Express peer, Store driver or other dependencies. This file does not publish any private historical report or authorize a package/advisory release.
