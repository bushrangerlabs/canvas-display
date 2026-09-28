import type { FieldMetadata, WidgetMetadata } from '../../types/metadata';
const style: FieldMetadata[] = [
  { name: 'backgroundColor', type: 'color', label: 'Background', default: '#12161f', category: 'style' },
  { name: 'textColor', type: 'color', label: 'Text', default: '#e6edf3', category: 'style' },
  { name: 'accentColor', type: 'color', label: 'Accent', default: '#ff0033', category: 'style' },
  { name: 'borderRadius', type: 'number', label: 'Corner radius', default: 12, min: 0, max: 40, category: 'style' },
];
export const youtubeMetadata = (kind: 'search'|'presets'|'single'|'now'|'controls'|'volume'): WidgetMetadata => ({
  name: ({ search:'YouTube Search', presets:'YouTube Presets', single:'YouTube Play Button', now:'YouTube Now Playing', controls:'YouTube Controls', volume:'YouTube Volume' })[kind],
  icon: kind === 'search' ? 'Search' : kind === 'controls' ? 'PlayCircle' : 'YouTube', category: 'media',
  description: `Dedicated YouTube ${kind} widget using the selected YouTube playback device`,
  defaultSize: kind === 'search' ? {w:380,h:400} : kind === 'presets' ? {w:360,h:180} : kind === 'single' ? {w:240,h:76} : kind === 'now' ? {w:360,h:110} : kind === 'controls' ? {w:300,h:90} : {w:300,h:76},
  minSize: { w: 140, h: 50 }, requiresEntity: false,
  fields: [
    ...(kind === 'search' ? [
      { name:'placeholder',type:'text',label:'Placeholder',default:'Search YouTube…',category:'behavior' } as FieldMetadata,
      { name:'resultLimit',type:'number',label:'Result limit',default:25,min:5,max:50,category:'behavior' } as FieldMetadata,
      { name:'pageSize',type:'number',label:'Results per page',default:8,min:1,max:20,category:'behavior' } as FieldMetadata,
      { name:'rowHeight',type:'number',label:'Result height',default:72,min:40,max:160,category:'style' } as FieldMetadata,
      { name:'iconSize',type:'number',label:'Thumbnail width',default:64,min:28,max:160,category:'style' } as FieldMetadata,
      { name:'fontSize',type:'number',label:'Text size',default:13,min:8,max:36,category:'style' } as FieldMetadata,
    ] : []),
    ...(kind === 'presets' ? [
      { name:'items',type:'textarea',label:'Presets (Label|URL, one per line)',default:'',category:'behavior' } as FieldMetadata,
      { name:'columns',type:'number',label:'Columns',default:3,min:1,max:8,category:'behavior' } as FieldMetadata,
      { name:'rowHeight',type:'number',label:'Button height',default:56,min:28,max:140,category:'style' } as FieldMetadata,
      { name:'fontSize',type:'number',label:'Text size',default:13,min:8,max:36,category:'style' } as FieldMetadata,
    ] : []),
    ...(kind === 'single' ? [{name:'value',type:'text',label:'YouTube URL or search',default:'',category:'behavior'},{name:'label',type:'text',label:'Button label',default:'',category:'behavior'},{name:'fontSize',type:'number',label:'Text size',default:15,min:8,max:36,category:'style'}] as FieldMetadata[] : []),
    ...(kind === 'now' ? [{name:'emptyText',type:'text',label:'Empty text',default:'Nothing playing',category:'behavior'}] as FieldMetadata[] : []),
    ...(kind === 'controls' ? [{name:'buttonSize',type:'number',label:'Button size',default:42,min:24,max:96,category:'style'}] as FieldMetadata[] : []),
    ...(kind === 'volume' ? [{name:'label',type:'text',label:'Label',default:'YouTube volume',category:'behavior'}] as FieldMetadata[] : []),
    ...style,
  ],
});
