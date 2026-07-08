# Auth Module

This module provides first-party PostgreSQL-backed authentication.

Required environment variables:

```text
DATABASE_URL=postgres://admin:root@localhost:5432/aistudio
AUTH_SESSION_SECRET=<long random secret>
AUTH_ENCRYPTION_KEY=<base64 encoded 32 byte key>
```

Generate an encryption key with:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

The public auth endpoints return safe user objects only. They do not return
password hashes, encrypted key fields, or plaintext Replicate API keys.
