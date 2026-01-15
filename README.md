# Canonical Attribution Resolver

A minimal code sample that demonstrates how I design and develop an template-style attribution logic (similar to a GTM Variable Templates), inspired by real-world enterprise tracking scenarios that i already found.
This repository is intentionally small and self-contained: pure functions only (no external access like endpoints, URLS or external objects), explicit inputs/outputs, and predictable resolution rules.
This example is inspired by attribution logic originally implemented in client-side GTM tags for specific business use cases, later reconstructed here as a generic, reusable, template-style module.

## What problem does this solve?
In real tracking implementations, attribution signals can be inconsistent or conflicting across:
- Click IDs (e.g., `gclid`, `gbraid`, `wbraid`)
- UTM parameters (`utm_*`)
- Referrer data

This module:
1. Extracts attribution signals from `page_location`
2. Normalizes values (removes empty / `null` / `undefined` / `(not set)`)
3. Resolves precedence deterministically
4. Returns:
   - A canonical attribution object
   - A sanitized ("clean") URL with removable parameters stripped

## Key characteristics (template-oriented)

- Deterministic output: the same input always produces the same output
- Explicit precedence rules
- Pure functions: no external state or side-effects
- Small, readable helpers (single responsibility)
- Defensive normalization and edge-case handling

## Attribution precedence

Strongest → weakest (default):

1. `gclid`
2. `gbraid` / `wbraid`
3. `utm_*`
4. `referrer`
5. `direct`

Notes:
- If `gclid` is present, it wins even if UTMs exist.
- If `gbraid`/`wbraid` is present, it wins over UTMs.
- UTMs fall back to `unknown` when partially present (e.g., missing `utm_medium`).
- Referrer is ignored when it matches configured `selfReferralHosts`.

## Consent behavior

If `consent.adStorageGranted` is `false`, the resolver removes ad identifiers (click IDs) from the signals, returning an empty click ID object. This is a conservative, privacy-aligned default.

You can override consent via options.

## Clean URL behavior

By default, the resolver removes:

- `utm_*`
- click IDs (`gclid`, `gbraid`, `wbraid`, etc.)

If you want to keep click IDs in the output URL, set:

```js
{
  keepClickIdsInCleanUrl: true
}
```

## Usage
The file includes runnable examples. 
Run:
```bash
node canonical_attribution_resolver.js
```

### Example of programmatic usage
```js
const { resolveAttribution } = require("./attributionResolver");

const result = resolveAttribution({
  page_location:
    "https://example.com/?gclid=AAA&utm_source=facebook&utm_medium=paid_social&utm_campaign=summer",
  page_referrer: "https://google.com/"
});

console.log(result.attribution);
console.log(result.cleaned_url);
```

### Input format
```js
resolveAttribution(
  {
    page_location: "https://example.com/landing?utm_source=...&utm_medium=...",
    page_referrer: "https://referrer.example/"
  },
  options
);

//Required fields
page_location (string URL)

//Optional
page_referrer (string URL)
```

### Output format expected
```js
{
  version: "1.0.0",
  input: { page_location, page_referrer },
  signals: { click_ids, utm },
  attribution: {
    channel,
    source,
    medium,
    campaign,
    content,
    term,
    click_id,
    touch_type,
    reason
  },
  cleaned_url
}
```

## Examples (input to output)
### 1) gclid wins over UTMs

#### Input:

https://example.com/product?gclid=AAA111&utm_source=facebook&utm_medium=paid_social&utm_campaign=summer


#### Result:
```js
{
  channel: "paid",
  source: "google",
  medium: "cpc",
  campaign: "summer",
  click_id: { type: "gclid", value: "AAA111" },
  reason: "gclid_present"
}
```

### 2) UTMs only
#### Input:
https://example.com/?utm_source=newsletter&utm_medium=email&utm_campaign=jan


#### Result:
```js
{
  channel: "email",
  source: "newsletter",
  medium: "email",
  campaign: "jan",
  reason: "utm_present"
}
```

### 3) No signals -> direct

#### Input:
https://example.com/


#### Result:
```js
{
  channel: "direct",
  source: "(direct)",
  medium: "(none)",
  reason: "no_signals"
}
```
