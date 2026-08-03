/**
 * Tests for the deterministic intent router.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { routeIntent } from '../src/intent-router.js';

describe('Intent router', () => {
  test('routes "turn on the kitchen light" to light_set', () => {
    const result = routeIntent('turn on the kitchen light');
    assert.equal(result.intent, 'light_set');
    assert.equal(result.entities.length, 1);
    assert.equal(result.entities[0].id, 'light.kitchen');
    assert.equal(result.clarification_needed, false);
    assert.equal(result.tool_calls.length, 1);
    assert.equal(result.tool_calls[0].tool, 'ha.call_service');
  });

  test('routes "turn off the bedroom light" to light_set with turn_off', () => {
    const result = routeIntent('turn off the bedroom light');
    assert.equal(result.intent, 'light_set');
    assert.equal(result.entities[0].id, 'light.bedroom');
    assert.equal(result.tool_calls[0].arguments.service, 'turn_off');
  });

  test('routes "set the living room light to 50 percent" with brightness', () => {
    const result = routeIntent('set the living room light to 50 percent');
    assert.equal(result.intent, 'light_set');
    assert.equal(result.entities[0].id, 'light.living_room');
    assert.equal(result.tool_calls[0].arguments.service_data.brightness_pct, 50);
  });

  test('routes "what is the temperature in the living room" to climate_query', () => {
    const result = routeIntent('what is the temperature in the living room');
    assert.equal(result.intent, 'climate_query');
    assert.equal(result.entities[0].id, 'sensor.living_room_temperature');
  });

  test('routes "play some jazz music in the office" to media_play', () => {
    const result = routeIntent('play some jazz music in the office');
    assert.equal(result.intent, 'media_play');
    assert.ok(result.tool_calls.length >= 2);
  });

  test('routes a specific YouTube title to media_play with the full query', () => {
    const result = routeIntent('Play Bohemian Rhapsody official video on YouTube');
    assert.equal(result.intent, 'media_play');
    assert.equal(result.matched_pattern, 'media_play_youtube');
    assert.deepEqual(result.tool_calls[0], {
      tool: 'media.play',
      arguments: {
        query: 'Bohemian Rhapsody official video',
        source: 'youtube',
        media_kind: 'video',
      },
    });
  });

  test('routes "watch" requests to YouTube playback', () => {
    const result = routeIntent('Watch Bluey Dance Mode on YouTube please.');
    assert.equal(result.intent, 'media_play');
    assert.equal(result.tool_calls[0].arguments.query, 'Bluey Dance Mode official video');
    assert.equal(result.tool_calls[0].arguments.source, 'youtube');
  });

  test('understands conversational YouTube music requests and creates focused searches', () => {
    const song = routeIntent('Could you play the song Dreams by Fleetwood Mac on YouTube Music please?');
    assert.equal(song.intent, 'media_play');
    assert.equal(song.tool_calls[0].arguments.media_kind, 'song');
    assert.equal(song.tool_calls[0].arguments.query, 'Dreams Fleetwood Mac official audio');

    const artist = routeIntent("I'd like to listen to something by Missy Higgins");
    assert.equal(artist.tool_calls[0].arguments.media_kind, 'artist');
    assert.equal(artist.tool_calls[0].arguments.query, 'Missy Higgins greatest hits playlist');

    const mood = routeIntent('Find me a relaxing acoustic music mix on YouTube');
    assert.equal(mood.tool_calls[0].arguments.media_kind, 'music');
    assert.equal(mood.tool_calls[0].arguments.query, 'a relaxing acoustic music mix playlist');
  });

  test('routes public playlist and YouTube Music requests', () => {
    const playlist = routeIntent('Play my road trip playlist');
    assert.equal(playlist.matched_pattern, 'media_play_youtube_playlist');
    assert.equal(playlist.tool_calls[0].arguments.query, 'my road trip playlist');

    const artist = routeIntent('Play music by Crowded House on YouTube Music');
    assert.equal(artist.matched_pattern, 'media_play_youtube_artist');
    assert.equal(artist.tool_calls[0].arguments.query, 'Crowded House greatest hits playlist');

    const album = routeIntent('Play the Abbey Road album');
    assert.equal(album.matched_pattern, 'media_play_youtube_album');
    assert.match(String(album.tool_calls[0].arguments.query), /Abbey Road full album playlist/i);
  });

  test('routes "set a timer for 10 minutes" to timer_set', () => {
    const result = routeIntent('set a timer for 10 minutes');
    assert.equal(result.intent, 'timer_set');
    assert.equal(result.tool_calls[0].arguments.duration_minutes, 10);
  });

  test('routes "activate movie night scene" to scene_activate', () => {
    const result = routeIntent('activate movie night scene');
    assert.equal(result.intent, 'scene_activate');
    assert.equal(result.entities[0].id, 'scene.movie_night');
  });

  test('routes "what is the weather forecast for today" to weather_query', () => {
    const result = routeIntent('what is the weather forecast for today');
    assert.equal(result.intent, 'weather_query');
    assert.equal(result.entities[0].id, 'weather.home');
  });

  test('routes local time and date questions deterministically', () => {
    assert.equal(routeIntent('What time is it?').intent, 'time_query');
    assert.equal(routeIntent('What would the time be?').intent, 'time_query');
    assert.equal(routeIntent('Could you tell me the time?').intent, 'time_query');
    assert.equal(routeIntent("What's the date today?").intent, 'date_query');
    assert.equal(routeIntent('Tell me the day').intent, 'date_query');
  });

  test('routes "turn on the light" (ambiguous) with clarification needed', () => {
    const result = routeIntent('turn on the light');
    assert.equal(result.intent, 'light_set');
    assert.equal(result.clarification_needed, true);
    assert.equal(result.entities.length, 0);
  });

  test('routes "unlock the front door" with clarification needed (safety)', () => {
    const result = routeIntent('unlock the front door');
    assert.equal(result.intent, 'lock_set');
    assert.equal(result.clarification_needed, true);
  });

  test('routes "which lights are on right now" to device_query', () => {
    const result = routeIntent('which lights are on right now');
    assert.equal(result.intent, 'device_query');
  });

  test('routes "show me the dashboard for the kitchen" to navigation', () => {
    const result = routeIntent('show me the dashboard for the kitchen');
    assert.equal(result.intent, 'navigation');
  });

  test('routes "set the thermostat to 72 degrees" to climate_set', () => {
    const result = routeIntent('set the thermostat to 72 degrees');
    assert.equal(result.intent, 'climate_set');
    assert.equal(result.tool_calls[0].arguments.service_data.temperature, 72);
  });

  test('routes "pause the music in the living room" to media_pause', () => {
    const result = routeIntent('pause the music in the living room');
    assert.equal(result.intent, 'media_pause');
  });

  test('routes YouTube pause, resume, stop, and next controls', () => {
    assert.equal(routeIntent('Pause the YouTube video').intent, 'media_pause');
    assert.equal(routeIntent('Resume the video').intent, 'media_resume');
    assert.equal(routeIntent('Stop YouTube').intent, 'media_stop');
    assert.equal(routeIntent('Skip to the next YouTube video').intent, 'media_next');
  });

  test('routes playlist choice follow-ups without starting a new search', () => {
    const first = routeIntent('Play the first one');
    assert.equal(first.intent, 'media_select');
    assert.deepEqual(first.tool_calls[0].arguments, { position: 0 });
    assert.deepEqual(routeIntent('Choose option 2nd').tool_calls[0].arguments, { position: 1 });
    assert.deepEqual(routeIntent('Select the third playlist').tool_calls[0].arguments, { position: 2 });
    assert.deepEqual(routeIntent('Show me more playlists').tool_calls[0].arguments, { action: 'more' });
    assert.deepEqual(routeIntent('Cancel the selection').tool_calls[0].arguments, { action: 'cancel' });
  });

  test('routes "set the brightness to 200 percent" with clarification (out of range)', () => {
    const result = routeIntent('set the brightness to 200 percent');
    assert.equal(result.intent, 'light_set');
    assert.equal(result.clarification_needed, true);
    assert.ok(result.response.includes('out of range'));
  });

  test('routes "reboot the server" to unknown', () => {
    const result = routeIntent('reboot the server');
    assert.equal(result.intent, 'unknown');
    assert.equal(result.clarification_needed, true);
  });
});
