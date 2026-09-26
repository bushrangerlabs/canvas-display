/**
 * Universal Icon Component
 * Supports both iconify-react (new) and emoji (always supported)
 */

import { Icon as IconifyIcon } from '@iconify/react';
import React, { useEffect, useState } from 'react';
import { customIconName, customIconSvg, loadCustomIcons, syncCustomIconsFromServer, type CustomIcon } from '../utils/customIcons';

interface UniversalIconProps {
  icon: string;
  size?: number;
  color?: string;
  style?: React.CSSProperties;
  className?: string;
}

export const UniversalIcon: React.FC<UniversalIconProps> = ({
  icon,
  size = 24,
  color = 'currentColor',
  style = {},
  className = '',
}) => {
  const isCustom = icon.startsWith('custom:');
  const customName = isCustom ? customIconName(icon) : '';

  // Hooks must run unconditionally — always call these, and only act on the
  // 'custom:' result below. Keeps hook order stable as `icon` changes type.
  const [custom, setCustom] = useState<CustomIcon | undefined>(
    () => (isCustom ? loadCustomIcons().find(item => item.name === customName) : undefined),
  );
  useEffect(() => {
    if (!isCustom || custom) return;
    // Not in the local cache yet (e.g. a fresh edge/kiosk browser) — pull the
    // authoritative list from the server so custom icons render everywhere.
    syncCustomIconsFromServer().then(() => {
      const found = loadCustomIcons().find(item => item.name === customName);
      if (found) setCustom(found);
    });
  }, [isCustom, customName, custom]);

  if (icon.startsWith('emoji:')) {
    const emoji = icon.replace('emoji:', '');
    return (
      <span
        className={className}
        style={{
          fontSize: size,
          color,
          lineHeight: 1,
          display: 'inline-block',
          ...style,
        }}
      >
        {emoji}
      </span>
    );
  }
  if (isCustom) {
    if (!custom) return null;
    return (
      <span
        className={className}
        aria-label={icon}
        style={{ display: 'inline-flex', width: size, height: size, color, ...style }}
        dangerouslySetInnerHTML={{ __html: customIconSvg(custom, color) }}
      />
    );
  }
  return (
    <IconifyIcon
      icon={icon}
      width={size}
      height={size}
      color={color}
      style={style}
      className={className}
    />
  );
};