# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report privately through GitHub's
[private vulnerability reporting](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
(Security → Report a vulnerability) on this repository. Include the affected endpoint or component,
reproduction steps, and the impact you believe it has.

This is a personal Master's thesis project maintained on a best-effort basis. Expect an
acknowledgement within a few days; there is no formal SLA and no bug bounty.

## Scope

In scope: the source in this repository — authentication and authorization, input validation,
Firestore security rules, rate limiting, CORS and header configuration, and dependency issues that
are actually reachable from this code.

Out of scope: findings against the live deployment that amount to volumetric denial of service,
issues in Firebase/Google Cloud themselves, and reports consisting only of automated scanner output
with no demonstrated impact.

## What is not a secret

The Firebase browser configuration (web API key, auth domain, sender ID, app ID) and the FCM VAPID
key are public values by design: they identify the project, they do not grant access. Access is
enforced by Firebase Authentication, Firestore security rules and server-side ID-token verification.
Please do not report these as leaked credentials.
