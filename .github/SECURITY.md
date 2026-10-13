# الأمان · Security

## الإبلاغ عن ثغرة · Reporting a vulnerability

**لا تفتح Issue علنيًا.** استخدم [الإبلاغ الخاص عبر GitHub](https://github.com/FY881/khaliya/security/advisories/new).
سنرد خلال 72 ساعة قدر الإمكان.

**Please do not open a public issue.** Use [GitHub private vulnerability reporting](https://github.com/FY881/khaliya/security/advisories/new).
We aim to respond within 72 hours.

## النطاق · Scope

خلية مشروع قيد التطوير وغير متاح للعامة. لوحة التحكم للمالك فقط.
Khaliya is in development and not publicly available; the console is owner-only.

In scope: this repository's code — owner auth (TOTP, session cookie, lockout, replay guard), the Tool Gateway and approval queue,
the Governor and kill switches, the QuickJS sandbox, capability tokens / passports, and the audit chain.

Out of scope: denial-of-service against free-tier quotas, social engineering, and any testing against deployed infrastructure
without written permission.

## تصميم الأسرار · How secrets are handled

- `OWNER_TOTP_SECRET`, `SESSION_SECRET`, `GEMINI_KEY`, `OPENROUTER_KEY` and signing keys live only as Cloudflare Worker secrets
  (or a local, git-ignored `apps/api/.dev.vars`). They are never committed or shown in the console.
- The values in `apps/api/vitest.config.ts` are well-known **test-only** fixtures used inside the local Miniflare runtime.
- T4 actions (external write, spend, publish) require owner approval plus a fresh TOTP code.
