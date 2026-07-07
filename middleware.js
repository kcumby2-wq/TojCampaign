import { rewrite, next } from '@vercel/edge';

// Subdomain → vertical page rewrites. Legacy avenue hosts map to the vertical
// that replaced them (mirroring the path redirects in vercel.json); the
// vertical-native hosts work as soon as their DNS records exist.
const PAGE_BY_HOST = {
  // legacy avenue subdomains
  'sports.tojcampaign.com': '/authority.html',
  'smallbusiness.tojcampaign.com': '/personal-brand.html',
  'bigbusiness.tojcampaign.com': '/nonprofit.html',
  'advisory.tojcampaign.com': '/personal-brand.html',
  // vertical subdomains
  'authority.tojcampaign.com': '/authority.html',
  'personalbrand.tojcampaign.com': '/personal-brand.html',
  'personal.tojcampaign.com': '/personal-brand.html',
  'nonprofit.tojcampaign.com': '/nonprofit.html',
  // entry offer
  'score.tojcampaign.com': '/foundation-score.html',
};

export const config = { matcher: '/' };

export default function middleware(request) {
  const host = (request.headers.get('host') || '').toLowerCase().split(':')[0];
  const dest = PAGE_BY_HOST[host];
  if (!dest) return next();
  return rewrite(new URL(dest, request.url));
}
