/**
 * Central Widget Registry
 * Single source of truth for all widget metadata
 */

import type { WidgetMetadata } from '../types/metadata';
import { BorderWidgetMetadata } from '../widgets/BorderWidget';
import { ButtonWidgetMetadata } from '../widgets/ButtonWidget';
import { CalendarWidgetMetadata } from '../widgets/CalendarWidget';
import { cameraWidgetMetadata } from '../widgets/CameraWidget';
import { ColorPickerWidgetMetadata } from '../widgets/ColorPickerWidget';
import { DigitalClockWidgetMetadata } from '../widgets/DigitalClockWidget';
import { analogClockMetadata } from '../widgets/AnalogClockWidget';
import { FlipClockWidgetMetadata } from '../widgets/FlipClockWidget';
import { GaugeWidgetMetadata } from '../widgets/GaugeWidget';
import { GraphWidgetMetadata } from '../widgets/GraphWidget';
import { htmlWidgetMetadata } from '../widgets/HtmlWidget';
import { iconWidgetMetadata } from '../widgets/IconWidget';
import { IFrameWidgetMetadata } from '../widgets/IFrameWidget';
import { ImageWidgetMetadata } from '../widgets/ImageWidget';
import { InputTextWidgetMetadata } from '../widgets/InputTextWidget';
import { KeyboardWidgetMetadata } from '../widgets/KeyboardWidget';
import { KnobWidgetMetadata } from '../widgets/KnobWidget';
import { ProgressBarWidgetMetadata } from '../widgets/ProgressBarWidget';
import { ProgressCircleWidgetMetadata } from '../widgets/ProgressCircleWidget';
import { RadioButtonWidgetMetadata } from '../widgets/RadioButtonWidget';
import { resolutionWidgetMetadata } from '../widgets/ResolutionWidget';
import { screensaverWidgetMetadata } from '../widgets/ScreensaverWidget';
import { ScrollingTextWidgetMetadata } from '../widgets/ScrollingTextWidget';
import { scrollableContainerMetadata } from '../widgets/ScrollableContainerWidget';
import { ShapeWidgetMetadata } from '../widgets/ShapeWidget';
import { SliderWidgetMetadata } from '../widgets/SliderWidget';
import { SwitchWidgetMetadata } from '../widgets/SwitchWidget';
import { TextWidgetMetadata } from '../widgets/TextWidget';
import { ValueWidgetMetadata } from '../widgets/ValueWidget';
import { weatherWidgetMetadata } from '../widgets/WeatherWidget';
import { PlaylistResultWidgetMetadata } from '../widgets/PlaylistResultWidget';
import { KnowledgeCardWidgetMetadata } from '../widgets/KnowledgeCardWidget';
import { AnnouncementWidgetMetadata } from '../widgets/AnnouncementWidget';
import { NowPlayingWidgetMetadata } from '../widgets/NowPlayingWidget';
import { CountdownTimerWidgetMetadata } from '../widgets/CountdownTimerWidget';
import { EnergyMonitorWidgetMetadata } from '../widgets/EnergyMonitorWidget';
import { DabRadioWidgetMetadata } from '../widgets/DabRadioWidget';
import { DispatcharrWidgetMetadata } from '../widgets/DispatcharrWidget';
import { DabStationsWidgetMetadata } from '../widgets/DabStationsWidget';
import { DabNowPlayingWidgetMetadata } from '../widgets/DabNowPlayingWidget';
import { DabControlsWidgetMetadata } from '../widgets/DabControlsWidget';
import { DabVolumeSliderWidgetMetadata } from '../widgets/DabVolumeSliderWidget';
import { DabVolumeDialWidgetMetadata } from '../widgets/DabVolumeDialWidget';
import { DabPresetsWidgetMetadata } from '../widgets/DabPresetsWidget';
import { DabSearchWidgetMetadata } from '../widgets/DabSearchWidget';
import { DabPlayButtonWidgetMetadata } from '../widgets/DabPlayButtonWidget';
import { DispatcharrChannelsWidgetMetadata } from '../widgets/DispatcharrChannelsWidget';
import { DispatcharrNowPlayingWidgetMetadata } from '../widgets/DispatcharrNowPlayingWidget';
import { DispatcharrControlsWidgetMetadata } from '../widgets/DispatcharrControlsWidget';
import { DispatcharrVolumeSliderWidgetMetadata } from '../widgets/DispatcharrVolumeSliderWidget';
import { DispatcharrVolumeDialWidgetMetadata } from '../widgets/DispatcharrVolumeDialWidget';
import { DispatcharrPresetsWidgetMetadata } from '../widgets/DispatcharrPresetsWidget';
import { DispatcharrSearchWidgetMetadata } from '../widgets/DispatcharrSearchWidget';
import { DispatcharrPlayButtonWidgetMetadata } from '../widgets/DispatcharrPlayButtonWidget';
import { PlaybackDeviceListWidgetMetadata } from '../widgets/PlaybackDeviceListWidget';
import { PlaybackDeviceButtonWidgetMetadata } from '../widgets/PlaybackDeviceButtonWidget';
import { PlaybackDeviceIndicatorWidgetMetadata } from '../widgets/PlaybackDeviceIndicatorWidget';
import { YouTubeSearchWidgetMetadata } from '../widgets/YouTubeSearchWidget';
import { YouTubePresetsWidgetMetadata } from '../widgets/YouTubePresetsWidget';
import { YouTubePlayButtonWidgetMetadata } from '../widgets/YouTubePlayButtonWidget';
import { YouTubeNowPlayingWidgetMetadata } from '../widgets/YouTubeNowPlayingWidget';
import { YouTubeControlsWidgetMetadata } from '../widgets/YouTubeControlsWidget';
import { YouTubeVolumeWidgetMetadata } from '../widgets/YouTubeVolumeWidget';
import { YouTubeMusicSearchWidgetMetadata } from '../widgets/YouTubeMusicSearchWidget';
import { YouTubeMusicPresetsWidgetMetadata } from '../widgets/YouTubeMusicPresetsWidget';
import { YouTubeMusicPlayButtonWidgetMetadata } from '../widgets/YouTubeMusicPlayButtonWidget';
import { YouTubeMusicNowPlayingWidgetMetadata } from '../widgets/YouTubeMusicNowPlayingWidget';
import { YouTubeMusicControlsWidgetMetadata } from '../widgets/YouTubeMusicControlsWidget';
import { YouTubeMusicVolumeWidgetMetadata } from '../widgets/YouTubeMusicVolumeWidget';
import { MaPlayersWidgetMetadata } from '../widgets/MaPlayersWidget';
import { MaNowPlayingWidgetMetadata } from '../widgets/MaNowPlayingWidget';
import { MaControlsWidgetMetadata } from '../widgets/MaControlsWidget';
import { MaVolumeSliderWidgetMetadata } from '../widgets/MaVolumeSliderWidget';
import { MaVolumeDialWidgetMetadata } from '../widgets/MaVolumeDialWidget';
import { MaRadiosWidgetMetadata } from '../widgets/MaRadiosWidget';
import { MaPlaylistsWidgetMetadata } from '../widgets/MaPlaylistsWidget';
import { MaSearchWidgetMetadata } from '../widgets/MaSearchWidget';
import { MaQueueWidgetMetadata } from '../widgets/MaQueueWidget';
import { MaBrowseWidgetMetadata } from '../widgets/MaBrowseWidget';
import { BroadcastWidgetMetadata } from '../widgets/BroadcastWidget';

export interface WidgetRegistryEntry {
  type: string;
  metadata: WidgetMetadata;
}

// Central widget metadata registry - add new widgets here
export const WIDGET_REGISTRY: Record<string, WidgetMetadata> = {
  button: ButtonWidgetMetadata,
  text: TextWidgetMetadata,
  gauge: GaugeWidgetMetadata,
  camera: cameraWidgetMetadata,
  slider: SliderWidgetMetadata,
  switch: SwitchWidgetMetadata,
  image: ImageWidgetMetadata,
  icon: iconWidgetMetadata,
  progressbar: ProgressBarWidgetMetadata,
  progresscircle: ProgressCircleWidgetMetadata,
  inputtext: InputTextWidgetMetadata,
  keyboard: KeyboardWidgetMetadata,
  analogclock: analogClockMetadata,
  flipclock: FlipClockWidgetMetadata,
  digitalclock: DigitalClockWidgetMetadata,
  knob: KnobWidgetMetadata,
  iframe: IFrameWidgetMetadata,
  border: BorderWidgetMetadata,
  value: ValueWidgetMetadata,
  radiobutton: RadioButtonWidgetMetadata,
  colorpicker: ColorPickerWidgetMetadata,
  weather: weatherWidgetMetadata,
  resolution: resolutionWidgetMetadata,
  html: htmlWidgetMetadata,
  graph: GraphWidgetMetadata,
  calendar: CalendarWidgetMetadata,
  scrollingtext: ScrollingTextWidgetMetadata,
  shape: ShapeWidgetMetadata,
  screensaver: screensaverWidgetMetadata,
  scrollablecontainer: scrollableContainerMetadata,
  playlistresult: PlaylistResultWidgetMetadata,
  knowledgecard: KnowledgeCardWidgetMetadata,
  announcement: AnnouncementWidgetMetadata,
  nowplaying: NowPlayingWidgetMetadata,
  countdowntimer: CountdownTimerWidgetMetadata,
  energymonitor: EnergyMonitorWidgetMetadata,
  dabradio: DabRadioWidgetMetadata,
  dispatcharr: DispatcharrWidgetMetadata,
  dabstations: DabStationsWidgetMetadata,
  dabnowplaying: DabNowPlayingWidgetMetadata,
  dabcontrols: DabControlsWidgetMetadata,
  dabvolumeslider: DabVolumeSliderWidgetMetadata,
  dabvolumedial: DabVolumeDialWidgetMetadata,
  dabpresets: DabPresetsWidgetMetadata,
  dabsearch: DabSearchWidgetMetadata,
  dabplaybutton: DabPlayButtonWidgetMetadata,
  dispatcharrchannels: DispatcharrChannelsWidgetMetadata,
  dispatcharrnowplaying: DispatcharrNowPlayingWidgetMetadata,
  dispatcharrcontrols: DispatcharrControlsWidgetMetadata,
  dispatcharrvolumeslider: DispatcharrVolumeSliderWidgetMetadata,
  dispatcharrvolumedial: DispatcharrVolumeDialWidgetMetadata,
  dispatcharrpresets: DispatcharrPresetsWidgetMetadata,
  dispatcharrsearch: DispatcharrSearchWidgetMetadata,
  dispatcharrplaybutton: DispatcharrPlayButtonWidgetMetadata,
  playbackdevicelist: PlaybackDeviceListWidgetMetadata,
  playbackdevicebutton: PlaybackDeviceButtonWidgetMetadata,
  playbackdeviceindicator: PlaybackDeviceIndicatorWidgetMetadata,
  youtubesearch: YouTubeSearchWidgetMetadata,
  youtubepresets: YouTubePresetsWidgetMetadata,
  youtubeplaybutton: YouTubePlayButtonWidgetMetadata,
  youtubenowplaying: YouTubeNowPlayingWidgetMetadata,
  youtubecontrols: YouTubeControlsWidgetMetadata,
  youtubevolume: YouTubeVolumeWidgetMetadata,
  youtubemusicsearch: YouTubeMusicSearchWidgetMetadata,
  youtubemusicpresets: YouTubeMusicPresetsWidgetMetadata,
  youtubemusicplaybutton: YouTubeMusicPlayButtonWidgetMetadata,
  youtubemusicnowplaying: YouTubeMusicNowPlayingWidgetMetadata,
  youtubemusiccontrols: YouTubeMusicControlsWidgetMetadata,
  youtubemusicvolume: YouTubeMusicVolumeWidgetMetadata,
  maplayers: MaPlayersWidgetMetadata,
  manowplaying: MaNowPlayingWidgetMetadata,
  macontrols: MaControlsWidgetMetadata,
  mavolumeslider: MaVolumeSliderWidgetMetadata,
  mavolumedial: MaVolumeDialWidgetMetadata,
  maradios: MaRadiosWidgetMetadata,
  maplaylists: MaPlaylistsWidgetMetadata,
  masearch: MaSearchWidgetMetadata,
  maqueue: MaQueueWidgetMetadata,
  mabrowse: MaBrowseWidgetMetadata,
  broadcast: BroadcastWidgetMetadata,
};

/**
 * Get all widget types
 */
export function getWidgetTypes(): string[] {
  return Object.keys(WIDGET_REGISTRY);
}

/**
 * Get metadata for a specific widget type
 */
export function getWidgetMetadata(type: string): WidgetMetadata | undefined {
  return WIDGET_REGISTRY[type];
}

/**
 * Get all widget entries as array (type + metadata pairs)
 */
export function getAllWidgets(): WidgetRegistryEntry[] {
  return Object.entries(WIDGET_REGISTRY).map(([type, metadata]) => ({
    type,
    metadata,
  }));
}
