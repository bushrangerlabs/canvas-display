import { useEntityBinding } from './useEntityBinding';
import type { UniversalStyle } from '../widgets/types/universal-widget';

export function useResolvedUniversalStyle<T extends UniversalStyle | Record<string, any> | undefined>(
  style: T
): T {
  const raw = style as UniversalStyle | undefined;
  const backgroundColor    = useEntityBinding(raw?.backgroundColor,    raw?.backgroundColor);
  const backgroundImage    = useEntityBinding(raw?.backgroundImage,    raw?.backgroundImage);
  const borderColor        = useEntityBinding(raw?.borderColor,        raw?.borderColor);
  const borderStyle        = useEntityBinding(raw?.borderStyle,        raw?.borderStyle) as UniversalStyle['borderStyle'];
  const backgroundSize     = useEntityBinding(raw?.backgroundSize,     raw?.backgroundSize);
  const backgroundPosition = useEntityBinding(raw?.backgroundPosition, raw?.backgroundPosition);
  const backgroundRepeat   = useEntityBinding(raw?.backgroundRepeat,   raw?.backgroundRepeat);
  if (!style) return style;
  return {
    ...style,
    ...(backgroundColor    !== undefined && { backgroundColor }),
    ...(backgroundImage    !== undefined && { backgroundImage }),
    ...(borderColor        !== undefined && { borderColor }),
    ...(borderStyle        !== undefined && { borderStyle }),
    ...(backgroundSize     !== undefined && { backgroundSize }),
    ...(backgroundPosition !== undefined && { backgroundPosition }),
    ...(backgroundRepeat   !== undefined && { backgroundRepeat }),
  } as T;
}