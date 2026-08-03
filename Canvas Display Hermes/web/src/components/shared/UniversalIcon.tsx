import React from 'react';
import { Icon as IconifyIcon } from '@iconify/react';

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
  if (icon.startsWith('emoji:')) {
    const emoji = icon.replace('emoji:', '');
    return (
      <span
        className={className}
        style={{ fontSize: size, color, lineHeight: 1, display: 'inline-block', ...style }}
      >
        {emoji}
      </span>
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