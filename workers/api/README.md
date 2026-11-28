# thehumanbox-api

The super backend — one Cloudflare Worker over KV + D1 + Workers AI + a daily
Cron Trigger, all free tier. Full documentation: [`docs/SUPER_BACKEND.md`](../../docs/SUPER_BACKEND.md).

```bash
npx wrangler dev      # local dev
npx wrangler deploy   # deploy (CI does this on every push to main)
npx wrangler tail     # live logs
```

Live at https://thehumanbox-api.yeyilin2010.workers.dev — the root path is a
landing page with a live tester for every endpoint.
