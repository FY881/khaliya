# المساهمة · Contributing

خلية مشروع خاص بمالكه وقيد التطوير؛ الكود معروض للاطلاع (جميع الحقوق محفوظة). نرحّب بالبلاغات والأفكار عبر Issues.
Khaliya is an owner-run project in development; the source is published for viewing (all rights reserved). Bug reports and ideas via Issues are welcome.

## قواعد أساسية · Ground rules
1. **لا أسرار أبدًا** في الكود أو اللقطات أو الـIssues · **Never commit secrets** in code, screenshots or issues.
2. الدستور (`apps/api/src/constitution.ts`) والحاكم والتدقيق والدخول **خارج نطاق التطوّر** ولا تتغير إلا بموافقة المالك.
   The constitution, Governor, audit and auth are **never evolvable** and change only with owner sign-off.
3. كل فعل خارجي (T3/T4) يمرّ بطابور الموافقات · Every external action (T3/T4) goes through the approval queue.
4. عربي أولًا: كل نص في الواجهة له نسخة عربية وإنجليزية · Arabic-first: every UI string ships in Arabic and English.

## قبل فتح PR · Before a PR
```bash
cd apps/api && npm ci && node ../../scripts/embed-console.mjs
npm run typecheck && npm test
```
