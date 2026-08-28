/**
 * Something the site says about a password we found. Recorded as evidence, never acted on
 * automatically: the site is the thing under investigation, so its assertions are data to weigh,
 * not instructions to obey.
 */
export interface SiteClaim {
  password: string;
  /** Where the claim appears. */
  claimedAt: string;
  /** The site's own words, quoted rather than paraphrased. */
  quote: string;
  /** Why the claim is credible enough to surface, and what would make it wrong. */
  assessment: string;
}

/**
 * Passwords the site itself says are not part of the eight.
 *
 * Curated by hand rather than parsed out of page text. A crawler that reshaped its own results
 * around sentences found on the site it is crawling would be trivially misled, so each entry here
 * is a human decision with the evidence attached.
 */
const SITE_CLAIMS: SiteClaim[] = [
  {
    password: 'VISUALPING{0000deadbeef0000}',
    claimedAt: '/',
    quote:
      'Each one looks exactly like this worked example: VISUALPING{0000deadbeef0000}. ' +
      'The example above is not one of the eight — it is only here to show you the format.',
    assessment:
      'Credible: it sits inside a <pre><code> block in the instructions, and its hex reads as ' +
      'hand-typed filler (0000deadbeef0000) rather than random. Still reported as a candidate, ' +
      'because a challenge author could plant a real password exactly here to catch a crawler ' +
      'that trusts the page it is reading.',
  },
];

/**
 * Returns the site's claim about a password, or null if it made none. Used to mark a finding as
 * disputed so it stays visible in the report while being kept out of the confirmed count.
 */
export function findClaim(password: string): SiteClaim | null {
  return SITE_CLAIMS.find((claim) => claim.password === password) ?? null;
}

/** Every recorded claim, for the report section that lays them out for review. */
export function allClaims(): readonly SiteClaim[] {
  return SITE_CLAIMS;
}
