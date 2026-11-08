# Labbit deployment and branding

## Public identity

- Product: **Labbit** — a simulation-first lab for robot decisions.
- Canonical website: **https://labbit.science**.
- Dataset: https://huggingface.co/datasets/MedSalim/labbit-robotic-manipulation.
- App icon: [`public/labbit.svg`](../public/labbit.svg); README logo: [`docs/media/labbit-logo.svg`](media/labbit-logo.svg).

Use `labbit.science` in public links, dataset documentation, download examples and social metadata. The app's canonical/Open Graph URLs are declared in `index.html`. Local development continues to use localhost.

## Cloudflare custom domain

`wrangler.jsonc` maps `labbit.science` to the existing Worker with `custom_domain: true`. The domain must have an active Cloudflare zone in the configured account; Wrangler configures the custom-domain DNS record and Cloudflare manages its TLS certificate. Resolve any conflicting DNS record before deployment.

Keep the Worker name `hand-studio`, R2 bucket `hand-studio-trajectories`, `DATA` binding, coordinator binding and migrations unchanged. These are infrastructure identifiers, not public branding. Renaming them would risk disconnecting existing secrets, datasets and Durable Object state. `workers_dev: true` keeps the original Worker address available for compatibility; no redirect or data migration is introduced.

Follow the [README deployment commands](../README.md#deploy-with-wrangler-and-r2), with the Python environment activated. Skip bucket creation and secret setup if the existing deployment is already configured. Never commit `.env`, `.deploy.env`, `.dev.vars` or provider/admin keys.

## Verify the deployment

After `npm run deploy`, check the public page and an existing dataset without triggering generation or paid AI requests:

```sh
curl --fail --location https://labbit.science/ --output /dev/null
curl --fail --location https://labbit.science/datasets/7c850e6a-ff7f-4a42-9c12-375c2e28549b/manifest.json
```

Open the lab in a browser, confirm the Labbit title/favicon, and replay a published recording in Single and Grid. Static assets, `/api/*` and `/datasets/*` use the same origin; the existing Worker routing and authorization rules still apply. If DNS or TLS is not ready, check the zone and Worker custom-domain status in Cloudflare before retrying.

The development recording proxy, preview renderer, dataset packager and Muse CLI default to `https://labbit.science`. The proxy and preview/Muse scripts retain their existing explicit endpoint overrides. Running the Muse CLI is a paid action and still requires a separately authorized campaign and spending cap.
