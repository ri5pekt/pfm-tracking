/** Carrier code → public logo path under /carriers */
export const CARRIER_LOGOS: Record<string, string> = {
  usps: '/carriers/usps.png',
  fedex: '/carriers/fedex.png',
  ups: '/carriers/ups.png',
  dhl_ecs: '/carriers/dhl.png',
  amazon_shipping: '/carriers/amazon.png',
  ontrac: '/carriers/ontrac.png',
  uniuni: '/carriers/uniuni.png',
  speedx: '/carriers/speedx.png',
  cirro: '/carriers/cirro.png',
  osm_worldwide: '/carriers/osm.png',
  better_trucks: '/carriers/better-trucks.png',
};

export function carrierLogo(code: string | null | undefined): string | null {
  if (!code) return null;
  return CARRIER_LOGOS[code] ?? null;
}
