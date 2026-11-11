# Architecture

`src/auth/verify.ts` owns token validation. `src/transport/client.ts` retries
only transport failures. Validation failures must never enter the retry loop.
