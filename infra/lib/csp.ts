// The Content-Security-Policy CloudFront sends (hosting.ts). Plain string building with no CDK
// imports, so e2e browser checks can serve the very same policy. The API host is passed in (at deploy
// it is a CDK token for this app's own AppSync API, never a wildcard), so injected script couldn't
// send tokens or Logs to an API someone else owns.
export interface CspHosts {
  region: string;
  /** This app's AppSync host (no scheme, no path). */
  graphqlHost: string;
}

export function contentSecurityPolicy({ region, graphqlHost }: CspHosts): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    `connect-src 'self' https://${graphqlHost} https://cognito-idp.${region}.amazonaws.com`,
    "manifest-src 'self'",
    "worker-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
  ].join("; ");
}
