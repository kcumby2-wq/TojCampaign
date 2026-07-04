import { rewrite, next } from '@vercel/edge';

const LANE_FILE_BY_HOST = {
  'sports.tojcampaign.com': '/sports.html',
  'smallbusiness.tojcampaign.com': '/smallbusiness.html',
  'bigbusiness.tojcampaign.com': '/bigbusiness.html',
  'advisory.tojcampaign.com': '/advisory.html',
};

export const config = { matcher: '/' };

export default function middleware(request) {
  const host = (request.headers.get('host') || '').toLowerCase().split(':')[0];
  const dest = LANE_FILE_BY_HOST[host];
  if (!dest) return next();
  return rewrite(new URL(dest, request.url));
}
