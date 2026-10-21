/** Pure geometry used by the titlebar unit test; production measures real DOM rects in Electron. */
export interface RectLike { left: number; width: number }

/** |brand centre - titlebar centre| in CSS pixels. The frozen acceptance budget is <= 1. */
export const brandCenterOffset = (brand: RectLike, titlebar: RectLike): number =>
  Math.abs(brand.left + brand.width / 2 - (titlebar.left + titlebar.width / 2));

export const BRAND_CENTER_TOLERANCE = 1;

export const isBrandCentered = (brand: RectLike, titlebar: RectLike): boolean =>
  brandCenterOffset(brand, titlebar) <= BRAND_CENTER_TOLERANCE;
