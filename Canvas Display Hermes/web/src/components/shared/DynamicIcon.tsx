import React, { useEffect, useState } from 'react';
import { loadMDIIcons, loadReactIcons, parseIconString } from '../utils/iconLoader';
import { UniversalIcon } from './UniversalIcon';

interface DynamicIconProps {
  icon: string;
  size?: number;
  color?: string;
  style?: React.CSSProperties;
  outlineMode?: 'none' | 'outline' | 'filled';
  strokeWidth?: number;
  glowWidth?: number;
  glowColor?: string;
  shadowEnabled?: boolean;
  shadowColor?: string;
  shadowOffsetX?: number;
  shadowOffsetY?: number;
  shadowBlur?: number;
  fillDirection?: 'bottom-up' | 'top-down' | 'left-to-right' | 'right-to-left';
  fillColor?: string;
  fillImage?: string;
  coverColor?: string;
  fillPercentage?: number;
}

export const DynamicIcon: React.FC<DynamicIconProps> = ({
  icon,
  size = 24,
  color = 'currentColor',
  style = {},
  outlineMode = 'none',
  strokeWidth = 2,
  glowWidth = 0,
  glowColor = '',
  shadowEnabled = false,
  shadowColor = '#000000',
  shadowOffsetX = 2,
  shadowOffsetY = 2,
  shadowBlur = 4,
  fillDirection = 'bottom-up',
  fillColor = '#00ff00',
  fillImage = '',
  coverColor = '#000000',
  fillPercentage = 0,
}) => {
  const [IconComponent, setIconComponent] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    const loadIcon = async () => {
      setLoading(true);
      const { type, name } = parseIconString(icon);

      try {
        if (icon.includes(':') && !icon.startsWith('emoji:') && type !== 'mdi' &&
            type !== 'fa' && type !== 'md' && type !== 'io' && type !== 'bi') {
          if (mounted) {
            setIconComponent(() => () => (
              <UniversalIcon icon={icon} size={size} color={color} style={style} />
            ));
            setLoading(false);
          }
        } else if (type === 'emoji') {
          if (mounted) {
            const emojiStyle: React.CSSProperties = {
              fontSize: size,
              color: color,
              ...style,
            };
            setIconComponent(() => () => <span style={emojiStyle}>{name}</span>);
            setLoading(false);
          }
        } else if (type === 'mdi') {
          const { icons, Icon } = await loadMDIIcons();
          const camelName = 'mdi' + name.split('-').map(word =>
            word.charAt(0).toUpperCase() + word.slice(1)
          ).join('');
          const iconPath = icons[camelName];
          if (iconPath && mounted) {
            setIconComponent(() => () => (
              <Icon path={iconPath} size={`${size}px`} color={color} style={style} />
            ));
          }
          if (mounted) setLoading(false);
        } else {
          const iconLib = await loadReactIcons(type as any);
          const Component = iconLib[name];
          if (Component && mounted) {
            setIconComponent(() => () => <Component size={size} color={color} style={style} />);
          }
          if (mounted) setLoading(false);
        }
      } catch (e) {
        if (mounted) setLoading(false);
      }
    };

    loadIcon();
    return () => { mounted = false; };
  }, [icon, size, color, style, outlineMode, strokeWidth, glowWidth, glowColor, shadowEnabled, shadowColor, shadowOffsetX, shadowOffsetY, shadowBlur, fillDirection, fillColor, fillImage, coverColor, fillPercentage]);

  if (loading) {
    return <span style={{ width: size, height: size, display: 'inline-block' }} />;
  }

  return IconComponent ? <IconComponent /> : <span style={{ fontSize: size, color }}>?</span>;
};