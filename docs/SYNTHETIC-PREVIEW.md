# Optional disposable synthetic preview

The original source archive included a temporary test-preview mode. It remains available as an explicit JavaScript launcher backed by an isolated MongoDB database. The normal `npm start` command starts the persistent workspace; the optional preview command below starts a new disposable workspace on each run.

## Configure and start

Use a **dedicated test MongoDB replica set/account** and fill these inputs in `.example.env` or the process environment:

| Input                       | Value                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| `IV_PREVIEW_MODE`           | `disposable-synthetic`                                                                                  |
| `IV_PREVIEW_MONGODB_URI`    | URI of the dedicated test replica set. Its account must create and drop the generated preview database. |
| `IV_PREVIEW_ADMIN_EMAIL`    | An address for the temporary preview administrator.                                                     |
| `IV_PREVIEW_ADMIN_NAME`     | Optional display name.                                                                                  |
| `IV_PREVIEW_ADMIN_PASSWORD` | A temporary password of at least 12 characters.                                                         |
| `NODE_ENV`                  | `production`                                                                                            |
| `PUBLIC_APP_URL`            | Exact HTTPS origin of the preview host.                                                                 |
| `HOST` / `PORT`             | Hosting listener settings.                                                                              |

```bash
npm run start:synthetic-preview
```

The original preview's HTTPS and login requirements are retained. For local development without an HTTPS reverse proxy, use the normal application with a disposable database of your own and invented data; do not disable production secure-cookie rules just to expose this hosted preview over plain HTTP.

The launcher reads only the dedicated preview database/admin inputs for those purposes. It does not use the normal `MONGODB_URI`, `MONGODB_DATABASE`, first-owner credentials or merchant/email/GST credentials. A generated database name and per-run ownership marker prevent a caller from selecting an existing workspace as a deletion target.

## Behavior retained

- Organization names, legal identities, document prefixes, terms and workspace branding are clearly marked as synthetic test data.
- Public and workspace EJS pages display a **TEMPORARY SYNTHETIC PREVIEW** notice.
- Login, organization/contact/catalog/format/document workflows and manual test receipts remain available in the isolated workspace.
- Gateway creation/sync, signed-webhook processing, outgoing email, password-reset delivery and GST lookup are blocked. No mail worker or automatic backup scheduler starts.
- Restrictive response headers/CSP block external browser connections and images in preview. Provider adapters receive a fetch implementation that refuses requests.
- `/api/deployment-mode` returns the original disposable/integrations-disabled metadata. `/api/health` includes preview flags.
- Clean shutdown removes only that run's owned preview database. An abrupt process kill may leave a marked preview database for an operator to inspect and remove; it is never silently reused on the next startup.

Manual backups can contain only this run's synthetic data. Do not enter real customer details, merchant credentials or real payment receipts into a disposable preview.

## Separate preview archive

```bash
npm run package:synthetic-preview
```

This creates a separate ZIP/tar package in `release/` with `npm start` selecting the preview launcher. It does not change the normal project's start command. As with normal packaging, the `.example.env` template must be blank of private/hosting values; configure the dedicated preview inputs on the destination host.

`npm run start:hostinger` also recognizes an explicit `IV_PREVIEW_MODE=disposable-synthetic` and selects this launcher. Unknown mode values are refused.
