# Shopify Store Cloner

Node.js 20+, zero runtime dependencies beyond Express — the built-in `fetch` is used directly. The Admin API version is set once in `server.js` (`API_VERSION`); review it every quarter, since Shopify supports each version for about 12 months and silently serves a newer one after that.

Node.js 20+. Start with `npm start`; run the local tests with `node --test`.

## Markets and shipping planner

Fill in **Destination Store** credentials, then open **Markets** or **Fretes**. The source store is not used by these tabs.

1. Select a region, the whole world, or individual countries. The 50 excluded countries are enforced by the server as well as the interface. Existing configurations in excluded countries are not deleted.
2. Generate a preview. Markets reads **that destination's published locales**, every time, and picks the language **automatically**: the country's own language when it is published in that store, otherwise English. Portuguese from Portugal is never silently replaced with Brazilian Portuguese — a mismatch falls back to English and says so in the preview. Nothing has to be selected by hand; a per-country override is still available in the table. English must itself be published: if it is not, the preview blocks and asks you to publish it. The tool does not create translations or publish languages.
3. Markets creates or updates an individual country market with Shopify's automatic local currencies. Country currency labels and language defaults are suggestions, not a guarantee of payment-provider availability. Shopify restrictions and plan limits are reported per country. Language defaults use Node's ICU likely-subtag data and can be overridden; they are not a demographic survey of multilingual countries.
4. A dedicated country subfolder (such as `/en-pt`) assigns the reviewed primary locale and English. Existing shared web presences are not modified. A country subfolder with conflicting locales must be reviewed in Shopify before association.
5. Fretes uses €4.90 standard and €7.90 express by default. Preview obtains the exchange rate to the **store currency** from Frankfurter; unsupported currencies or network failures require a manual rate. The rate and date are shown and held for the reviewed operation. JPY and other currencies use their currency precision. Carrier names are editable labels, not carrier contracts or calculated shipping integrations. Unknown carriers use generic Standard/Express Shipping labels.
6. Select the shipping profile and fulfillment location group. Existing individual zones and same-name rates are updated. Unrelated rates are preserved. Grouped zones and Rest of World coverage are flagged for manual separation before a country-specific change, rather than rewriting their other countries.
7. Review and apply. The server reads the destination again, validates errors, prevents simultaneous planner runs for one shop in this process, and reports success/failure per country. A disconnected run may have applied earlier countries: generate a new preview before repeating.

Preview IDs expire in 15 minutes and are held in memory; use one app instance. A deployment/restart invalidates pending previews. No destination credentials or access tokens are stored in preview records. Requests still require the destination credentials already used by the app.

Required app access: `read_markets`, `write_markets`, `read_locales`, `read_shipping`, `write_shipping`, and `read_locations` as applicable. The planner uses Admin GraphQL **2026-07**. Legacy cloning remains separate; this change fixes its frontend route mismatch, applies country exclusions to its country lists, and honors the shipping-price fields with current/manual-safe conversion instead of fixed historical exchange rates.

## Validation

`node --test` covers exclusions, different destination locales, unpublished locales, Portuguese variants, automatic English fallback, currency precision, market pagination, read-only previews, grouped zones, reuse of existing rates/web presences, and HTTP apply error/replay handling. These tests use simulated Shopify responses. Real-store credentials were not supplied for live Shopify writes. Browser rendering was not verified because Chromium is not installed in the development environment.

API references:
- https://shopify.dev/docs/api/admin-graphql/latest/input-objects/MarketCreateInput
- https://shopify.dev/docs/api/admin-graphql/latest/input-objects/MarketUpdateInput
- https://shopify.dev/docs/api/admin-graphql/latest/mutations/webPresenceCreate
- https://shopify.dev/docs/api/admin-graphql/latest/input-objects/DeliveryProfileInput
