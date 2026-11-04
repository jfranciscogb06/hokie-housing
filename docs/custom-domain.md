# Custom domain: BlacksburgHousingAll.com

Status on November 3, 2026: not purchased or connected. A registry lookup returned
no registration. Porkbun's live search listed a one-year registration and renewal
at $11.81 USD each. Availability and prices can change before checkout.

Search/register: https://porkbun.com/checkout/search?q=blacksburghousingall.com

Buy the domain only, without another website-hosting package. The site remains on
Render. Registration requires the owner's registrar account and checkout details.

## After registration

1. Open the existing Render service, then Settings > Custom Domains:
   https://dashboard.render.com/web/srv-dbl93rm417fc73frd2e0
2. Add `blacksburghousingall.com`. Render also adds `www` and redirects it to the root.
3. In Porkbun's DNS management, configure the following records. Leave the root Host
   field blank on Porkbun (other providers commonly display it as `@`).

| Type | Host | Target |
| --- | --- | --- |
| ALIAS | blank (root) | blacksburg-housing.onrender.com |
| CNAME | www | blacksburg-housing.onrender.com |

Use the registrar's default TTL. Replace only conflicting website/parking records
at the root or `www`; remove conflicting AAAA records for these hosts. Preserve
email-related MX and TXT records while the owners set up their support email.

4. Return to Render and verify the domain. Wait for DNS propagation and certificate
   issuance. Verify HTTPS on both the root and `www`, then repeat the hosted search,
   gallery, save and Gmail-draft checks using the new address.
5. Keep the working Render URL enabled until the custom domain is verified.

These are prepared instructions, not a claim that records have been changed.
The Render connection currently exposes deployment tools but no domain-association
or registrar DNS write operation.

Sources:
- Render custom domains: https://render.com/docs/custom-domains
- Render DNS setup: https://render.com/docs/configure-other-dns
- Porkbun DNS records: https://kb.porkbun.com/article/231-how-to-add-dns-records-on-porkbun
