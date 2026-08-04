/**
 * Energy Monitor Widget
 * Displays solar generation, grid import/export, battery state of charge,
 * and house consumption from Home Assistant energy entities.
 *
 * Shows a simple power-flow diagram: Solar → House ← Grid, with Battery.
 */

import React from 'react';
import { useVisibility } from '../../hooks/useVisibility';
import { useWidget } from '../hooks/useWidget';
import type { WidgetProps } from '../types/index';
import type { WidgetMetadata } from '../types/metadata';

export const EnergyMonitorWidgetMetadata: WidgetMetadata = {
  name: 'Energy Monitor',
  icon: 'ElectricBolt',
  category: 'display',
  description: 'Solar generation, grid import/export, battery SoC and house consumption — power flow diagram',
  defaultSize: { w: 380, h: 220 },
  minSize: { w: 280, h: 160 },
  fields: [
    { name: 'solar_entity', type: 'entity', label: 'Solar power entity (W)', default: '', category: 'behavior', description: 'sensor.* giving current solar generation in W' },
    { name: 'grid_entity', type: 'entity', label: 'Grid power entity (W)', default: '', category: 'behavior', description: 'sensor.* giving current grid power (positive = importing, negative = exporting)' },
    { name: 'battery_entity', type: 'entity', label: 'Battery SoC entity (%)', default: '', category: 'behavior', description: 'sensor.* giving battery state of charge in %' },
    { name: 'battery_power_entity', type: 'entity', label: 'Battery power entity (W)', default: '', category: 'behavior', description: 'sensor.* giving battery charge/discharge in W (positive = charging)' },
    { name: 'house_entity', type: 'entity', label: 'House consumption entity (W)', default: '', category: 'behavior', description: 'sensor.* giving total house consumption in W' },
    { name: 'pollInterval', type: 'number', label: 'Poll interval (s)', default: 10, min: 5, max: 60, category: 'behavior' },
    { name: 'backgroundColor', type: 'color', label: 'Background', default: '#0d1117', category: 'style' },
    { name: 'textColor', type: 'color', label: 'Text colour', default: '#e6edf3', category: 'style' },
    { name: 'solarColor', type: 'color', label: 'Solar colour', default: '#ffd700', category: 'style' },
    { name: 'gridColor', type: 'color', label: 'Grid colour', default: '#58a6ff', category: 'style' },
    { name: 'batteryColor', type: 'color', label: 'Battery colour', default: '#3fb950', category: 'style' },
    { name: 'houseColor', type: 'color', label: 'House colour', default: '#f0883e', category: 'style' },
    { name: 'borderRadius', type: 'number', label: 'Corner radius', default: 12, min: 0, max: 40, category: 'style' },
  ],
};

function parseWatts(state: string | undefined): number {
  if (!state || state === 'unavailable' || state === 'unknown') return 0;
  const n = parseFloat(state);
  return Number.isFinite(n) ? n : 0;
}

function fmtWatts(w: number): string {
  const abs = Math.abs(w);
  if (abs >= 1000) return `${(w / 1000).toFixed(1)} kW`;
  return `${Math.round(w)} W`;
}

interface NodeProps {
  label: string;
  value: string;
  color: string;
  icon: string;
  textColor: string;
  size?: number;
}

const EnergyNode: React.FC<NodeProps> = ({ label, value, color, icon, textColor, size = 72 }) => (
  <div style={{
    width: size, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
  }}>
    <div style={{
      width: size, height: size,
      borderRadius: size / 2,
      border: `2px solid ${color}`,
      backgroundColor: `${color}18`,
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 2,
    }}>
      <span style={{ fontSize: size * 0.32 }}>{icon}</span>
      <span style={{ color, fontSize: size * 0.18, fontWeight: 700, lineHeight: 1 }}>{value}</span>
    </div>
    <span style={{ color: textColor, fontSize: 10, opacity: 0.7, textAlign: 'center' }}>{label}</span>
  </div>
);

interface FlowArrowProps {
  active: boolean;
  color: string;
  direction: 'left' | 'right' | 'up' | 'down';
  width?: number;
}

const FlowArrow: React.FC<FlowArrowProps> = ({ active, color, direction, width = 40 }) => {
  const isHoriz = direction === 'left' || direction === 'right';
  const arrow = direction === 'right' ? '→' : direction === 'left' ? '←' : direction === 'down' ? '↓' : '↑';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      width: isHoriz ? width : 20, height: isHoriz ? 20 : width,
      color: active ? color : 'rgba(255,255,255,0.1)',
      fontSize: 18, fontWeight: 700,
      transition: 'color 0.5s',
      opacity: active ? 1 : 0.3,
    }}>
      {arrow}
    </div>
  );
};

const EnergyMonitorWidget: React.FC<WidgetProps> = ({ config }) => {
  const cfg = config.config ?? {};
  const width = config.position?.width ?? cfg.width ?? 380;
  const height = config.position?.height ?? cfg.height ?? 220;

  const backgroundColor: string = cfg.backgroundColor ?? '#0d1117';
  const textColor: string = cfg.textColor ?? '#e6edf3';
  const solarColor: string = cfg.solarColor ?? '#ffd700';
  const gridColor: string = cfg.gridColor ?? '#58a6ff';
  const batteryColor: string = cfg.batteryColor ?? '#3fb950';
  const houseColor: string = cfg.houseColor ?? '#f0883e';
  const borderRadius: number = cfg.borderRadius ?? 12;

  const isVisible = useVisibility(cfg.visibilityCondition);
  const { getEntityState } = useWidget(config);

  const solarW = parseWatts(getEntityState('solar_entity'));
  const gridW = parseWatts(getEntityState('grid_entity'));
  const batteryPct = parseWatts(getEntityState('battery_entity'));
  const batteryW = parseWatts(getEntityState('battery_power_entity'));
  const houseW = parseWatts(getEntityState('house_entity'));

  const exporting = gridW < 0;
  const batteryCharging = batteryW > 0;
  const nodeSize = Math.min(70, Math.floor((width - 80) / 3.5));

  if (!isVisible) return null;

  return (
    <div style={{
      width, height, backgroundColor, borderRadius,
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      boxSizing: 'border-box', padding: 12,
      gap: 8, overflow: 'hidden',
    }}>
      {/* Title */}
      <div style={{ color: textColor, fontSize: 11, opacity: 0.5, letterSpacing: 1, textTransform: 'uppercase' }}>
        Energy Flow
      </div>

      {/* Main flow row: Solar → House ← Grid */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
        <EnergyNode label="Solar" value={fmtWatts(solarW)} color={solarColor} icon="☀️" textColor={textColor} size={nodeSize} />
        <FlowArrow active={solarW > 50} color={solarColor} direction="right" width={32} />
        <EnergyNode label="House" value={fmtWatts(houseW || solarW + Math.abs(gridW < 0 ? 0 : gridW))} color={houseColor} icon="🏠" textColor={textColor} size={nodeSize} />
        <FlowArrow active={gridW > 50} color={gridColor} direction="left" width={32} />
        <EnergyNode label={exporting ? 'Exporting' : 'Grid'} value={fmtWatts(Math.abs(gridW))} color={gridColor} icon="⚡" textColor={textColor} size={nodeSize} />
      </div>

      {/* Battery row */}
      {cfg.battery_entity && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <FlowArrow active={batteryCharging} color={batteryColor} direction={batteryCharging ? 'down' : 'up'} width={24} />
          <EnergyNode
            label={`Battery ${batteryCharging ? '↑' : '↓'} (${Math.round(batteryPct)}%)`}
            value={fmtWatts(Math.abs(batteryW))}
            color={batteryColor}
            icon="🔋"
            textColor={textColor}
            size={nodeSize * 0.9}
          />
        </div>
      )}

      {/* Stats bar */}
      <div style={{
        display: 'flex', gap: 16, flexWrap: 'wrap', justifyContent: 'center',
        borderTop: '1px solid rgba(255,255,255,0.08)',
        paddingTop: 6, width: '100%',
      }}>
        {[
          { label: 'Solar', v: fmtWatts(solarW), color: solarColor },
          { label: exporting ? 'Export' : 'Import', v: fmtWatts(Math.abs(gridW)), color: gridColor },
          ...(cfg.battery_entity ? [{ label: `Batt ${Math.round(batteryPct)}%`, v: fmtWatts(Math.abs(batteryW)), color: batteryColor }] : []),
        ].map(s => (
          <div key={s.label} style={{ textAlign: 'center' }}>
            <div style={{ color: s.color, fontSize: 12, fontWeight: 700 }}>{s.v}</div>
            <div style={{ color: textColor, fontSize: 9, opacity: 0.5 }}>{s.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default EnergyMonitorWidget;
