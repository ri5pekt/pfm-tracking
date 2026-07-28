/** Bump when replacing logo files so browsers skip stale cached PNGs. */
const LOGO_V = '20260728c';

/** Carrier code → public logo path under /carriers */
export const CARRIER_LOGOS: Record<string, string> = {
  usps: `/carriers/usps.png?v=${LOGO_V}`,
  fedex: `/carriers/fedex.png?v=${LOGO_V}`,
  ups: `/carriers/ups.png?v=${LOGO_V}`,
  dhl_ecs: `/carriers/dhl.png?v=${LOGO_V}`,
  amazon_shipping: `/carriers/amazon.png?v=${LOGO_V}`,
  ontrac: `/carriers/ontrac.png?v=${LOGO_V}`,
  uniuni: `/carriers/uniuni.png?v=${LOGO_V}`,
  speedx: `/carriers/speedx.png?v=${LOGO_V}`,
  cirro: `/carriers/cirro.png?v=${LOGO_V}`,
  osm_worldwide: `/carriers/osm.png?v=${LOGO_V}`,
  better_trucks: `/carriers/better-trucks.png?v=${LOGO_V}`,
};

export function carrierLogo(code: string | null | undefined): string | null {
  if (!code) return null;
  return CARRIER_LOGOS[code] ?? null;
}
