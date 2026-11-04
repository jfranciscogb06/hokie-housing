# Launch checks — November 3, 2026

Preview: https://blacksburg-housing.onrender.com

## Catalog and images

- Re-fetched the detail record for all 453 nearby listings from the source portal.
- Compared with the prior catalog: 163 added, 138 removed, 27 price changes.
- Verified the browser and server catalogs match, IDs are unique, coordinates and
  rent values are valid, and split floor-plan prices match whole-unit totals.
- Checked all 2,764 distinct gallery, bedroom-group and floor-plan image URLs in
  the refreshed catalog: all returned successful image responses at check time.
- Ten listings have no photos supplied by the source. Cards show "No photos provided";
  no unrelated pictures were substituted.
- Retained 1,755 original-source URL fallbacks for transformed image URLs.
  The older catalog contained enlarged URLs that returned 404 while originals worked.
- All 13 leasing email directory entries were found on their cited websites. This is
  source confirmation, not an inbox or delivery test. 200 listings map to emails;
  430 have phone numbers, and every listing retains its source link.

Prices, availability, eligibility and photo relevance remain source claims rather
than independent property inspections. Image availability can change later.

## Application checks

- 44 automated tests pass, including same-floor-plan budgets, contact history
  migration, malformed request handling, storage consistency, selected plan images,
  protected files and public configuration.
- Chrome browser flows pass at 1440 × 1000, 390 × 844 and 320 × 740, locally and hosted:
  search, filters and Escape, four-bedroom selection, gallery arrows and thumbnails,
  keyboard focus containment, saving, Gmail compose links and contact history.
- No JavaScript page errors in those flows. No horizontal overflow was found in
  home, search and property views at those widths. This is not a real-device Safari test.
- Gmail opens a prefilled compose link. Browser checks intercepted compose navigation;
  no message was sent, and the application cannot confirm delivery.
- Hosted `/healthz`, home, Privacy, Terms, configuration and catalog assets return 200.
  `.env` and raw scraper caches return 404. The legacy mail endpoint returns 410.
- No application error logs were returned immediately after the first live deployment.

## Deployment and remaining owner setup

- Node 22 service on Render, built from the GitHub repository. The build runs tests
  and catalog validation. The web service runs no scraper or recurring refresh job.
- Free preview compute: idle spin-down and temporary sponsorship counters. Attach
  persistent storage before relying on paid-campaign metrics.
- Built-in search is active; optional model-backed interpretation needs a server API key.
- Owner will create and supply `SUPPORT_EMAIL`; the server publishes only that validated
  public address through `/site-config.js`. No mailbox was created.
- Custom domain and DNS are unchanged. The proposed Hokie domain is not cleared by
  VT's published URL policy. Final domain selection/ownership and DNS access remain open.
- Listing-content permissions remain unresolved; technical checks do not grant rights.
