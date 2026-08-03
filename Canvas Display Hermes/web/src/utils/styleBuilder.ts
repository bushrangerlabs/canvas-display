import type { BorderRadius, BorderWidth, ShadowConfig, UniversalStyle } from '../types/universal-widget';

export function buildBorderWidth(width: BorderWidth | undefined): string | undefined {
  if (width === undefined) return undefined;
  if (typeof width === 'number') return `${width}px`;
  const { top = 0, right = 0, bottom = 0, left = 0 } = width;
  return `${top}px ${right}px ${bottom}px ${left}px`;
}

export function buildBorderRadius(radius: BorderRadius | undefined): string | undefined {
  if (radius === undefined) return undefined;
  if (typeof radius === 'number') return `${radius}px`;
  const { topLeft = 0, topRight = 0, bottomRight = 0, bottomLeft = 0 } = radius;
  return `${topLeft}px ${topRight}px ${bottomRight}px ${bottomLeft}px`;
}

export function buildBoxShadow(shadows: ShadowConfig[] | undefined): string | undefined {
  if (!shadows || !Array.isArray(shadows) || shadows.length === 0) return undefined;
  return shadows
    .map(
      (s) =>
        `${s.inset ? 'inset ' : ''}${s.offsetX}px ${s.offsetY}px ${s.blur}px ${s.spread}px ${s.color}`
    )
    .join(', ');
}

export function applyColorOpacity(color: string, opacity: number): string {
  if (!color) return color;

  const rgbaMatch = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*[\d.]+)?\)/);
  if (rgbaMatch) {
    return `rgba(${rgbaMatch[1]}, ${rgbaMatch[2]}, ${rgbaMatch[3]}, ${opacity})`;
  }

  const hexMatch = color.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  if (hexMatch) {
    const r = parseInt(hexMatch[1], 16);
    const g = parseInt(hexMatch[2], 16);
    const b = parseInt(hexMatch[3], 16);
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
  }

  const shortHexMatch = color.match(/^#?([a-f\d])([a-f\d])([a-f\d])$/i);
  if (shortHexMatch) {
    const r = parseInt(shortHexMatch[1] + shortHexMatch[1], 16);
    const g = parseInt(shortHexMatch[2] + shortHexMatch[2], 16);
    const b = parseInt(shortHexMatch[3] + shortHexMatch[3], 16);
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
  }

  const namedColors: Record<string, string> = {
    black: `rgba(0, 0, 0, ${opacity})`,
    white: `rgba(255, 255, 255, ${opacity})`,
    red: `rgba(255, 0, 0, ${opacity})`,
    green: `rgba(128, 128, 128, ${opacity})`,
    blue: `rgba(0, 0, 255, ${opacity})`,
    gray: `rgba(128, 128, 128, ${opacity})`,
    grey: `rgba(128, 128, 128, ${opacity})`,
  };

  const lowerColor = color.toLowerCase();
  if (namedColors[lowerColor]) return namedColors[lowerColor];

  return color;
}

export function applyUniversalStyles(
  universalStyle: UniversalStyle | undefined,
  widgetStyles: React.CSSProperties = {}
): React.CSSProperties {
  if (!universalStyle) return widgetStyles;

  const {
    zIndex,
    rotation,
    backgroundColor,
    backgroundImage,
    backgroundOpacity,
    backgroundSize,
    backgroundPosition,
    backgroundRepeat,
    borderColor,
    borderWidth,
    borderRadius,
    borderStyle,
    boxShadow,
  } = universalStyle;

  const universalCSS: React.CSSProperties = {};
  universalCSS.boxSizing = 'border-box';
  if (zIndex !== undefined) universalCSS.zIndex = zIndex;
  if (rotation !== undefined) universalCSS.transform = `rotate(${rotation}deg)`;
  if (borderColor) universalCSS.borderColor = borderColor;
  if (borderWidth) universalCSS.borderWidth = buildBorderWidth(borderWidth);
  if (borderRadius) universalCSS.borderRadius = buildBorderRadius(borderRadius);
  if (borderStyle) universalCSS.borderStyle = borderStyle;

  const finalBackgroundColor = backgroundColor || (widgetStyles.backgroundColor as string);
  const finalBackgroundImage = backgroundImage || (widgetStyles.backgroundImage as string);

  const isTransparentColor = (c: string | undefined) =>
    !c || c === 'transparent' || c === 'rgba(0,0,0,0)' || c === 'rgba(0, 0, 0, 0)';
  const overlayColor = finalBackgroundImage
    ? (!isTransparentColor(backgroundColor) ? backgroundColor : undefined)
    : finalBackgroundColor;

  if (finalBackgroundImage) {
    universalCSS.backgroundColor = 'transparent';
  }

  if (overlayColor && finalBackgroundImage) {
    const colorWithOpacity = (backgroundOpacity !== undefined && backgroundOpacity !== 1)
      ? (applyColorOpacity(overlayColor, backgroundOpacity) || overlayColor)
      : overlayColor;
    universalCSS.backgroundImage = `linear-gradient(${colorWithOpacity}, ${colorWithOpacity}), ${finalBackgroundImage}`;
    if (backgroundSize) universalCSS.backgroundSize = backgroundSize;
    if (backgroundPosition) universalCSS.backgroundPosition = backgroundPosition;
    if (backgroundRepeat) universalCSS.backgroundRepeat = backgroundRepeat;
  } else {
    if (finalBackgroundColor && !finalBackgroundImage) {
      if (backgroundOpacity !== undefined && backgroundOpacity !== 1) {
        const colorWithOpacity = applyColorOpacity(finalBackgroundColor, backgroundOpacity);
        universalCSS.backgroundColor = colorWithOpacity || finalBackgroundColor;
      } else if (backgroundColor) {
        universalCSS.backgroundColor = backgroundColor;
      } else {
        universalCSS.backgroundColor = finalBackgroundColor;
      }
    }
    if (backgroundImage) universalCSS.backgroundImage = backgroundImage;
    if (backgroundSize) universalCSS.backgroundSize = backgroundSize;
    if (backgroundPosition) universalCSS.backgroundPosition = backgroundPosition;
    if (backgroundRepeat) universalCSS.backgroundRepeat = backgroundRepeat;
  }

  const hasBorder = borderWidth || borderStyle || widgetStyles.border;
  const hasAnyBackground = overlayColor || finalBackgroundColor || finalBackgroundImage;
  if (hasAnyBackground && hasBorder) {
    universalCSS.backgroundClip = 'padding-box';
    universalCSS.backgroundOrigin = 'padding-box';
  }

  if (boxShadow) {
    if (typeof boxShadow === 'string') {
      universalCSS.boxShadow = boxShadow;
    } else if (Array.isArray(boxShadow)) {
      universalCSS.boxShadow = buildBoxShadow(boxShadow);
    }
  }

  let cleanedWidgetStyles = widgetStyles;
  if (finalBackgroundImage) {
    cleanedWidgetStyles = { ...widgetStyles };
    delete cleanedWidgetStyles.backgroundColor;
    delete cleanedWidgetStyles.backgroundImage;
  }

  return { ...cleanedWidgetStyles, ...universalCSS };
}